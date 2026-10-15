import { spawnSync } from 'node:child_process';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// This checks selected source files, never ambient runtime directories. Gitleaks
// independently scans generic secrets/history; literal owner rules stay local.
const forbiddenParts = /^(?:\.git|\.private|private|\.codex|\.agents|\.cache|\.pytest_cache|\.superpowers|\.worktrees|\.codebase-memory|\.playwright-mcp|\.impeccable|node_modules|dist|dist-client|coverage|storage|uploads|data|tmp|backups|artifacts|test-results|playwright-report|blob-report|traces|__pycache__)$/i;
const forbiddenFiles = /(?:\.(?:db|sqlite3?|dump|log|pyc|png|jpe?g|gif|webp|svg|ico|bmp|mp[34]|wav|flac|webm|mov|pdf|zip|gz|tar|exe|dll|so|node)$|^\.env(?:\..*)?$|^\.DS_Store$|^Thumbs\.db$)/i;
const credentialRules = [
  /\baf_[a-f0-9]{24}_[a-f0-9]{64}\b/gi,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16})\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\$argon2(?:id|i|d)\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]{16,}\$[A-Za-z0-9+/]{32,}/g,
  /(?:SESSION_SECRET|POSTGRES_PASSWORD|AGENTFILES_API_KEY)\s*[:=]\s*['"]?[a-f0-9]{32,}/gi,
  /postgres(?:ql)?:\/\/[^\s:'"/]+:(?!GENERATE_WITH_SETUP@)([A-Za-z0-9_-]{16,})@/gi,
];
const privatePath = /(?:[a-z]:[\\/]+(?:users|dev)[\\/]+[^\s'"`]+|\/(?:home|Users)\/[^\s'"`]+)/gi;

function options(args) {
  const result = { root: undefined, tracked: false, patterns: undefined };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key)) throw new Error('duplicate option');
    seen.add(key);
    if (key === '--tracked') result.tracked = true;
    else if (key === '--root' || key === '--private-patterns') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('missing option value');
      result[key === '--root' ? 'root' : 'patterns'] = value;
    } else throw new Error('unknown option');
  }
  if (!result.root && !result.tracked) throw new Error('explicit export root required');
  result.root = resolve(result.root ?? process.cwd());
  return result;
}

function inside(root, target) {
  const suffix = relative(root, target);
  return suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

async function scan({ root, tracked, patterns }) {
  const findings = [];
  const rules = patterns ? JSON.parse((await readFile(resolve(patterns), 'utf8')).replace(/^\uFEFF/, '')) : [];
  if (!Array.isArray(rules) || rules.some(rule => !rule || typeof rule.value !== 'string' || !rule.value || typeof rule.category !== 'string')) throw new Error('invalid private rules');
  const redactPath = name => {
    let safe = name.replace(privatePath, '[redacted]');
    for (const expression of credentialRules) safe = safe.replace(expression, '[redacted]');
    for (const { value } of rules) safe = safe.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[redacted]');
    return safe;
  };
  const finding = (category, path) => findings.push({ category, count: 1, path: redactPath(path) });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) throw new Error('redirected root');
  let checked = 0;
  const inspect = async (name, directory = false) => {
    const target = resolve(root, name);
    if (!inside(root, target)) throw new Error('outside export');
    const parts = name.split(/[\\/]/);
    const forbidden = parts.some(part => forbiddenParts.test(part)) || parts.some(part => part !== '.env.example' && forbiddenFiles.test(part));
    if (forbidden) { finding('forbidden-artifact', name); return; }
    // Check each ancestor before reading a tracked entry or walking a directory.
    let current = root;
    for (const part of parts) {
      current = resolve(current, part);
      if ((await lstat(current)).isSymbolicLink() || await realpath(current) !== current) { finding('redirected-path', name); return; }
    }
    const entry = await lstat(target);
    if (entry.isDirectory()) {
      if (!directory) { finding('unsupported-artifact', name); return; }
      for (const child of (await readdir(target)).sort()) await inspect(`${name}/${child}`, true);
      return;
    }
    if (!entry.isFile() || entry.size > 16 * 1024 * 1024) { finding('unsupported-artifact', name); return; }
    checked++;
    let content;
    try {
      const bytes = await readFile(target);
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      // Text sources allow tab/LF/CR, but no other C0, DEL or C1 controls.
      // Check decoded code points so normal UTF-8 continuation bytes stay valid.
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(content)) throw new Error('binary');
    } catch { finding('binary-artifact', name); return; }
    const source = `${name}\n${content}`;
    if (credentialRules.some(expression => { expression.lastIndex = 0; return expression.test(source); })) finding('credential', name);
    privatePath.lastIndex = 0;
    if (privatePath.test(content)) finding('private-path', name);
    if (rules.some(({ value }) => source.toLowerCase().includes(value.toLowerCase()))) finding('private-identifier', name);
  };
  if (tracked) {
    const git = args => {
      const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      if (result.status !== 0) throw new Error('tracked enumeration failed');
      return result.stdout;
    };
    if (resolve(git(['rev-parse', '--show-toplevel']).trim()) !== root) throw new Error('tracked root must be repository root');
    const entries = git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean);
    if (!entries.length) throw new Error('empty tracked export');
    for (const entry of entries) {
      const match = /^(\d+) [a-f0-9]+ (\d)\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error('invalid tracked entry');
      const [, mode, stage, name] = match;
      if (stage !== '0' || !['100644', '100755'].includes(mode)) finding('unsupported-artifact', name);
      else await inspect(name);
    }
  } else {
    const entries = (await readdir(root)).sort();
    if (!entries.length) throw new Error('empty export');
    for (const name of entries) await inspect(name, true);
  }
  return { checked, findings, count: findings.length };
}

try {
  const report = await scan(options(process.argv.slice(2)));
  console.log(JSON.stringify(report));
  process.exitCode = report.count ? 1 : 0;
} catch {
  // Never echo exception messages: OS paths and parser input can be private.
  console.error(JSON.stringify({ count: 1, findings: [{ category: 'scan-failure', count: 1, path: '[export]' }] }));
  process.exitCode = 1;
}
