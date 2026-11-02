/**
 * Regenerates src/generated.ts from the API's OpenAPI document (built from the server's route
 * definitions, no server needed). Run: `npm run generate -w @inkwright/sdk`. A test fails when the
 * committed file is out of date.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeApi } from '../../../apps/mcp-server/src/api/index.ts';
import { generateSdk } from './codegen.ts';

const target = fileURLToPath(new URL('../src/generated.ts', import.meta.url));
writeFileSync(target, generateSdk(describeApi()));
process.stdout.write(`Wrote ${target}\n`);
