#!/usr/bin/env node
/**
 * Checks a shrunk release build against what must survive R8 by name (docs/PERFORMANCE.md, "Android").
 *
 *   node scripts/android/check-r8.mjs [android/app/build/outputs/mapping/release/mapping.txt]
 *
 * Release builds are minified, and three things in Inkwright are found by name at run time rather
 * than by a reference R8 can see:
 *
 * 1. Capacitor plugins. The bridge loads each class listed in `capacitor.plugins.json` (written by
 *    `cap sync`) with `Class.forName`, and calls its `@PluginMethod` methods by the name JavaScript
 *    uses (`InkwrightNative.recognize(…)`). `@PermissionCallback`/`@ActivityCallback` methods are
 *    looked up by name too. The app's own InkwrightNativePlugin is registered in MainActivity, so
 *    its class may be renamed, but not its methods.
 * 2. Native code calling back into Java: LiteRT-LM's JNI library finds its classes, fields and
 *    callbacks by name (app/proguard-rules.pro keeps the package whole).
 * 3. ML Kit GenAI's IPC boundary to AICore (genai-common; kept whole for the same reason).
 *
 * R8's mapping.txt says what every class and member was renamed to; this script reads the plugin
 * sources and the mapping and fails if any of those names changed or disappeared. It cannot prove
 * a build works on a phone (docs/ANDROID.md, e2e:android), but it turns the most likely way a
 * shrunk build breaks — a method JavaScript calls that no longer exists under its name — into a
 * build failure instead of a crash report.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const app = join(web, 'android/app');

/** Packages whose classes native code reaches by name: every class must keep its name. */
export const KEPT_WHOLE = ['com.google.ai.edge.litertlm.', 'com.google.mlkit.genai.'];

/**
 * mapping.txt → Map<original class, { renamed, members: Map<original member name, Set<new names>> }>.
 * Inlined frames (`a.b.C.m()` inside another class's block) are skipped: only members that exist
 * in the class itself count.
 */
export function parseMapping(text) {
  const classes = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    if (!line.startsWith(' ')) {
      const m = line.match(/^(\S+) -> (\S+):$/);
      current = m ? { renamed: m[2], members: new Map() } : null;
      if (m) classes.set(m[1], current);
      continue;
    }
    if (!current || line.trimStart().startsWith('#')) continue;
    // `    [1:2:]type name(args)[:3[:4]] -> newName`  or  `    type field -> newName`
    const m = line.match(/^\s+(?:\d+:\d+:)?\S+ ([\w$<>]+)(\([^)]*\))?(?::\d+)*(?::\d+)? -> ([\w$<>]+)$/);
    if (!m) continue;
    const set = current.members.get(m[1]) ?? new Set();
    set.add(m[3]);
    current.members.set(m[1], set);
  }
  return classes;
}

/** Names of methods carrying a Capacitor annotation that makes them callable by name. */
export function callableMethods(source) {
  const names = [];
  const re = /@(PluginMethod|PermissionCallback|ActivityCallback)\b(?:\([^)]*\))?[\s\S]*?\b(?:fun|void)\s+(\w+)\s*\(/g;
  for (const m of source.matchAll(re)) names.push(m[2]);
  return names;
}

function sourcesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sourcesUnder(p) : /\.(kt|java)$/.test(n) ? [p] : [];
  });
}

/** The plugin's class (by simple name) in a source file, if the file defines one. */
function pluginClassIn(source, file) {
  if (!/@CapacitorPlugin\b/.test(source)) return null;
  const pkg = source.match(/^\s*package\s+([\w.]+)/m)?.[1];
  const cls = source.match(/@CapacitorPlugin[\s\S]*?\bclass\s+(\w+)/)?.[1];
  return pkg && cls ? `${pkg}.${cls}` : (console.warn(`check-r8: could not read the plugin class in ${file}`), null);
}

export function check(mappingText, plugins) {
  const map = parseMapping(mappingText);
  const problems = [];
  let methods = 0;
  for (const p of plugins) {
    const entry = map.get(p.className);
    if (!entry) { problems.push(`${p.className}: missing from the build`); continue; }
    if (p.loadedByName && entry.renamed !== p.className) problems.push(`${p.className}: renamed to ${entry.renamed}, but Capacitor loads it by name`);
    for (const name of p.methods) {
      methods++;
      if (!entry.members.get(name)?.has(name)) problems.push(`${p.className}.${name}: renamed or removed, but JavaScript calls it by name`);
    }
  }
  let whole = 0;
  for (const [orig, entry] of map) {
    if (!KEPT_WHOLE.some((prefix) => orig.startsWith(prefix))) continue;
    // Lambda classes the compiler synthesized (`$$ExternalSyntheticLambda0`) exist only in the
    // build; no native code can know their names.
    if (/\$\$(External)?Synthetic|\$\$Lambda/.test(orig)) continue;
    whole++;
    if (entry.renamed !== orig) problems.push(`${orig}: renamed to ${entry.renamed}, but native code looks it up by name`);
  }
  if (!whole) problems.push(`no classes from ${KEPT_WHOLE.join(', ')} in the build (dependency gone, or the mapping is not from this app?)`);
  return { problems, methods, wholeClasses: whole };
}

function main() {
  const mappingPath = process.argv[2] ?? join(app, 'build/outputs/mapping/release/mapping.txt');
  if (!existsSync(mappingPath)) {
    console.error(`check-r8: ${mappingPath} not found. Build a release first (./gradlew bundleRelease or assembleRelease).`);
    return 2;
  }
  const plugins = [];
  // The app's own plugin: registered by class reference (MainActivity), called by method name.
  for (const file of sourcesUnder(join(app, 'src/main/java'))) {
    const src = readFileSync(file, 'utf8');
    const className = pluginClassIn(src, file);
    if (className) plugins.push({ className, loadedByName: false, methods: callableMethods(src) });
  }
  // Plugins from npm: loaded by the class name `cap sync` wrote into capacitor.plugins.json.
  const listed = JSON.parse(readFileSync(join(app, 'src/main/assets/capacitor.plugins.json'), 'utf8'));
  for (const { pkg, classpath } of listed) {
    const dir = [web, resolve(web, '../..')].map((d) => join(d, 'node_modules', pkg, 'android/src/main/java')).find(existsSync);
    const src = dir ? sourcesUnder(dir).map((f) => readFileSync(f, 'utf8')).find((s) => pluginClassIn(s, pkg) === classpath) : undefined;
    plugins.push({ className: classpath, loadedByName: true, methods: src ? callableMethods(src) : [] });
  }
  const { problems, methods, wholeClasses } = check(readFileSync(mappingPath, 'utf8'), plugins);
  if (problems.length) {
    console.error(`check-r8: ${problems.length} problem(s) in ${mappingPath}:`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('Add keep rules to android/app/proguard-rules.pro (docs/PERFORMANCE.md, "Android").');
    return 1;
  }
  console.log(`check-r8: ok — ${plugins.length} plugins and ${methods} methods called by name keep their names; ${wholeClasses} classes reached from native code are intact.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
