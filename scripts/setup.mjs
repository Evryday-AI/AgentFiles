import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import argon2 from 'argon2';
import { createSetupFile } from './setup-lib.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--directory' || !args[1])) throw new Error('Unsupported setup arguments');
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') throw new Error('Setup requires an interactive terminal');
  const directory = resolve(args[1] ?? process.cwd());
  const wasRaw = process.stdin.isRaw;
  let pending = '', lines = [], waiting, cancelled = false;
  const fail = () => {
    cancelled = true;
    if (waiting) { const { reject } = waiting; waiting = undefined; reject(new Error('Setup cancelled')); }
  };
  const receive = (data) => {
    for (const character of data) {
      if (character === '\x03' || character === '\x04') { fail(); return; }
      if (character === '\r' || character === '\n') {
        if (character === '\n' && receive.lastCR) { receive.lastCR = false; continue; }
        receive.lastCR = character === '\r';
        const line = pending; pending = '';
        if (waiting) { const { resolve } = waiting; waiting = undefined; resolve(line); } else lines.push(line);
      } else {
        receive.lastCR = false;
        if (character === '\x7f' || character === '\b') pending = [...pending].slice(0, -1).join('');
        else if (character >= ' ' && Buffer.byteLength(pending) < 4096 && lines.length < 8) pending += character;
      }
    }
  };
  const restore = () => { process.stdin.setRawMode(wasRaw); process.stdin.pause(); };
  const prompt = async (label) => {
    process.stdout.write(label);
    if (cancelled) throw new Error('Setup cancelled');
    const value = lines.length ? lines.shift() : await new Promise((resolve, reject) => { waiting = { resolve, reject }; });
    // A data packet can resolve the line and then cancel before this resumes.
    if (cancelled) throw new Error('Setup cancelled');
    process.stdout.write('\n'); return value;
  };
  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode(true);
  process.stdin.on('data', receive);
  process.stdin.on('end', fail);
  process.stdin.on('error', fail);
  process.once('exit', restore);
  process.stdin.resume();
  let input;
  try {
    const mode = await prompt('Deployment mode [local]: ') || 'local';
    const origin = await prompt(mode === 'local' ? 'Public origin [http://localhost:3000]: ' : 'Public HTTPS origin: ') || (mode === 'local' ? 'http://localhost:3000' : '');
    const adminName = await prompt('Administrator name [admin]: ') || 'admin';
    const password = await prompt('Administrator password (hidden, at least 12 characters): ');
    const confirmation = await prompt('Confirm password (hidden): ');
    input = { mode, origin, adminName, password, confirmation };
  } finally {
    restore();
    process.removeListener('exit', restore);
    process.stdin.removeListener('data', receive);
    process.stdin.removeListener('end', fail);
    process.stdin.removeListener('error', fail);
  }
  if (cancelled) throw new Error('Setup cancelled');
  await createSetupFile({ directory, input, hashPassword: password => argon2.hash(password, { type: argon2.argon2id }), randomBytes });
  process.stdout.write('Created .env in the selected setup directory.\n');
}

main().catch(error => {
  // Only fixed application messages reach the terminal; filesystem, Argon2 and
  // unexpected dependency errors can contain paths or credentials.
  const safe = /^(Invalid setup |Setup configuration already exists$|Unable to (prepare|write) setup configuration$|Setup cancelled$|Setup requires an interactive terminal$|Unsupported setup arguments$)/;
  process.stderr.write(`${safe.test(error.message) ? error.message : 'Setup failed'}\n`);
  process.exitCode = 1;
});
