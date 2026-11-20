// Writes docs/openapi-v2.json, the public API's document (the /v2 routes only). The TypeScript
// SDK (packages/sdk) is generated from it; CI fails if either is stale.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { v2OpenApiDocument } from '../src/v2/docs';

const target = fileURLToPath(new URL('../../../docs/openapi-v2.json', import.meta.url));
writeFileSync(target, `${JSON.stringify(v2OpenApiDocument(), null, 2)}\n`);
console.log(`wrote ${target}`);
