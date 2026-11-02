// Validates manifest.json with the same rules Inkwright applies when installing, and checks that
// the entry file exists and is an ES module with a default export. Run: npm run check
import { existsSync, readFileSync } from 'node:fs';
import { validateManifest } from '@inkwright/plugin-api';

const result = validateManifest(JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8')));
if (!result.ok) {
  console.error(`manifest.json has problems:\n- ${result.errors.join('\n- ')}`);
  process.exit(1);
}
for (const w of result.warnings) console.warn(`warning: ${w}`);
const entry = new URL(`./${result.manifest.entry}`, import.meta.url);
if (!existsSync(entry)) {
  console.error(`The entry file ${result.manifest.entry} is missing.`);
  process.exit(1);
}
if (!/export\s+default/.test(readFileSync(entry, 'utf8'))) {
  console.error(`${result.manifest.entry} needs an "export default { activate(inkwright) { … } }".`);
  process.exit(1);
}
console.log(`${result.manifest.name} ${result.manifest.version} looks good: ${result.manifest.permissions.length} permission(s), ${Object.values(result.manifest.contributes).flat().length} contribution(s).`);
