"""Bash/curl/jq tests run explicitly in the owned Linux client fixture."""
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
import test_roundtrip as python_tests

@unittest.skipUnless(os.environ.get('AGENTFILES_SHELL_TESTS') == '1', 'Shell runtime checks require explicit Linux fixture tools')
class ShellHTTP(unittest.TestCase):
    setUp = python_tests.MockHTTP.setUp
    tearDown = python_tests.MockHTTP.tearDown
    dto = python_tests.MockHTTP.dto

    def run_shell(self, directory, key='synthetic-key', *args):
        env = {name: value for name, value in os.environ.items() if name in ('PATH', 'HOME', 'TMPDIR', 'LANG')}
        env.update(AGENTFILES_BASE_URL=self.origin, AGENTFILES_API_KEY=key)
        return subprocess.run(['bash', str(python_tests.ROOT / 'examples/upload.sh'), *args], cwd=directory,
                              env=env, capture_output=True, text=True, timeout=10)

    def test_complete_shell_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            r = self.run_shell(directory)
            self.assertEqual(r.returncode, 0, 'Shell roundtrip failed; diagnostics withheld')
            self.assertIn('verified_sha256', r.stdout)
            self.assertNotIn('synthetic-key', r.stdout + r.stderr)
            outputs = list(pathlib.Path(directory).glob('agentfiles-download.*/*'))
            self.assertEqual(len(outputs), 1); self.assertEqual(outputs[0].read_bytes(), self.content)
            self.assertTrue(all(auth == 'Bearer synthetic-key' and cookie is None for _, _, auth, cookie in self.requests))

    def test_bound_json_response(self):
        self.mode = 'oversize_session'
        with tempfile.TemporaryDirectory() as directory:
            r = self.run_shell(directory)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn('Network request failed', r.stderr)
        self.assertEqual(len(self.requests), 1)

    def test_strict_file_code_contract(self):
        original = self.dto
        def invalid():
            dto = original(); dto['code'] = 'F-IOOOO'; return dto
        self.dto = invalid
        with tempfile.TemporaryDirectory() as directory:
            r = self.run_shell(directory)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn('Unexpected code', r.stderr)

    def test_cross_origin_download_never_requested(self):
        self.mode = 'cross_download'
        with tempfile.TemporaryDirectory() as directory:
            r = self.run_shell(directory)
            self.assertNotEqual(r.returncode, 0)
        self.assertEqual(len(self.requests), 2)

    def test_checksum_failure_removes_partial_output(self):
        self.mode = 'corrupt'
        with tempfile.TemporaryDirectory() as directory:
            r = self.run_shell(directory)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn('checksum mismatch', r.stderr)
            self.assertEqual(list(pathlib.Path(directory).glob('agentfiles-download.*')), [])

    def test_existing_local_output_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            existing = pathlib.Path(directory) / 'agentfiles-download.existing'
            existing.mkdir(); destination = existing / 'download.bin'
            destination.write_bytes(b'original')
            r = self.run_shell(directory)
            self.assertEqual(r.returncode, 0, 'Exclusive output roundtrip failed')
            self.assertEqual(destination.read_bytes(), b'original')

    def test_redirect_to_second_server_receives_no_credential(self):
        received = []
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        import threading
        class Sink(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                received.append(self.headers.get('Authorization'))
                self.send_response(200); self.end_headers()
        sink = ThreadingHTTPServer(('127.0.0.1', 0), Sink)
        thread = threading.Thread(target=sink.serve_forever, daemon=True); thread.start()
        try:
            base = self.origin; self.origin = f'http://127.0.0.1:{sink.server_port}'
            self.mode = 'redirect'
            with tempfile.TemporaryDirectory() as directory:
                # Client uses original origin; mock returns the sink URL.
                os_origin = self.origin; self.origin = base
                self.redirect_target = os_origin + '/sink'
                r = self.run_shell(directory)
                self.assertIn('Redirect rejected', r.stderr)
            self.assertEqual(received, [])
        finally:
            sink.shutdown(); sink.server_close(); thread.join()

    def test_ambiguous_upload_is_not_retried(self):
        self.mode = 'disconnect_upload'
        with tempfile.TemporaryDirectory() as directory:
            r = self.run_shell(directory)
            self.assertNotEqual(r.returncode, 0); self.assertIn('outcome is unknown', r.stderr)
        self.assertEqual(sum(method == 'POST' for method, *_ in self.requests), 1)

    def test_key_config_escaping_and_newline_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            r = self.run_shell(directory, 'synthetic-"quoted\\key')
            self.assertEqual(r.returncode, 0, 'Escaped key roundtrip failed')
            self.assertTrue(all(auth == 'Bearer synthetic-"quoted\\key' for _, _, auth, _ in self.requests))
            self.requests.clear()
            r = self.run_shell(directory, 'synthetic\nkey')
            self.assertNotEqual(r.returncode, 0); self.assertEqual(self.requests, [])

    def test_explicit_share_anonymous_verification_revoke_delete(self):
        with tempfile.TemporaryDirectory() as directory:
            r = self.run_shell(directory, 'synthetic-key', '--share-expires-at', '2099-01-01T00:00:00Z', '--revoke-share', '--delete')
            self.assertEqual(r.returncode, 0, 'Explicit shell mutations failed')
            self.assertIn('anonymous_share_verified', r.stdout)
            self.assertEqual([auth for _, path, auth, _ in self.requests if path.startswith('/s/')], [None])
            self.assertEqual(sum(method == 'DELETE' for method, *_ in self.requests), 2)

if __name__ == '__main__': unittest.main()
