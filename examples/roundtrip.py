#!/usr/bin/env python3
"""Source-derived HTTP example; application runtime verification is pending D1."""

import argparse
import hashlib
from http.client import HTTPException
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

CHUNK = 64 * 1024
JSON_LIMIT = 1024 * 1024
MAX_FILE_BYTES = 1024 * 1024 * 1024
PERMISSION_FIELDS = {
    'can_upload': 'canUpload', 'can_download': 'canDownload', 'can_list': 'canList',
    'can_delete': 'canDelete', 'can_mark_durable': 'canMarkDurable', 'can_share': 'canShare',
}


def url_parts(value):
    if not isinstance(value, str) or value != value.strip() or re.search(r'[\x00-\x20\x7f\\]', value):
        raise ValueError('URL contains whitespace or unsafe characters')
    parts = urlsplit(value)
    if parts.scheme.lower() not in ('http', 'https') or not parts.hostname:
        raise ValueError('URL must use HTTP or HTTPS with a hostname')
    if parts.username is not None or parts.password is not None or parts.query or parts.fragment:
        raise ValueError('URL must not contain credentials, a query, or a fragment')
    host = parts.hostname.lower()
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', host) or any(
            not label or len(label) > 63 or label.startswith('-') or label.endswith('-')
            for label in host.split('.')
        ):
            raise ValueError('Invalid hostname')
        address = None
    port = parts.port
    if port is not None and not 1 <= port <= 65535:
        raise ValueError('Invalid port')
    if parts.scheme.lower() == 'http' and host != 'localhost' and not (address and address.is_loopback):
        raise ValueError('HTTP is allowed only on localhost or a loopback IP')
    return parts, host, port or (443 if parts.scheme.lower() == 'https' else 80)


def normalize_origin(value):
    parts, host, port = url_parts(value)
    if parts.path not in ('', '/'):
        raise ValueError('Base URL must be an origin without a path')
    scheme = parts.scheme.lower()
    host = '[' + host + ']' if ':' in host else host
    suffix = '' if port == (443 if scheme == 'https' else 80) else ':' + str(port)
    return scheme + '://' + host + suffix


def safe_filename(name):
    name = re.sub(r'[^A-Za-z0-9._-]', '_', str(name))[:100].strip('.')
    stem = name.split('.')[0].upper()
    if not name or stem in {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(1, 10)), *(f'LPT{i}' for i in range(1, 10))}:
        name = 'download.bin'
    return name


def handoff_summary(file):
    return {
        'name': file['name'], 'code': file['code'],
        'private_url': file['private_url'], 'expires_at': file['expires_at'],
        'sha256': file.get('sha256'),
    }


def validate_file(file):
    if not isinstance(file, dict) or any(not isinstance(file.get(name), str) for name in (
        'code', 'name', 'created_at', 'private_url', 'api_download_url',
    )):
        raise ValueError('Invalid File DTO')
    if not re.fullmatch(r'F-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+', file['code']):
        raise ValueError('Invalid file code')
    if 'expires_at' not in file or (file['expires_at'] is not None and not isinstance(file['expires_at'], str)):
        raise ValueError('Invalid file expiry')
    if type(file.get('size_bytes')) is not int or not 0 <= file['size_bytes'] <= MAX_FILE_BYTES:
        raise ValueError('Invalid file size')
    if type(file.get('durable')) is not bool:
        raise ValueError('Invalid persistence flag')
    if file.get('sha256') is not None and not re.fullmatch(r'[a-f0-9]{64}', str(file['sha256'])):
        raise ValueError('Invalid file checksum')
    return file


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


class Client:
    def __init__(self, origin, key):
        self.origin = normalize_origin(origin)
        if not key or re.search(r'[\x00-\x20\x7f]', key) or len(key) > 1024:
            raise ValueError('API key is missing or contains unsafe header characters')
        self.key = key
        # Direct connections avoid ambient proxy settings; TLS uses stdlib verification.
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def check_url(self, url):
        parts, host, port = url_parts(url)
        expected, expected_host, expected_port = url_parts(self.origin)
        if (parts.scheme.lower(), host, port) != (expected.scheme.lower(), expected_host, expected_port):
            raise ValueError('Refusing a URL outside the configured origin')
        if not parts.path.startswith('/') or parts.path.startswith('//'):
            raise ValueError('Invalid request path')
        return url

    def check_file_urls(self, file):
        code = quote(file['code'], safe='')
        for field, expected_path in (
            ('private_url', '/files/' + code),
            ('api_download_url', '/api/files/' + code + '/download'),
        ):
            self.check_url(file[field])
            if urlsplit(file[field]).path != expected_path:
                raise ValueError('Returned file URL does not match its code')

    def open(self, method, path, data=None, headers=None, upload=False):
        url = self.check_url(path if '://' in path else self.origin + path)
        request = Request(url, data=data, method=method, headers={
            'Authorization': 'Bearer ' + self.key,
            'Accept': 'application/json', **(headers or {}),
        })
        try:
            response = self.opener.open(request, timeout=30)
            if not 200 <= response.status < 300:
                response.close()
                raise RuntimeError('Unexpected HTTP response')
            return response
        except HTTPError as error:
            status = error.code
            retry = error.headers.get('Retry-After', '')
            error.close()
            guidance = {
                401: 'Stop: credentials are invalid or revoked.',
                403: 'Stop: this operation is not permitted.',
                404: 'File is missing or has been removed.',
                410: 'File or share has expired or is unavailable.',
                413: 'Reduce file size or ask the operator to review upload settings.',
                429: 'Wait before a new attempt; do not retry an uncertain upload.',
                507: 'Capacity rejection is planned; ask the operator to free capacity.',
            }.get(status, 'Inspect the instance before attempting the operation again.')
            if 300 <= status < 400:
                guidance = 'Redirect rejected; credentials were not forwarded.'
            if status == 429 and re.fullmatch(r'[\x20-\x7e]{1,100}', retry):
                guidance += ' Retry-After: ' + retry
            if upload and status >= 500:
                guidance += ' Upload outcome may be unknown; do not repeat POST without reconciliation.'
            raise RuntimeError(f'HTTP {status}. {guidance}') from None
        except (URLError, TimeoutError, OSError):
            message = 'Network request failed.'
            if upload:
                message += ' Upload outcome is unknown: do not repeat POST. Reconcile with authorized metadata/list access.'
            raise RuntimeError(message) from None

    def json(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        headers = {} if body is None else {'Content-Type': 'application/json'}
        with self.open(method, path, data, headers) as response:
            payload = response.read(JSON_LIMIT + 1)
        if len(payload) > JSON_LIMIT:
            raise ValueError('JSON response is too large')
        return json.loads(payload) if payload else None

    def require_permissions(self, *names):
        session = self.json('GET', '/api/auth/session')
        if not isinstance(session, dict):
            raise ValueError('Invalid session response')
        if session.get('authenticated') is not True:
            raise RuntimeError('Session check failed: HTTP 200 does not mean authenticated')
        principal = session.get('principal') or {}
        if not isinstance(principal, dict):
            raise ValueError('Invalid session principal')
        if principal.get('type') != 'api_key' or any(principal.get(PERMISSION_FIELDS[name]) is not True for name in names):
            raise RuntimeError('API key lacks required permissions: ' + ', '.join(names))

    def upload(self, source, persist=False):
        boundary = 'agentfiles-' + secrets.token_hex(16)
        name = safe_filename(source.name)
        preamble = (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
            'Content-Type: application/octet-stream\r\n\r\n'
        ).encode()
        ending = f'\r\n--{boundary}--\r\n'.encode()
        if persist:
            ending = (
                f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="durable"\r\n\r\n'
                f'true\r\n--{boundary}--\r\n'
            ).encode()
        digest = hashlib.sha256()
        with source.open('rb') as stream:
            info = os.fstat(stream.fileno())
            size = info.st_size
            if not stat.S_ISREG(info.st_mode) or size > MAX_FILE_BYTES:
                raise ValueError('Input must be a regular file no larger than 1 GiB')

            def chunks():
                yield preamble
                count = 0
                while chunk := stream.read(CHUNK):
                    count += len(chunk)
                    if count > size:
                        raise ValueError('Source changed during upload')
                    digest.update(chunk)
                    yield chunk
                if count != size:
                    raise ValueError('Source changed during upload')
                yield ending

            with self.open('POST', '/api/files', chunks(), {
                'Content-Type': 'multipart/form-data; boundary=' + boundary,
                'Content-Length': str(len(preamble) + size + len(ending)),
            }, upload=True) as response:
                payload = response.read(JSON_LIMIT + 1)
        if len(payload) > JSON_LIMIT:
            raise ValueError('Upload response too large; do not repeat POST')
        file = validate_file(json.loads(payload))
        if persist and file.get('durable') is not True:
            raise RuntimeError('Persistence was not applied; inspect the uploaded file before further action')
        if file.get('sha256') and file['sha256'] != digest.hexdigest():
            raise ValueError('Upload checksum mismatch; do not repeat POST')
        return file, digest.hexdigest()

    def download(self, url, destination, expected_sha256, expected_size=None):
        self.check_url(url)
        if expected_size is not None and (type(expected_size) is not int or not 0 <= expected_size <= MAX_FILE_BYTES):
            raise ValueError('Invalid download size')
        digest = hashlib.sha256()
        # Exclusive creation refuses existing files and symlinks. The caller owns the directory.
        with destination.open('xb') as output:
            try:
                with self.open('GET', url) as response:
                    count = 0
                    while chunk := response.read(CHUNK):
                        count += len(chunk)
                        if count > (MAX_FILE_BYTES if expected_size is None else expected_size):
                            raise ValueError('Download exceeds expected size')
                        digest.update(chunk)
                        output.write(chunk)
                if expected_size is not None and count != expected_size:
                    raise ValueError('Download size mismatch')
                actual = digest.hexdigest()
                if expected_sha256 and actual != expected_sha256:
                    raise ValueError('Download checksum mismatch')
                return actual
            except BaseException:
                output.close()
                destination.unlink(missing_ok=True)
                raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', nargs='?', type=Path, help='file to upload; omitted creates synthetic text')
    parser.add_argument('--output-dir', type=Path, default=Path.cwd(), help='parent for a new private download directory')
    parser.add_argument('--persist', action='store_true', help='explicitly request persistent storage')
    parser.add_argument('--share-expires-at', help='explicitly create a public share with an ISO 8601 expiry')
    parser.add_argument('--share-max-downloads', type=int)
    parser.add_argument('--revoke-share', action='store_true', help='explicitly revoke the newly created share')
    parser.add_argument('--delete', action='store_true', help='explicitly delete the uploaded remote file after verification')
    args = parser.parse_args()
    if args.share_max_downloads is not None and (not args.share_expires_at or args.share_max_downloads < 1):
        parser.error('--share-max-downloads requires an expiry and a positive count')
    if args.revoke_share and not args.share_expires_at:
        parser.error('--revoke-share requires --share-expires-at')
    client = Client(os.environ.get('AGENTFILES_BASE_URL', ''), os.environ.get('AGENTFILES_API_KEY', ''))
    required = ['can_upload', 'can_download']
    if args.persist:
        required.append('can_mark_durable')
    if args.share_expires_at:
        required.append('can_share')
    if args.delete:
        required.append('can_delete')
    client.require_permissions(*required)
    with tempfile.TemporaryDirectory(prefix='agentfiles-input-') as temporary:
        source = args.file
        if source is None:
            source = Path(temporary) / 'synthetic.txt'
            source.write_bytes(b'AgentFiles synthetic round trip\n')
        try:
            file, uploaded_sha256 = client.upload(source, args.persist)
        except (ValueError, OSError, HTTPException):
            raise RuntimeError('Upload response could not be verified. Do not repeat POST; reconcile its unknown outcome.') from None
    client.check_file_urls(file)
    # Record the confirmed upload before later operations can fail.
    print(json.dumps({'uploaded': handoff_summary(file)}, ensure_ascii=True), flush=True)
    code_path = '/api/files/' + quote(file['code'], safe='')
    metadata = validate_file(client.json('GET', code_path))
    if metadata['code'] != file['code'] or metadata['created_at'] != file['created_at']:
        raise ValueError('Metadata does not match this upload')
    if metadata.get('sha256') and metadata['sha256'] != uploaded_sha256:
        raise ValueError('Metadata checksum mismatch')
    client.check_file_urls(metadata)
    directory = Path(tempfile.mkdtemp(prefix='agentfiles-download-', dir=args.output_dir))
    destination = directory / safe_filename(metadata['name'])
    downloaded_sha256 = client.download(metadata['api_download_url'], destination, uploaded_sha256, metadata['size_bytes'])
    result = {**handoff_summary(metadata), 'downloaded_to': str(destination.resolve()), 'verified_sha256': downloaded_sha256}
    if args.share_expires_at:
        body = {'expires_at': args.share_expires_at}
        if args.share_max_downloads is not None:
            body['max_downloads'] = args.share_max_downloads
        share = client.json('POST', code_path + '/share', body)
        if not isinstance(share, dict) or not isinstance(share.get('id'), str) or not isinstance(share.get('public_url'), str):
            raise ValueError('Invalid share response')
        client.check_url(share['public_url'])
        result['share'] = share
        if args.revoke_share:
            revoked = client.json('DELETE', '/api/share-links/' + quote(str(share['id']), safe=''))
            if not isinstance(revoked, dict) or revoked.get('revoked') is not True:
                raise ValueError('Share revocation was not confirmed')
            result['share_revoked'] = True
    if args.delete:
        deleted = client.json('DELETE', code_path)
        if not isinstance(deleted, dict) or deleted.get('deleted') is not True:
            raise ValueError('File deletion was not confirmed')
        result['remote_deleted'] = True
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not print URLs, keys, server bodies, or raw transport exceptions.
        print('AgentFiles example failed: ' + (str(error) if isinstance(error, RuntimeError) else 'Invalid configuration/response or local I/O failure.'), file=sys.stderr)
        sys.exit(1)
