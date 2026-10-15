// Disposable subprocess harness. Imports the built production runtime; barriers
// wrap existing dependency seams and are never reachable from application HTTP.
import { buildServer, registerShutdownSignals } from '../../dist/server/index.js';
import { createDatabase } from '../../dist/server/db.js';
import * as storage from '../../dist/server/storage.js';
import { createFileRecord, findExpiredBatch } from '../../dist/server/filesRepo.js';
import { cleanupExpiredFiles } from '../../dist/server/cleanup.js';

let server, db, config, release;
let paused = false;
const candidates = new Map();
const barrier = async (boundary, key) => {
  if (paused) return;
  paused = true;
  process.send({ boundary, key });
  await new Promise(done => { release = done; });
};
process.on('message', async message => {
  if (message.command === 'release') { release?.(); return; }
  try {
    let value;
    if (message.command === 'start') {
      config = { ...message.config, ...(message.issuanceEnabled === false ? { issuanceEnabled: false } : {}) };
      db = createDatabase(config.databaseUrl);
      const files = { storage: {}, repo: {} };
      if (message.mode === 'upload-temp') files.storage.stageUpload = async input => { const staged = await storage.stageUpload(input); await barrier(message.mode, staged.tempKey); return staged; };
      if (message.mode === 'upload-final') files.storage.finalizeUpload = async (...args) => { const final = await storage.finalizeUpload(...args); await barrier(message.mode, final.storageKey); return final; };
      if (message.mode === 'delete-claimed') files.storage.deleteStoredFile = async (...args) => { await barrier(message.mode, args[1]); await storage.deleteStoredFile(...args); };
      if (message.mode === 'delete-unlinked') files.storage.deleteStoredFile = async (...args) => { await storage.deleteStoredFile(...args); await barrier(message.mode, args[1]); };
      if (message.mode === 'enospc') files.storage.finalizeUpload = async () => { throw Object.assign(new Error('Synthetic disk write failure'), { code: 'ENOSPC' }); };
      if (message.collision) {
        let first = true;
        files.repo.createFileRecord = (input, client) => createFileRecord(input, client, { generateCode: () => { if (first) { first = false; return message.collision; } return 'F-ZZZZZ'; } });
      }
      server = buildServer(config, { db, files });
      registerShutdownSignals(server, db);
      await server.listen({ host: '127.0.0.1', port: 0 });
      value = { base: `http://127.0.0.1:${server.server.address().port}` };
    } else if (message.command === 'maintenance') value = await server.maintenance.run();
    else if (message.command === 'capacity') value = server.uploadRuntime.admission.snapshot();
    else if (message.command === 'capture-expiry') {
      const rows = await findExpiredBatch({ now: new Date(Date.now() + 8 * 86400000), limit: 100 }, db);
      const candidate = rows.find(row => row.code === message.code);
      if (!candidate) throw new Error('Expected selected expiry candidate');
      candidates.set(message.code, candidate); value = true;
    }
    else if (message.command === 'stale-cleanup') {
      const candidate = candidates.get(message.code); if (!candidate) throw new Error('Missing selected candidate');
      value = await cleanupExpiredFiles({ storageRoot: config.storageRoot, db, now: new Date(Date.now() + 8 * 86400000), repo: { findExpiredFiles: async () => [candidate] } });
    }
    else throw new Error('Unknown fixture operation');
    process.send({ id: message.id, value });
  } catch { process.send({ id: message.id, error: true }); }
});
