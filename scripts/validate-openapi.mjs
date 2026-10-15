import SwaggerParser from '@apidevtools/swagger-parser';
import { fileURLToPath } from 'node:url';
// No external references: validation must not fetch arbitrary URLs/files.
try {
  const api = await SwaggerParser.validate(fileURLToPath(new URL('../openapi.yaml', import.meta.url)), { resolve: { external: false } });
  const ids = Object.values(api.paths).flatMap(path => Object.entries(path)
    .filter(([method]) => ['get', 'post', 'patch', 'delete'].includes(method))
    .map(([, operation]) => operation.operationId));
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error();
  console.log(`OpenAPI 3.1 valid: ${ids.length} uniquely identified operations; external resolution disabled.`);
} catch {
  console.error('OpenAPI validation failed; inspect the local contract and operation IDs.');
  process.exitCode = 1;
}
