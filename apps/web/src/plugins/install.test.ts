import { describe, expect, it } from 'vitest';
import { MemoryFS, PLUGINS_CONFIG, decodePluginsConfig } from '@inkwright/core';
import { writeZip } from '@inkwright/sync';
import { PluginInstallError, packageFromFiles, packageFromUrl, packageFromZip } from './install.ts';
import { PluginStore } from './store.ts';
import { CATALOG } from './catalog.ts';

const enc = new TextEncoder();
const manifest = (p: Record<string, unknown> = {}) => JSON.stringify({ id: 'com.example.hello', name: 'Hello', version: '1.0.0', author: 'Me', description: 'Says hello.', minAppVersion: '1.0.0', permissions: ['notes:read'], contributes: { commands: [{ id: 'hi', title: 'Say hi' }] }, ...p });
const files = (m = manifest(), extra: Record<string, string> = {}) => new Map(Object.entries({ 'manifest.json': m, 'main.js': 'export default {}', ...extra }).map(([k, v]) => [k, enc.encode(v)]));
const src = { kind: 'folder' as const, name: 'hello' };

describe('plugin packages', () => {
  it('finds the manifest in a top folder and keeps only plugin files', () => {
    const input = new Map([...files(manifest(), { 'README.md': '# Hi', 'data.json': '{"storage":{"stolen":1}}', '.env': 'SECRET=1', 'run.sh': 'rm -rf /' })].map(([k, v]) => [`hello-1.0.0/${k}`, v]));
    const pkg = packageFromFiles(input, src, '1.0.0');
    expect(pkg.manifest.id).toBe('com.example.hello');
    expect([...pkg.files.keys()].sort()).toEqual(['README.md', 'main.js', 'manifest.json']);
  });

  it('rejects missing manifests and code, bad manifests, and plugins for newer apps', () => {
    expect(() => packageFromFiles(new Map([['main.js', enc.encode('')]]), src, '1.0.0')).toThrow(PluginInstallError);
    expect(() => packageFromFiles(new Map([['manifest.json', enc.encode(manifest())]]), src, '1.0.0')).toThrow(/main.js\) is missing/);
    expect(() => packageFromFiles(files(manifest({ permissions: ['root'] })), src, '1.0.0')).toThrow(/Unknown permission/);
    expect(() => packageFromFiles(files('{nope'), src, '1.0.0')).toThrow(/not valid JSON/);
    expect(() => packageFromFiles(files(manifest({ minAppVersion: '9.0.0' })), src, '1.0.0')).toThrow(/needs Inkwright 9.0.0/);
  });

  it('enforces size limits', () => {
    expect(() => packageFromFiles(files(manifest(), { 'big.js': 'x'.repeat(6 * 1024 * 1024) }), src, '1.0.0')).toThrow(/at most 5 MB/);
  });

  it('reads zips and URLs', async () => {
    const zip = await writeZip([...files()].map(([path, bytes]) => ({ path: `pkg/${path}`, bytes })), { compress: false });
    expect((await packageFromZip(zip, 'hello.zip', '1.0.0')).source).toEqual({ kind: 'zip', name: 'hello.zip' });
    const served = files();
    const fetchFn = (async (u: string) => {
      const name = new URL(u).pathname.split('/').pop()!;
      const b = served.get(name);
      return b ? new Response(b) : new Response('nope', { status: 404 });
    }) as typeof fetch;
    const pkg = await packageFromUrl('https://plugins.example.com/hello/', '1.0.0', fetchFn);
    expect(pkg.source).toEqual({ kind: 'url', url: 'https://plugins.example.com/hello/manifest.json' });
    await expect(packageFromUrl('http://plugins.example.com/hello/', '1.0.0', fetchFn)).rejects.toThrow(/https/);
  });

  it('ships a valid curated list', () => {
    expect(CATALOG.map((c) => c.id)).toEqual(['app.inkwright.examples.word-count', 'app.inkwright.examples.webhook']);
    for (const c of CATALOG) expect(c.load('1.0.0').manifest.version).toBe(c.version);
  });
});

describe('PluginStore', () => {
  it('installs, keeps data across updates, records grants and uninstalls cleanly', async () => {
    const fs = new MemoryFS();
    let now = 1000;
    const store = new PluginStore(fs, () => now);
    const v1 = packageFromFiles(files(manifest(), { 'old.js': '1' }), src, '1.0.0');
    await store.install(v1, ['notes:read', 'network' as never]);
    expect(await store.record('com.example.hello')).toMatchObject({ version: '1.0.0', enabled: true, granted: ['notes:read'], installedAt: 1000 });
    await store.saveData('com.example.hello', { settings: { a: 1 }, storage: { k: 'v' } });
    now = 2000;
    await store.install(packageFromFiles(files(manifest({ version: '1.1.0' })), src, '1.0.0'), ['notes:read']);
    expect(await fs.readText('plugins/com.example.hello/old.js')).toBeNull();
    expect(await store.data('com.example.hello')).toEqual({ settings: { a: 1 }, storage: { k: 'v' } });
    expect(await store.record('com.example.hello')).toMatchObject({ version: '1.1.0', installedAt: 1000, updatedAt: 2000 });
    await store.updateRecord('com.example.hello', (r) => ({ ...r, enabled: false }));
    expect(decodePluginsConfig((await fs.readText(PLUGINS_CONFIG))!).plugins[0]!.enabled).toBe(false);
    await store.uninstall('com.example.hello');
    expect(await fs.list('plugins/com.example.hello')).toEqual([]);
    expect((await store.config()).plugins).toEqual([]);
  });
});
