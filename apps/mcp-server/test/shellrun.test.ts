/**
 * Runbook shell blocks on the runner (runner/shell.ts, core dev/shellrun.ts): a request runs only
 * with a valid signature from a device trusted on this computer, fresh, once, for this runner, in
 * an allowed folder; output is shortened and the run audited. Plus the git HEAD watch
 * (runner/repowatch.ts) that re-scans a repository when it moves.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportAuditJsonl, MemoryContentStore } from '@inkwright/ai';
import { CodeStore, codeHash, fingerprintOf, newShellRunId, shellRequestPath, shellResultPath, shellRunnerPath, signShellRequest, type ShellRunRequest, type ShellRunResult } from '@inkwright/core';
import type { ServerContext } from '../src/context.ts';
import { ShellService, resolveRunFolder, scrubEnv, shapeOutput } from '../src/runner/shell.ts';
import { RepoWatcher, readGitHead } from '../src/runner/repowatch.ts';
import { makeFixture, type Fixture } from './fixtures.ts';

const posix = process.platform !== 'win32';
let fx: Fixture;
let ctx: ServerContext;
let work: string;

beforeEach(async () => {
  fx = await makeFixture();
  ctx = await fx.ctx();
  work = await mkdtemp(path.join(tmpdir(), 'iw-shell-'));
  await mkdir(path.join(work, 'shop'));
});
afterEach(async () => {
  ctx.trust.audit.close();
  await fx.cleanup();
  await rm(work, { recursive: true, force: true });
});

async function device() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  return { key: kp.privateKey, publicJwk, fingerprint: fingerprintOf(publicJwk) };
}

async function request(svc: ShellService, dev: Awaited<ReturnType<typeof device>>, command: string, o: Partial<ShellRunRequest> = {}): Promise<ShellRunRequest> {
  const now = Date.now();
  const unsigned = { v: 1 as const, id: newShellRunId(), runner: svc.id, command, dialect: 'sh' as const, cwd: 'shop', note: { id: 'LAUNCH', title: 'Launch plan' }, block: { line: 3, codeHash: codeHash(command) }, requestedAt: now, expiresAt: now + 60_000, device: { publicJwk: dev.publicJwk, fingerprint: dev.fingerprint, name: 'Test tablet' }, ...o };
  const signed = await signShellRequest(unsigned, dev.key);
  await ctx.fs.writeText(shellRequestPath(signed.id), JSON.stringify(signed));
  return signed;
}

async function settle(svc: ShellService, id: string): Promise<ShellRunResult> {
  await svc.poll();
  await Promise.allSettled([...svc.running.values()]);
  return JSON.parse((await ctx.fs.readText(shellResultPath(id)))!) as ShellRunResult;
}

describe.runIf(posix)('runbook shell blocks on the runner', () => {
  it('runs a signed, trusted request once, in the allowed folder, with secrets removed from the environment', async () => {
    const dev = await device();
    const svc = new ShellService({ ctx, allow: [work], trusted: [dev.fingerprint], pollMs: 1e9, env: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-secret', INKWRIGHT_MCP_TOKEN: 'tok', HARMLESS: 'yes' } });
    await svc.start();
    const info = JSON.parse((await ctx.fs.readText(shellRunnerPath(svc.id)))!);
    expect(info).toMatchObject({ v: 1, id: svc.id, allow: [work], trusted: [dev.fingerprint] });
    const req = await request(svc, dev, 'pwd; echo "key=[$ANTHROPIC_API_KEY] tok=[$INKWRIGHT_MCP_TOKEN] ok=$HARMLESS"; exit 3');
    const r = await settle(svc, req.id);
    expect(r.status).toBe('failed');
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain(path.join(work, 'shop'));
    expect(r.output).toContain('key=[] tok=[] ok=yes');
    // The same request is never run again (the result is there; restarting the runner keeps it).
    await ctx.fs.writeText(shellResultPath(req.id), JSON.stringify({ ...r, output: 'marker' }));
    await svc.poll();
    expect(JSON.parse((await ctx.fs.readText(shellResultPath(req.id)))!).output).toBe('marker');
    const svc2 = new ShellService({ ctx, allow: [work], trusted: [dev.fingerprint], pollMs: 1e9 });
    await svc2.start();
    await svc2.poll();
    expect(svc2.running.size).toBe(0);
    await svc.stop();
    await svc2.stop();
  });

  it('refuses untrusted devices, changed commands, expired approvals, other runners and folders outside the allow-list', async () => {
    const dev = await device();
    const stranger = await device();
    const svc = new ShellService({ ctx, allow: [path.join(work, 'shop')], trusted: [dev.fingerprint], pollMs: 1e9 });
    await svc.start();
    const untrusted = await request(svc, stranger, 'echo hi', { cwd: undefined });
    expect((await settle(svc, untrusted.id)).reason).toMatch(/doesn't accept approvals from device/);

    const changed = await request(svc, dev, 'echo hi', { cwd: undefined });
    await ctx.fs.writeText(shellRequestPath(changed.id), JSON.stringify({ ...changed, command: 'rm -rf ~', block: { ...changed.block, codeHash: codeHash('rm -rf ~') } }));
    expect((await settle(svc, changed.id)).reason).toMatch(/signature does not verify/);

    const old = await request(svc, dev, 'echo hi', { cwd: undefined, requestedAt: Date.now() - 600_000, expiresAt: Date.now() - 300_000 });
    expect((await settle(svc, old.id)).reason).toMatch(/expired/);

    const outside = await request(svc, dev, 'echo hi', { cwd: '/' });
    expect((await settle(svc, outside.id)).reason).toMatch(/not inside a folder this computer allows/);

    await symlink('/', path.join(work, 'shop', 'escape'));
    const viaLink = await request(svc, dev, 'echo hi', { cwd: 'escape' });
    expect((await settle(svc, viaLink.id)).reason).toMatch(/not inside/);

    const elsewhere = await request(svc, dev, 'echo hi', { runner: 'sh-another-computer', cwd: undefined });
    await svc.poll();
    expect(await ctx.fs.readText(shellResultPath(elsewhere.id))).toBeNull();

    await ctx.trust.audit.flush();
    const audit = await exportAuditJsonl(ctx.fs);
    expect((audit.match(/"kind":"blocked"/g) ?? []).length).toBeGreaterThanOrEqual(5);
    await svc.stop();
  });

  it('stops a command at the timeout, and shortens long output keeping the full text on this computer', async () => {
    const dev = await device();
    const originals = new MemoryContentStore();
    const svc = new ShellService({ ctx, allow: [work], trusted: [dev.fingerprint], timeoutSeconds: 1, originals, pollMs: 1e9 });
    await svc.start();
    const slow = await request(svc, dev, 'sleep 30 & sleep 30; echo never');
    const t0 = Date.now();
    const r = await settle(svc, slow.id);
    expect(r.status).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(10_000);
    const loud = await request(svc, dev, 'i=0; while [ $i -lt 3000 ]; do echo "PASS test $i"; i=$((i+1)); done; echo "FAIL test checkout: expected 90"');
    const l = await settle(svc, loud.id);
    expect(l.status).toBe('done');
    expect(l.shortened).toBe(true);
    expect(l.output!.length).toBeLessThan(20_000);
    expect(l.output).toContain('FAIL test checkout');
    expect((await originals.get(l.originalRef!))!.split('\n').length).toBeGreaterThan(3000);
    await ctx.trust.audit.flush();
    expect(await exportAuditJsonl(ctx.fs)).toMatch(/"kind":"exec"/);
    await svc.stop();
  });
});

describe('helpers', () => {
  it('scrubs secret-looking variables', () => {
    expect(scrubEnv({ PATH: '/bin', GITHUB_TOKEN: 'x', OPENAI_API_KEY: 'y', DB_PASSWORD: 'z', INKWRIGHT_VAULT: 'v', HOME: '/h' })).toEqual({ PATH: '/bin', HOME: '/h' });
  });
  it('resolves folders inside the allow-list only', async () => {
    const shop = path.join(work, 'shop');
    expect(resolveRunFolder(undefined, [shop])).toMatchObject({ ok: true });
    expect(resolveRunFolder('..', [shop])).toMatchObject({ ok: false });
    expect(resolveRunFolder('missing', [shop])).toMatchObject({ ok: false, reason: expect.stringMatching(/doesn't exist/) });
    expect(resolveRunFolder('x', [])).toMatchObject({ ok: false });
  });
  it('leaves short output alone', () => {
    expect(shapeOutput('ok\n')).toEqual({ text: 'ok\n', shortened: false });
  });
});

describe('git HEAD watch', () => {
  const sha = (c: string) => c.repeat(40);
  async function repo(dir: string, head: string) {
    await mkdir(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
    await writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(path.join(dir, '.git', 'refs', 'heads', 'main'), `${head}\n`);
    await writeFile(path.join(dir, 'cart.ts'), 'export function applyCoupon(total: number): number {\n  return total;\n}\n');
  }

  it('reads HEAD from loose refs, packed refs, detached heads and worktrees', async () => {
    const r = path.join(work, 'r');
    await repo(r, sha('a'));
    expect(await readGitHead(r)).toEqual({ ref: 'refs/heads/main', commit: sha('a') });
    await rm(path.join(r, '.git', 'refs', 'heads', 'main'));
    await writeFile(path.join(r, '.git', 'packed-refs'), `# pack-refs with: peeled\n${sha('b')} refs/heads/main\n`);
    expect((await readGitHead(r))!.commit).toBe(sha('b'));
    await writeFile(path.join(r, '.git', 'HEAD'), `${sha('c')}\n`);
    expect(await readGitHead(r)).toEqual({ ref: null, commit: sha('c') });
    // A worktree: .git is a file pointing at its own git dir, which names the common dir.
    const wt = path.join(work, 'wt');
    await mkdir(path.join(r, '.git', 'worktrees', 'wt'), { recursive: true });
    await writeFile(path.join(r, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(path.join(r, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    await mkdir(wt);
    await writeFile(path.join(wt, '.git'), `gitdir: ${path.join(r, '.git', 'worktrees', 'wt')}\n`);
    expect((await readGitHead(wt))!.commit).toBe(sha('b'));
    expect(await readGitHead(work)).toBeNull();
  });

  it('re-scans when HEAD moves, and not otherwise', async () => {
    const r = path.join(work, 'shop-repo');
    await repo(r, sha('1'));
    const scans: Array<{ commit: string }> = [];
    const w = new RepoWatcher({ ctx, repos: [{ path: r, id: 'shop' }], intervalMs: 1e9, onScan: (e) => scans.push({ commit: e.head.commit }) });
    await w.start();
    expect(scans).toEqual([{ commit: sha('1') }]);
    expect((await new CodeStore(ctx.fs).readSource('shop'))!.head).toEqual({ ref: 'refs/heads/main', commit: sha('1') });
    await w.check();
    expect(scans.length).toBe(1);
    await writeFile(path.join(r, 'cart.ts'), 'export function applyCoupon(total: number, coupon: string): number {\n  return total;\n}\n');
    await writeFile(path.join(r, '.git', 'refs', 'heads', 'main'), `${sha('2')}\n`);
    await w.check();
    expect(scans.map((s) => s.commit)).toEqual([sha('1'), sha('2')]);
    const graph = (await new CodeStore(ctx.fs).readAllGraphs()).find((g) => g.sourceId === 'shop')!;
    expect(graph.symbols.find((s) => s.name === 'applyCoupon')!.signature).toContain('coupon: string');
    w.stop();
    // A new watcher on an unchanged repository doesn't scan again.
    const w2 = new RepoWatcher({ ctx, repos: [{ path: r, id: 'shop' }], intervalMs: 1e9, onScan: (e) => scans.push({ commit: e.head.commit }) });
    await w2.start();
    expect(scans.length).toBe(2);
    w2.stop();
  });
});
