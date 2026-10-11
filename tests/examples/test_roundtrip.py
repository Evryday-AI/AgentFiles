import importlib.util
import contextlib
import hashlib
import io
import json
import os
import pathlib
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('roundtrip', ROOT / 'examples/roundtrip.py')
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


class ClientSafety(unittest.TestCase):
    def test_origins(self):
        self.assertEqual(client.normalize_origin('HTTP://localhost:8080/'), 'http://localhost:8080')
        self.assertEqual(client.normalize_origin('https://files.example.com:443'), 'https://files.example.com')
        for bad in ['http://files.example.com', 'https://user@files.example.com',
                    'https://files.example.com/path', 'https://files.example.com?q=x',
                    'https://files.example.com#x', ' https://files.example.com',
                    'https://files.example.com\\evil', 'https://files.example.com:0']:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                client.normalize_origin(bad)

    def test_download_origin(self):
        c = client.Client('http://127.0.0.1:8080', 'synthetic-key')
        c.check_url('http://127.0.0.1:8080/api/files/F-TEST/download')
        for bad in ['http://127.0.0.1:8081/api/files/F-TEST/download',
                    'http://user@127.0.0.1:8080/x', 'http://127.0.0.1:8080/x#token']:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                c.check_url(bad)

    def test_secret_header_injection(self):
        for key in ['', 'test\r\nX-Test: injected', 'test\x00key']:
            with self.subTest(key=repr(key)), self.assertRaises(ValueError):
                client.Client('http://localhost:8080', key)

    def test_safe_filename(self):
        for bad in ['../../name.txt', '..', 'CON', 'NUL.txt', 'evil\nname', 'a\\b.txt']:
            name = client.safe_filename(bad)
            self.assertNotIn('/', name)
            self.assertNotIn('\\', name)
            self.assertNotIn('\n', name)
            self.assertNotEqual(name, '..')
            self.assertFalse(name.split('.')[0].upper() in {'CON', 'NUL'})

    def test_exclusive_download(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'existing.bin'
            path.write_bytes(b'original')
            c = client.Client('http://localhost:8080', 'synthetic-key')
            with self.assertRaises(FileExistsError):
                c.download('http://localhost:8080/api/files/F-TEST/download', path, None)
            self.assertEqual(path.read_bytes(), b'original')


class MockHTTP(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.content = b'AgentFiles synthetic round trip\n'
        self.mode = 'normal'
        self.upload_received = threading.Event()
        self.release_upload = threading.Event()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def respond(self, status, payload, **headers):
                data = json.dumps(payload).encode() if isinstance(payload, (dict, list)) else payload
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name.replace('_', '-'), value)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # Expected when the bounded client rejects the body.

            def record(self):
                owner.requests.append((self.command, self.path, self.headers.get('Authorization'), self.headers.get('Cookie')))

            def do_GET(self):
                self.record()
                if self.path == '/api/auth/session':
                    if owner.mode == 'invalid':
                        self.respond(200, {'authenticated': False, 'principal': None})
                    elif owner.mode == 'bad_session':
                        self.respond(200, ['untrusted scalar/list response'])
                    elif owner.mode == 'bad_principal':
                        self.respond(200, {'authenticated': True, 'principal': ['untrusted']})
                    elif owner.mode == 'redirect':
                        self.respond(302, b'', Location=getattr(owner, 'redirect_target', owner.origin + '/redirect-target'))
                    elif owner.mode == 'oversize_session':
                        self.respond(200, b'x' * (2 * 1024 * 1024))
                    elif owner.mode == 'cross_redirect':
                        self.respond(302, b'', Location='http://127.0.0.1:1/should-not-contact')
                    elif owner.mode == 'rate':
                        self.respond(429, {}, Retry_After='5')
                    else:
                        principal = {'type': 'api_key', **{name: True for name in client.PERMISSION_FIELDS.values()}}
                        if owner.mode == 'denied':
                            principal['canUpload'] = False
                        self.respond(200, {'authenticated': True, 'principal': principal})
                elif self.path.endswith('/download') or self.path.startswith('/s/'):
                    self.respond(200, b'corrupt' if owner.mode == 'corrupt' else owner.content)
                else:
                    self.respond(200, owner.dto())

            def do_POST(self):
                self.record()
                data = self.rfile.read(int(self.headers['Content-Length']))
                if self.path == '/api/files':
                    owner.upload_bytes = data
                    owner.upload_length = int(self.headers['Content-Length'])
                    owner.upload_received.set()
                    if owner.mode == 'disconnect_upload':
                        self.close_connection = True
                    elif owner.mode == 'timeout_upload':
                        owner.release_upload.wait(2)
                        self.close_connection = True
                    elif owner.mode == 'bad_upload':
                        self.respond(201, ['untrusted'])
                    else:
                        self.respond(201, owner.dto())
                else:
                    self.respond(201, {'id': '00000000-0000-4000-8000-000000000001', 'public_url': owner.origin + '/s/' + 't' * 43, 'expires_at': '2099-01-01T00:00:00Z'})

            def do_DELETE(self):
                self.record()
                self.respond(200, {'deleted': True, 'revoked': True})

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.origin = f'http://127.0.0.1:{self.server.server_port}'
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.c = client.Client(self.origin, 'synthetic-key')

    def tearDown(self):
        self.release_upload.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def dto(self):
        return {'code': 'F-TEST2', 'name': '../../CON.txt', 'created_at': '2026-10-10T00:00:00Z',
                'expires_at': '2099-01-01T00:00:00Z', 'durable': True,
                'size_bytes': len(self.content), 'sha256': hashlib.sha256(self.content).hexdigest(),
                'private_url': self.origin + '/files/F-TEST2',
                'api_download_url': ('http://127.0.0.1:1' if self.mode == 'cross_download' else self.origin) + '/api/files/F-TEST2/download'}

    def run_main(self, directory, *flags):
        with patch.dict(os.environ, {'AGENTFILES_BASE_URL': self.origin, 'AGENTFILES_API_KEY': 'synthetic-key'}), \
             patch('sys.argv', ['roundtrip.py', '--output-dir', directory, *flags]), contextlib.redirect_stdout(io.StringIO()) as stdout:
            client.main()
            return stdout.getvalue()

    def test_complete_synthetic_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            output = self.run_main(directory)
            self.assertIn('verified_sha256', output)
            downloads = list(pathlib.Path(directory).glob('agentfiles-download-*/*'))
            self.assertEqual(len(downloads), 1)
            self.assertEqual(downloads[0].read_bytes(), self.content)
            self.assertEqual([method for method, path, auth, cookie in self.requests], ['GET', 'POST', 'GET', 'GET'])
            self.assertTrue(all(auth == 'Bearer synthetic-key' and cookie is None for method, path, auth, cookie in self.requests))
            self.assertIn(self.content, self.upload_bytes)
            self.assertNotIn(b'name="durable"', self.upload_bytes)

    def test_explicit_mutations(self):
        with tempfile.TemporaryDirectory() as directory:
            output = self.run_main(directory, '--persist', '--share-expires-at', '2099-01-01T00:00:00Z', '--revoke-share', '--delete')
            self.assertIn('remote_deleted', output)
            self.assertIn('share_revoked', output)
            self.assertIn(b'name="durable"', self.upload_bytes)
            self.assertEqual(sum(method == 'POST' for method, *_ in self.requests), 2)
            self.assertEqual(sum(method == 'DELETE' for method, *_ in self.requests), 2)
            public_requests = [auth for method, path, auth, cookie in self.requests if path.startswith('/s/')]
            self.assertEqual(public_requests, [None])

    def test_streaming_upload_declares_exact_content_length(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / 'large.bin'
            source.write_bytes(b'x' * (client.CHUNK * 3 + 7))
            self.content = source.read_bytes()
            file, digest = self.c.upload(source)
            self.assertEqual(self.upload_length, len(self.upload_bytes))
            self.assertIn(self.content, self.upload_bytes)
            self.assertEqual(digest, hashlib.sha256(self.content).hexdigest())

    def test_ambiguous_upload_timeout_is_not_retried(self):
        self.mode = 'timeout_upload'
        c = client.Client(self.origin, 'synthetic-key', timeout=0.05)
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / 'hello.txt'
            source.write_bytes(self.content)
            with self.assertRaisesRegex(RuntimeError, 'outcome is unknown.*do not repeat POST'):
                c.upload(source)
        self.assertTrue(self.upload_received.is_set())
        self.assertEqual(sum(method == 'POST' for method, *_ in self.requests), 1)

    def test_redirect_to_second_server_receives_no_credential(self):
        received = []
        class Sink(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                received.append(self.headers.get('Authorization'))
                self.send_response(200); self.end_headers()
        sink = ThreadingHTTPServer(('127.0.0.1', 0), Sink)
        thread = threading.Thread(target=sink.serve_forever, daemon=True); thread.start()
        original = self.origin
        try:
            self.mode = 'redirect'
            self.origin = f'http://127.0.0.1:{sink.server_port}'
            with self.assertRaisesRegex(RuntimeError, 'Redirect rejected'):
                self.c.require_permissions('can_upload')
            self.assertEqual(received, [])
        finally:
            self.origin = original; sink.shutdown(); sink.server_close(); thread.join()

    def test_invalid_or_denied_session_stops_before_upload(self):
        for mode in ['invalid', 'denied']:
            self.mode = mode
            self.requests.clear()
            with tempfile.TemporaryDirectory() as directory, self.assertRaises(RuntimeError):
                self.run_main(directory)
            self.assertEqual(len(self.requests), 1)

    def test_redirects_not_followed(self):
        for mode in ['redirect', 'cross_redirect']:
            self.mode = mode
            self.requests.clear()
            with self.assertRaisesRegex(RuntimeError, 'Redirect rejected'):
                self.c.require_permissions('can_upload')
            self.assertEqual(len(self.requests), 1)

    def test_retry_after_no_retry(self):
        self.mode = 'rate'
        with self.assertRaisesRegex(RuntimeError, 'Retry-After: 5'):
            self.c.require_permissions('can_upload')
        self.assertEqual(len(self.requests), 1)

    def test_checksum_failure_removes_output(self):
        self.mode = 'corrupt'
        with tempfile.TemporaryDirectory() as directory:
            destination = pathlib.Path(directory) / 'safe.bin'
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                self.c.download(self.origin + '/api/files/F-TEST2/download', destination, self.dto()['sha256'])
            self.assertFalse(destination.exists())

    def test_size_bound_removes_output(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = pathlib.Path(directory) / 'safe.bin'
            with self.assertRaisesRegex(ValueError, 'exceeds expected size'):
                self.c.download(self.origin + '/api/files/F-TEST2/download', destination, None, 1)
            self.assertFalse(destination.exists())

    def test_malformed_session_and_principal_rejected(self):
        for mode in ['bad_session', 'bad_principal']:
            self.mode = mode
            self.requests.clear()
            with self.assertRaises(ValueError):
                self.c.require_permissions('can_upload')
            self.assertEqual(len(self.requests), 1)

    def test_ambiguous_upload_never_retried(self):
        for mode in ['disconnect_upload', 'bad_upload']:
            self.mode = mode
            self.requests.clear()
            with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(RuntimeError, '[Dd]o not repeat POST'):
                self.run_main(directory)
            self.assertEqual(sum(method == 'POST' for method, *_ in self.requests), 1)

    def test_cross_origin_download_is_not_requested(self):
        self.mode = 'cross_download'
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, 'configured origin'):
            self.run_main(directory)
        self.assertEqual(len(self.requests), 2)


if __name__ == '__main__':
    unittest.main()
