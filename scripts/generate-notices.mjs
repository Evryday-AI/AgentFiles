import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Reads installed package attribution only; never executes dependency code.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const supplements = JSON.parse(fs.readFileSync(path.join(root, 'docs/dependency-notice-supplements.json'), 'utf8'));
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const records = [];
const absent = [];
function attributionFiles(relative) {
  const found = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => order(a.name, b.name))) {
    if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${relative}/${entry.name}`);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git') found.push(...attributionFiles(`${relative}/${entry.name}`));
    } else if (entry.isFile() && /^(?:licen[cs]e|copying|copyright(?:notice)?|notice)(?:[._-].*)?$|third.?party.*(?:notice|licen[cs]e)|\.licen[cs]e$/i.test(entry.name)) {
      found.push(`${relative}/${entry.name}`);
    }
  }
  return found;
}
for (const [location, entry] of Object.entries(lock.packages).sort(([a], [b]) => order(a, b))) {
  if (!location) continue;
  const manifest = `${location}/package.json`;
  if (!fs.existsSync(path.join(root, manifest))) {
    if (!entry.optional) throw new Error(`Required package absent; run npm ci before regenerating: ${location}`);
    absent.push({ location, version: entry.version, optional: !!entry.optional, licenseMetadata: entry.license ?? null });
    continue;
  }
  if (fs.lstatSync(path.join(root, location)).isSymbolicLink()) throw new Error(`Refusing linked package: ${location}`);
  const pkg = JSON.parse(read(manifest));
  if (pkg.version !== entry.version) throw new Error(`Installed version differs from lock: ${location}`);
  const files = attributionFiles(location).map((file) => ({ file, text: read(file) }));
  // Platform esbuild packages ship the same software without a license file.
  // Use the installed, matching esbuild release's full upstream MIT notice.
  if (!files.length && (pkg.name.startsWith('@esbuild/') || pkg.name.startsWith('@rollup/rollup-'))) {
    const sharedName = pkg.name.startsWith('@esbuild/') ? 'esbuild' : 'rollup';
    const sharedLocation = location.slice(0, location.lastIndexOf('node_modules/')) + `node_modules/${sharedName}`;
    const shared = JSON.parse(read(`${sharedLocation}/package.json`));
    if (shared.version !== pkg.version) throw new Error(`Missing matching ${sharedName} notice: ${location}`);
    files.push({ file: `${sharedLocation}/LICENSE.md`, text: read(`${sharedLocation}/LICENSE.md`), shared: true });
  }
  if (pkg.name === 'pg-types' || pkg.name === 'pgpass') {
    const file = `${location}/README.md`;
    const text = read(file).split(/\n## license\n/i)[1];
    if (!text || !text.includes('Permission is hereby granted')) throw new Error(`README license needs review: ${location}`);
    files.push({ file: `${file} (license section)`, text });
  }
  if (pkg.name === 'stackback') {
    const file = `${location}/formatstack.js`;
    files.push({ file: `${file} (initial BSD notice)`, text: read(file).split('\n\n')[0] });
  }
  const supplement = supplements[`${pkg.name}@${pkg.version}`];
  if (supplement) files.push({ file: supplement.source, text: supplement.text });
  if (pkg.name === '@epic-web/invariant' || pkg.name === 'abstract-logging' || pkg.name === 'stackback') {
    files.push({ file: `${manifest} (upstream declaration; no complete MIT notice shipped)`,
      text: JSON.stringify({ name: pkg.name, version: pkg.version, author: pkg.author, license: pkg.license }, null, 2) });
  }
  records.push({ location, name: pkg.name, version: pkg.version, licenseMetadata: pkg.license ?? null,
    developmentOnly: !!entry.dev, optional: !!entry.optional, files });
}
const missing = records.filter((record) => !record.files.length);
if (!records.length) throw new Error('No installed packages; refusing to replace reviewed notices');
if (missing.length) throw new Error(`License text missing; inspect before regeneration: ${missing.map((r) => r.location).join(', ')}`);
let output = `# Third-party notices\n\nAgentFiles original source is licensed under MIT. Dependencies retain their own terms.\n\nThis installed-package attribution snapshot includes runtime, browser, native and development/build dependencies. It preserves the full shipped license and notice files, including bundled third-party notices. Package metadata is a label, not a substitute for these texts. It is not an assertion that every listed package is shipped in every artifact.\n\nGenerated from the public lockfile and installed packages with \`node scripts/generate-notices.mjs\`. Line endings and trailing whitespace are normalized; upstream notice content is otherwise preserved.\n\nPlatform snapshot: ${process.platform}/${process.arch}; ${records.length} installed package locations, ${absent.length} lockfile package locations absent and not inspected. See [dependency review](docs/dependencies.md) for scope, attribution and redistribution instructions. Regenerate and review on each distribution platform; retain any additional notices required by its actual artifacts.\n\n## Data and native attribution\n\n- caniuse-lite contains the Can I Use browser support dataset, authored by the Can I Use contributors, compressed by the caniuse-lite project (Ben Briggs and contributors). Sources: https://caniuse.com/ and https://github.com/browserslist/caniuse-lite. License: https://creativecommons.org/licenses/by/4.0/. AgentFiles makes no modifications to this installed dataset. Its complete CC BY 4.0 text is reproduced below.\n- The argon2 npm wrapper is MIT; its bundled Argon2 reference implementation is offered under CC0 1.0 or Apache 2.0. Both complete texts and the implementation's authors are preserved below. A separate embedded CC0 notice for Thomas Pornin's encoding implementation is also reproduced.\n- Platform esbuild and Rollup packages without a shipped license file use the full notice from the matching installed package; this is explicitly marked below.\n\n## Installed package inventory\n\n| Package | Version | Package license metadata | Dependency scope |\n|---|---|---|---|\n`;
for (const r of records) output += `| ${r.name} | ${r.version} | ${String(r.licenseMetadata).replaceAll('|', '\\|')} | ${r.developmentOnly ? 'development/build' : 'runtime graph'}${r.optional ? '; optional' : ''} |\n`;
output += '\n## License and notice texts\n';
for (const r of records) {
  output += `\n### ${r.name}@${r.version}\n\nInstalled location: \`${r.location}\`.\n`;
  for (const f of r.files) {
    const fence = '`'.repeat(Math.max(3, ...(f.text.match(/`+/g) ?? []).map((s) => s.length + 1)));
    output += `\nSource: \`${f.file}\`${f.shared ? ' (notice shared by the matching release)' : ''}.\n\n${fence}text\n${f.text.replace(/[ \t]+$/gm, String()).trimEnd()}\n${fence}\n`;
  }
}
const encoding = read('node_modules/argon2/argon2/src/encoding.c');
const comments = encoding.match(/\/\*[\s\S]*?\*\//g) ?? [];
const nativeNotices = comments.filter((comment) => /Copyright/.test(comment));
if (!nativeNotices.some((comment) => comment.includes('Thomas Pornin'))) throw new Error('Argon2 embedded CC0 notice needs review');
output += '\n### Argon2 embedded source copyright and CC0 notice\n\nSource: `node_modules/argon2/argon2/src/encoding.c` (copyright-bearing comments).\n\n```text\n' + nativeNotices.join('\n\n') + '\n```\n';
output += '\n## Lockfile entries not installed or inspected\n\nThese platform-specific/optional entries are listed for completeness only. Their metadata has not been treated as reviewed license text.\n\n| Lockfile location | Version | Optional |\n|---|---|---|\n';
for (const r of absent) output += `| ${r.location} | ${r.version} | ${r.optional ? 'yes' : 'no'} |\n`;
const target = path.join(root, 'THIRD_PARTY_NOTICES.md');
if (process.argv.includes('--check')) {
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== output) throw new Error('Notices differ; regenerate and review');
} else fs.writeFileSync(target, output);
console.log(JSON.stringify({ installedLocations: records.length, absentLocations: absent.length,
  noticeSections: records.reduce((n, r) => n + r.files.length, 0),
  licenseMetadataCounts: records.reduce((acc, r) => { acc[r.licenseMetadata] = (acc[r.licenseMetadata] ?? 0) + 1; return acc; }, {}),
  sha256: crypto.createHash('sha256').update(output).digest('hex') }, null, 2));
