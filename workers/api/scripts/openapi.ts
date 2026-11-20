// Writes docs/openapi.json from the route schemas. CI fails if the committed file is stale.
// Also writes docs/app-manifest.schema.json (the App Directory manifest; a domain test checks it).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appManifestJsonSchema } from '@swarm/domain';
import { createApp, openApiDocument } from '../src/app';

const target = fileURLToPath(new URL('../../../docs/openapi.json', import.meta.url));
writeFileSync(target, `${JSON.stringify(openApiDocument(createApp()), null, 2)}\n`);
console.log(`wrote ${target}`);

const manifest = fileURLToPath(new URL('../../../docs/app-manifest.schema.json', import.meta.url));
writeFileSync(manifest, `${JSON.stringify(appManifestJsonSchema(), null, 2)}\n`);
console.log(`wrote ${manifest}`);
