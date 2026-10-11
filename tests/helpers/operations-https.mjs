import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:https';
import { request as upstreamRequest } from 'node:http';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { isolatedEnvironment } from '../../scripts/smoke-compose.mjs';

export async function verifyLocalHttps({ directory, startRuntime, password, username }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const openssl = args => {
    const result = spawnSync('openssl', args, { cwd: directory, env: isolatedEnvironment(process.env), windowsHide: true, encoding: 'utf8' });
    assert.equal(result.status, 0, 'Local fixture OpenSSL command failed');
  };
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=AgentFiles synthetic CA']);
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=agentfiles.invalid']);
  await writeFile(resolve(directory, 'extensions.txt'), 'subjectAltName=DNS:agentfiles.invalid\nextendedKeyUsage=serverAuth\n', { mode: 0o600 });
  openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '1', '-extfile', 'extensions.txt']);
  const cert = await readFile(resolve(directory, 'server.pem'));
  const key = await readFile(resolve(directory, 'server.key'));
  const logs = [];
  let upstream;
  const proxy = createServer({ cert, key }, (incoming, outgoing) => {
    // Deliberately no raw URLs, headers, tokens, bodies or referrers in logs.
    const path = incoming.url.split('?')[0];
    const route = path.startsWith('/s/') ? '/s/:token' :
      /^\/api\/files(?:\/F-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5})?(?:\/(?:download|share))?$/.test(path) ? path.replace(/F-[A-Z0-9]+/g, ':code') :
      ['/','/api/auth/login','/api/auth/session','/api/instance'].includes(path) ? path : '[unmatched]';
    logs.push({ method: incoming.method, route });
    if (incoming.headers.host !== `agentfiles.invalid:${proxy.address().port}`) { outgoing.writeHead(400).end(); incoming.resume(); return; }
    let count = 0; const chunks = [];
    incoming.setTimeout(250, () => { outgoing.writeHead(408).end(); incoming.destroy(); });
    incoming.on('data', chunk => { count += chunk.length; if (count > 2048) { outgoing.writeHead(413).end(); incoming.destroy(); } else chunks.push(chunk); });
    incoming.on('end', () => {
      if (outgoing.writableEnded) return;
      const headers = { ...incoming.headers, host: incoming.headers.host, 'x-forwarded-proto': 'https', 'x-forwarded-host': incoming.headers.host, 'x-forwarded-for': '127.0.0.1' };
      const target = upstreamRequest(`${upstream}${incoming.url}`, { method: incoming.method, headers }, response => { outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing); });
      target.on('error', () => { if (!outgoing.writableEnded) outgoing.writeHead(502).end(); }); target.end(Buffer.concat(chunks));
    });
  });
  await new Promise(done => proxy.listen(0, '127.0.0.1', done));
  const port = proxy.address().port;
  const origin = `https://agentfiles.invalid:${port}`;
  const runtime = await startRuntime(origin); upstream = runtime.base;
  const spki = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const browser = await chromium.launch({ env: isolatedEnvironment(process.env), args: ['--no-proxy-server', '--host-resolver-rules=MAP agentfiles.invalid 127.0.0.1', `--ignore-certificate-errors-spki-list=${spki}`] });
  try {
    const context = await browser.newContext(); const page = await context.newPage();
    await page.goto(origin);
    const login = await page.evaluate(async ({ password, username }) => {
      const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'http', 'x-forwarded-for': '198.51.100.10' }, body: JSON.stringify({ username, password }) }); return response.status;
    }, { password, username });
    assert.equal(login, 200);
    const cookies = await context.cookies(); const admin = cookies.find(cookie => cookie.name === 'agentfiles_admin');
    assert(admin?.secure && admin.httpOnly && admin.sameSite === 'Lax');
    const session = await page.evaluate(async () => (await (await fetch('/api/auth/session')).json()).authenticated); assert.equal(session, true);
    const statuses = await page.evaluate(async () => {
      const upload = async text => { const form=new FormData();form.set('file',new Blob([text]),'synthetic.txt');return (await fetch('/api/files',{method:'POST',body:form})).status; };
      return [await upload('within-cap'), await upload('x'.repeat(1025)), await upload('x'.repeat(4096))];
    });
    assert.deepEqual(statuses, [201, 413, 413]);
    const ca = await readFile(resolve(directory, 'ca.pem'));
    const timeout = await new Promise((done, reject) => {
      const req = request({ hostname: '127.0.0.1', port, servername: 'agentfiles.invalid', ca, method:'POST', path:'/api/files', headers:{host:`agentfiles.invalid:${port}`,'content-length':'1000'} });
      req.on('response', response => { response.resume(); done(response.statusCode); }); req.on('error', reject); req.write('partial');
    });
    assert.equal(timeout, 408);
    await page.goto(`${origin}/s/synthetic-opaque-fixture-token?secret=synthetic-opaque-fixture-token`);
    assert(!JSON.stringify(logs).includes('synthetic-opaque-fixture-token'));
    assert(!JSON.stringify(logs).includes(password));
    await writeFile(resolve(directory, 'proxy-safe-log.json'), JSON.stringify(logs), { mode: 0o600 });
    return { browser: browser.version(), tls: 'local CA; browser trusts only leaf SPKI; hostname verified Node client', results: 'Secure cookie; app/proxy caps; proxy idle408; spoofed headers overwritten; template-only logs' };
  } finally { await browser.close(); proxy.closeAllConnections(); await new Promise(done => proxy.close(done)); }
}
