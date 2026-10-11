import { runComposeSmoke } from './smoke-compose.mjs';

// No operator target/path arguments: creates fresh random owned projects and
// synthetic snapshots, then destroys only those registered disposable fixtures.
if (process.argv.length !== 2) {
  console.error('Restore smoke accepts no existing installation target.');
  process.exitCode = 1;
} else {
  await runComposeSmoke(['--operations']).catch(() => {
    console.error('Restore smoke failed; inspect bounded private owned-fixture diagnostics.');
    process.exitCode = 1;
  });
}
