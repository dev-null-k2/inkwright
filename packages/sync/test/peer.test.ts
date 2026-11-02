import { describe, expect, it } from 'vitest';
import { MemoryFS, Vault, VaultLayout, decodePage, newId, point, type InkStroke } from '@inkwright/core';
import {
  FRAME_HEADER_BYTES,
  FolderRemote,
  FramingError,
  MAX_CHUNK_BYTES,
  MemoryStateStore,
  Opener,
  PairingError,
  PeerCryptoError,
  PeerLink,
  PeerRemote,
  Reassembler,
  Sealer,
  SyncEngine,
  SyncSafetyError,
  answerOffer,
  completeOffer,
  createOffer,
  decodeCode,
  decodeMessage,
  deriveSessionKeys,
  encodeCode,
  encodeMessage,
  generateKeyPair,
  keyFingerprint,
  memoryTransportPair,
  rendezvousSecret,
  servePeerVault,
  toFrames,
  type DeviceInfo,
  type KeyPair,
  type PeerAnswer,
  type PeerOffer,
  type PeerTransport,
  type SessionKeys,
} from '../src/index.ts';
import { fromBase64Url, toBase64Url } from '@inkwright/core';

const te = new TextEncoder();

async function device(name: string): Promise<{ identity: KeyPair; info: DeviceInfo }> {
  const identity = await generateKeyPair();
  return { identity, info: { id: newId(), name, key: toBase64Url(identity.publicRaw) } };
}

/** A complete offer/answer exchange between two devices, as the app does it with QR codes. */
async function handshake(purpose: 'pair' | 'sync' = 'pair') {
  const a = await device('Laptop');
  const b = await device('Tablet');
  const started = await createOffer({ device: a.info, purpose, sdp: 'v=0 offer-sdp' });
  const offer = (await decodeCode(await encodeCode(started.offer))) as PeerOffer;
  const { answer, keys: bKeys } = await answerOffer({ offer, identity: b.identity, device: b.info, sdp: 'v=0 answer-sdp' });
  const back = (await decodeCode(await encodeCode(answer))) as PeerAnswer;
  const aKeys = await completeOffer({ started, answer: back, identity: a.identity });
  return { a, b, started, offer, answer: back, aKeys, bKeys };
}

describe('peer crypto', () => {
  it('derives matching directional keys and the same short code on both devices', async () => {
    const { aKeys, bKeys } = await handshake();
    expect(aKeys.sas).toMatch(/^\d{6}$/);
    expect(aKeys.sas).toBe(bKeys.sas);
    expect(aKeys.sessionId).toBe(bKeys.sessionId);
    const sealed = await new Sealer(aKeys.send).seal(te.encode('hello'));
    expect(new TextDecoder().decode(await new Opener(bKeys.recv).open(sealed.seq, sealed.data))).toBe('hello');
    const back = await new Sealer(bKeys.send).seal(te.encode('hi'));
    expect(new TextDecoder().decode(await new Opener(aKeys.recv).open(back.seq, back.data))).toBe('hi');
  });

  it('never decrypts with its own sending key (directions are separate)', async () => {
    const { aKeys } = await handshake();
    const sealed = await new Sealer(aKeys.send).seal(te.encode('x'));
    await expect(new Opener(aKeys.recv).open(sealed.seq, sealed.data)).rejects.toBeInstanceOf(PeerCryptoError);
  });

  it('rejects replayed, reordered and altered messages', async () => {
    const { aKeys, bKeys } = await handshake();
    const s = new Sealer(aKeys.send);
    const m1 = await s.seal(te.encode('one'));
    const m2 = await s.seal(te.encode('two'));
    const o = new Opener(bKeys.recv);
    await expect(o.open(m2.seq, m2.data)).rejects.toThrow(/reordered/);
    await o.open(m1.seq, m1.data);
    await expect(o.open(m1.seq, m1.data)).rejects.toThrow(/replayed/);
    const bad = m2.data.slice();
    bad[3] ^= 1;
    await expect(o.open(m2.seq, bad)).rejects.toThrow(/authentication/);
    // A ciphertext can't be moved to another sequence number either (seq is in the nonce and AAD).
    const o2 = new Opener(bKeys.recv);
    await expect(o2.open(1, m2.data)).rejects.toBeInstanceOf(PeerCryptoError);
  });

  it('gives different keys when anything in the handshake differs', async () => {
    const a = await device('A');
    const b = await device('B');
    const ea = await generateKeyPair();
    const eb = await generateKeyPair();
    const base = { identity: a.identity, ephemeral: ea, peerIdentity: b.identity.publicRaw, peerEphemeral: eb.publicRaw, transcript: te.encode('t') };
    const k = await deriveSessionKeys({ role: 'initiator', ...base });
    const other = [
      await deriveSessionKeys({ role: 'initiator', ...base, transcript: te.encode('t2') }),
      await deriveSessionKeys({ role: 'initiator', ...base, psk: new Uint8Array(32) }),
      await deriveSessionKeys({ role: 'initiator', ...base, peerIdentity: (await generateKeyPair()).publicRaw }),
    ];
    for (const o of other) expect(o.sessionId === k.sessionId && o.sas === k.sas).toBe(false);
    const sealed = await new Sealer(k.send).seal(te.encode('x'));
    // The responder with a substituted identity cannot open the initiator's messages.
    const mallory = await generateKeyPair();
    const r = await deriveSessionKeys({ role: 'responder', identity: mallory, ephemeral: eb, peerIdentity: a.identity.publicRaw, peerEphemeral: ea.publicRaw, transcript: te.encode('t') });
    await expect(new Opener(r.recv).open(sealed.seq, sealed.data)).rejects.toBeInstanceOf(PeerCryptoError);
  });

  it('derives the same rendezvous secret on both paired devices, and a stable fingerprint', async () => {
    const a = await device('A');
    const b = await device('B');
    const x = await rendezvousSecret(a.identity, b.identity.publicRaw, 'room');
    const y = await rendezvousSecret(b.identity, a.identity.publicRaw, 'room');
    expect(toBase64Url(x)).toBe(toBase64Url(y));
    expect(await keyFingerprint(a.identity.publicRaw)).toMatch(/^([0-9A-F]{4} ){4}[0-9A-F]{4}$/);
  });
});

describe('pairing codes', () => {
  it('round-trips offers and answers through compact codes', async () => {
    const a = await device('Laptop');
    const { offer } = await createOffer({ device: a.info, purpose: 'collab', sdp: 'v=0\r\n'.repeat(40), invite: { noteId: newId(), title: 'Physics', permission: 'write' } });
    const code = await encodeCode(offer);
    expect(code.startsWith('ink1:')).toBe(true);
    expect(code.length).toBeLessThan(JSON.stringify(offer).length);
    expect(await decodeCode(`  ${code.slice(0, 20)}\n${code.slice(20)} `)).toEqual(offer);
  });

  it('refuses garbage, other versions, expired offers and its own code', async () => {
    await expect(decodeCode('hello')).rejects.toBeInstanceOf(PairingError);
    await expect(decodeCode('ink1:AAAA')).rejects.toBeInstanceOf(PairingError);
    const a = await device('A');
    const { offer } = await createOffer({ device: a.info, purpose: 'pair', sdp: 'x', now: 0 });
    await expect(decodeCode(`ink0:${toBase64Url(te.encode(JSON.stringify({ ...offer, v: 99 })))}`)).rejects.toThrow(/different version/);
    await expect(answerOffer({ offer, identity: a.identity, device: a.info, sdp: 'y', now: 1 })).rejects.toThrow(/this device/);
    const b = await device('B');
    await expect(answerOffer({ offer, identity: b.identity, device: b.info, sdp: 'y', now: 11 * 60_000 })).rejects.toThrow(/expired/);
  });

  it('rejects an answer that does not prove the pairing secret', async () => {
    const { started, answer, a } = await handshake('pair');
    await expect(completeOffer({ started, answer: { ...answer, mac: undefined }, identity: a.identity })).rejects.toThrow(/scanned this code/);
    // Someone who saw only the SDP, not the secret, answers with their own keys.
    const m = await device('Mallory');
    const { answer: forged } = await answerOffer({ offer: { ...started.offer, psk: toBase64Url(new Uint8Array(32)) }, identity: m.identity, device: m.info, sdp: 'z' });
    await expect(completeOffer({ started, answer: forged, identity: a.identity })).rejects.toThrow(/scanned this code/);
  });

  it('reconnects paired devices without a secret, but only with the expected key', async () => {
    const { a, b, started, answer } = await handshake('sync');
    expect(started.offer.psk).toBeUndefined();
    await expect(completeOffer({ started, answer, identity: a.identity, expectPeerKey: b.info.key })).resolves.toBeTruthy();
    await expect(completeOffer({ started, answer, identity: a.identity, expectPeerKey: toBase64Url(new Uint8Array(32).fill(9)) })).rejects.toThrow(/different device/);
  });

  it('binds the keys to the SDP: a swapped session description gives different keys', async () => {
    const { started, answer, a, aKeys } = await handshake('sync');
    const tampered = await completeOffer({ started: { ...started, offer: { ...started.offer, sdp: 'v=0 attacker' } }, answer, identity: a.identity });
    expect(tampered.sessionId).not.toBe(aKeys.sessionId);
  });
});

describe('framing', () => {
  it('encodes messages with JSON headers and binary bodies', () => {
    const m = decodeMessage(encodeMessage({ type: 'req', body: { id: 1, m: 'x' }, bin: new Uint8Array([1, 2, 3]) }));
    expect(m).toEqual({ type: 'req', body: { id: 1, m: 'x' }, bin: new Uint8Array([1, 2, 3]) });
    expect(decodeMessage(encodeMessage({ type: 'evt' }))).toEqual({ type: 'evt', body: undefined });
    expect(() => decodeMessage(new Uint8Array([0, 0, 0, 9, 1]))).toThrow(FramingError);
  });

  it('splits large messages into bounded frames and reassembles them', () => {
    const big = new Uint8Array(MAX_CHUNK_BYTES * 2 + 77).map((_, i) => i % 251);
    const frames = toFrames(7, big);
    expect(frames).toHaveLength(3);
    expect(frames.every((f) => f.length <= MAX_CHUNK_BYTES + FRAME_HEADER_BYTES)).toBe(true);
    const r = new Reassembler();
    expect(r.push(frames[0]!)).toBeNull();
    expect(r.push(frames[1]!)).toBeNull();
    const done = r.push(frames[2]!)!;
    expect(done.seq).toBe(7);
    expect(done.sealed).toEqual(big);
  });

  it('refuses out-of-order frames, foreign versions and oversized messages', () => {
    const frames = toFrames(1, new Uint8Array(MAX_CHUNK_BYTES * 2));
    expect(() => new Reassembler().push(frames[1]!)).toThrow(/out of order/);
    const v2 = frames[0]!.slice();
    v2[0] = 2;
    expect(() => new Reassembler().push(v2)).toThrow(/version/);
    expect(() => new Reassembler(100).push(toFrames(1, new Uint8Array(200))[0]!)).toThrow(/too large/);
  });
});

async function linkPair(tap?: (from: 'a' | 'b', f: Uint8Array) => Uint8Array | null, setupB?: (l: PeerLink) => void) {
  const { a, b, aKeys, bKeys } = await handshake();
  const [ta, tb] = memoryTransportPair({ tap });
  const [la, lb] = await Promise.all([
    PeerLink.open(ta, aKeys, { device: a.info, features: ['sync'] }),
    PeerLink.open(tb, bKeys, { device: b.info, features: ['sync'] }, { setup: setupB, answering: true }),
  ]);
  return { la, lb, a, b };
}

describe('secure channel and link', () => {
  it('confirms keys with a hello and carries requests, events and big binaries', async () => {
    const { la, lb, a, b } = await linkPair(undefined, (l) => l.rpc.handle('echo', (p, bin) => ({ result: p, bin })));
    expect(la.peer.device.name).toBe(b.info.name);
    expect(lb.peer.device.key).toBe(a.info.key);
    expect(la.sas).toBe(lb.sas);
    const big = new Uint8Array(300_000).map((_, i) => (i * 7) % 256);
    const r = await la.rpc.call('echo', { hi: 1 }, big);
    expect(r.result).toEqual({ hi: 1 });
    expect(r.bin).toEqual(big);
    const got: unknown[] = [];
    lb.rpc.on('ping', (p) => got.push(p));
    await la.rpc.emit('ping', 1);
    await la.rpc.emit('ping', 2);
    await la.rpc.call('echo', null);
    expect(got).toEqual([1, 2]);
    await expect(la.rpc.call('missing')).rejects.toThrow(/does not offer/);
    la.close();
    await new Promise((r) => setTimeout(r, 10));
    expect(lb.closed).toBe(true);
  });

  it('closes the link when a frame in flight is altered', async () => {
    let n = 0;
    const { la, lb } = await linkPair((from, f) => {
      if (from === 'a' && ++n === 2) f[FRAME_HEADER_BYTES + 2] ^= 0xff;
      return f;
    }, (l) => l.rpc.handle('echo', (p) => ({ result: p })));
    await expect(la.rpc.call('echo', 'tampered')).rejects.toThrow();
    expect(lb.closed).toBe(true);
    expect(lb.channel.closeReason).toMatch(/authentication/);
  });

  it('never opens a link between devices that derived different keys', async () => {
    const x = await handshake();
    const y = await handshake();
    const [ta, tb] = memoryTransportPair();
    const results = await Promise.allSettled([
      PeerLink.open(ta, x.aKeys, { device: x.a.info, features: [] }, { timeoutMs: 500 }),
      PeerLink.open(tb, y.bKeys as SessionKeys, { device: y.b.info, features: [] }, { timeoutMs: 500 }),
    ]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });
});

// ---- Two engines converging over the peer link ------------------------------------------------

let now = 1_700_000_000_000;
const clock = () => (now += 1000);

function stroke(x: number): InkStroke {
  const t = clock();
  return { id: newId(t), pen: 'ballpoint', color: '#FF1B1F24', size: 1.8, createdAt: t, points: [point(x, 10, 0, 0.5), point(x + 20, 30, 16, 0.7)] };
}

async function vaultDevice() {
  const fs = new MemoryFS(clock);
  const vault = new Vault(fs, clock);
  await vault.init();
  return { fs, vault };
}

/** A drives sync; B serves its vault over the link. */
async function connect(A: { fs: MemoryFS }, B: { fs: MemoryFS }, state = new MemoryStateStore()) {
  const changedOnB: string[] = [];
  const { la, lb } = await linkPair(undefined, (l) => servePeerVault(l.rpc, new FolderRemote(B.fs, { cacheHashes: false }), { onChange: (p) => changedOnB.push(p) }));
  const engine = new SyncEngine({ local: A.fs, remote: new PeerRemote(la.rpc), state, clock, massDelete: { fraction: 0.3, minFiles: 4 } });
  return { engine, la, lb, changedOnB, state };
}

const strokesOf = async (fs: MemoryFS, noteId: string, pageId: string) => decodePage((await fs.readText(VaultLayout.pageInk(noteId, pageId)))!).strokes.map((s) => s.id).sort();

async function load(vault: Vault, id: string) {
  const meta = (await vault.readNote(id))!;
  return { meta, pages: await vault.readPages(meta) };
}

describe('device-to-device sync over the peer link', () => {
  it('a note written on A appears on B, an edit on B returns to A, and concurrent ink merges', async () => {
    const A = await vaultDevice();
    const B = await vaultDevice();
    const { note, pages } = await A.vault.createNote({ title: 'Field notes' });
    const s1 = stroke(10);
    pages[0]!.strokes.push(s1);
    await A.vault.saveNote(note, pages);

    const { engine, la, changedOnB, state } = await connect(A, B);
    const r1 = await engine.sync();
    expect(r1.errors).toEqual([]);
    expect(r1.pushed).toContain(`notes/${note.id}/note.json`);
    expect(changedOnB).toContain(`notes/${note.id}/note.json`);
    const pageId = pages[0]!.id;
    expect(await strokesOf(B.fs, note.id, pageId)).toEqual([s1.id]);

    // B edits the note (renames it, adds a stroke) while A adds a different stroke offline.
    const bLoaded = await load(B.vault, note.id);
    const s2 = stroke(80);
    bLoaded.pages[0]!.strokes.push(s2);
    await B.vault.saveNote({ ...bLoaded.meta, title: 'Field notes (edited on B)' }, bLoaded.pages);
    const aLoaded = await load(A.vault, note.id);
    const s3 = stroke(150);
    aLoaded.pages[0]!.strokes.push(s3);
    await A.vault.saveNote(aLoaded.meta, aLoaded.pages);

    const r2 = await engine.sync();
    expect(r2.errors).toEqual([]);
    expect(r2.merged).toContain(VaultLayout.pageInk(note.id, pageId));
    const want = [s1.id, s2.id, s3.id].sort();
    expect(await strokesOf(A.fs, note.id, pageId)).toEqual(want);
    expect(await strokesOf(B.fs, note.id, pageId)).toEqual(want);
    A.vault.invalidate();
    expect((await load(A.vault, note.id)).meta.title).toBe('Field notes (edited on B)');

    // A third run finds nothing to do: both sides converged.
    const r3 = await engine.sync();
    expect([...r3.pushed, ...r3.pulled, ...r3.merged]).toEqual([]);
    expect(state.size).toBeGreaterThan(0);
    la.close();
  });

  it('keeps the engine safety stops: an emptied peer vault pauses instead of deleting here', async () => {
    const A = await vaultDevice();
    const B = await vaultDevice();
    for (let i = 0; i < 3; i++) {
      const { note, pages } = await A.vault.createNote({ title: `N${i}` });
      pages[0]!.strokes.push(stroke(i * 10));
      await A.vault.saveNote(note, pages);
    }
    const { engine } = await connect(A, B);
    await engine.sync();
    // Everything on B disappears (wiped storage); the next run must not delete A's notes.
    for (const p of await B.fs.list('')) if (p.kind === 'dir') await B.fs.deleteDir(p.name);
    else await B.fs.delete(p.name);
    await expect(engine.sync()).rejects.toBeInstanceOf(SyncSafetyError);
    expect((await A.vault.listNotes()).length).toBe(3);
  });

  it('maps a concurrent edit on the serving device to a precondition retry, then merges', async () => {
    const A = await vaultDevice();
    const B = await vaultDevice();
    const { note, pages } = await A.vault.createNote({ title: 'Race' });
    pages[0]!.strokes.push(stroke(1));
    await A.vault.saveNote(note, pages);
    const { engine } = await connect(A, B);
    await engine.sync();
    const pagePath = VaultLayout.pageInk(note.id, pages[0]!.id);
    const aNote = await load(A.vault, note.id);
    const sa = stroke(40);
    aNote.pages[0]!.strokes.push(sa);
    await A.vault.saveNote(aNote.meta, aNote.pages);
    // While A's sync is between listing and writing, B's user adds a stroke to the same page.
    const sb = stroke(90);
    const origWrite = FolderRemote.prototype.write;
    let raced = false;
    FolderRemote.prototype.write = async function (this: FolderRemote, path, bytes, ifMatch, opts) {
      if (!raced && path === pagePath) {
        raced = true;
        const bNote = await load(new Vault(B.fs, clock), note.id);
        bNote.pages[0]!.strokes.push(sb);
        await new Vault(B.fs, clock).saveNote(bNote.meta, bNote.pages);
      }
      return origWrite.call(this, path, bytes, ifMatch, opts);
    };
    try {
      const r = await engine.sync();
      expect(r.errors).toEqual([]);
    } finally {
      FolderRemote.prototype.write = origWrite;
    }
    expect(raced).toBe(true);
    const ids = decodePage((await B.fs.readText(pagePath))!).strokes.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining([sa.id, sb.id]));
  });

  it('refuses paths outside the vault and app state folders on the serving side', async () => {
    const A = await vaultDevice();
    const B = await vaultDevice();
    const { la } = await connect(A, B);
    const remote = new PeerRemote(la.rpc);
    await expect(remote.write('.inkwright/state.json', te.encode('x'))).rejects.toThrow(/Not a vault file/);
    await expect(remote.read('../etc/passwd')).rejects.toThrow();
    expect(fromBase64Url(toBase64Url(new Uint8Array([1, 2])))).toEqual(new Uint8Array([1, 2]));
  });
});

export type { PeerTransport };
