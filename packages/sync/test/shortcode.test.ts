import { describe, expect, it } from 'vitest';
import { fromBase64Url, newId, toBase64Url } from '@inkwright/core';
import { ristretto255 } from '@noble/curves/ed25519.js';
import {
  CODE_ALPHABET,
  CODE_TTL_MS,
  CodeGuard,
  CpaceParty,
  FRAGMENT_CHARS,
  GUESS_BOUND,
  MAX_ATTEMPTS,
  PASSWORD_BITS,
  PakeError,
  PeerLink,
  ShortCodeError,
  answerOffer,
  calculateGenerator,
  completeOffer,
  confirmationTag,
  createOffer,
  decodeCode,
  encodeCode,
  formatShortCode,
  generateKeyPair,
  generateShortCode,
  generatorString,
  hostShortCode,
  intermediateSessionKey,
  joinShortCode,
  lvCat,
  memoryTransportPair,
  parseShortCode,
  prependLen,
  rendezvousRoom,
  sidOutputIR,
  verifyConfirmation,
  type DeviceInfo,
  type HostState,
  type KeyPair,
  type PeerOffer,
  type RendezvousTransport,
  type StartedOffer,
} from '../src/index.ts';

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * draft-irtf-cfrg-cpace-12, Appendix B.3 (ristretto255, SHA-512): the generator (B.3.1) and the
 * full message flow with fixed scalars (B.3.9). Copied from the draft.
 */
const V = {
  PRS: '50617373776F7264',
  CI: '6F630B425F726573706F6E6465720B415F696E69746961746F72',
  sid: '7E4B4791D6A8EF019B936C79FB7F2C57',
  generatorString: '11435061636552697374726574746F3235350850617373776F726464000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001A6F630B425F726573706F6E6465720B415F696E69746961746F72107E4B4791D6A8EF019B936C79FB7F2C57',
  g: 'A6FC82C3B8968FBB2E06FEE81CA858586DEA50D248F0C7CA6A18B0902A30B36B',
  ya: 'DA3D23700A9E5699258AEF94DC060DFDA5EBB61F02A5EA77FAD53F4FF0976D08',
  ADa: '414461',
  Ya: 'D40FB265A7ABEAEE7939D91A585FE59F7053F982C296EC413C624C669308F87A',
  yb: 'D2316B454718C35362D83D69DF6320F38578ED5984651435E2949762D900B80D',
  ADb: '414462',
  Yb: '08BCF6E9777A9C313A3DB6DAA510F2D398403319C2341BD506A92E672EB7E307',
  K: 'E22B1EF7788F661478F3CDDD4C600774FC0F41E6B711569190FF88FA0E607E09',
  ISK_IR: '4C5469A16B2364C4B944EBC1A79E51D1674AD47DB26E8718154F59FAEBFAA52D8346F30AA58377117EB20D527F2CBC5C76381F7FD372E89DF8239F87F2E02ED1',
  sid_output_ir: '2A76D3BBC499DFDC4DCACC9FF042F4E1A54E3843258E100CCD7C60F0A541F9D3EBF025E68A460DDE218BD39F0711BC6FA11409C9D7B69D8CCF6B32FC51DDB699',
};
const scalar = (h: string) => ristretto255.Point.Fn.create(BigInt(`0x${toHex(hex(h).reverse())}`));

describe('CPace (draft-irtf-cfrg-cpace-12, ristretto255/SHA-512)', () => {
  const params = { prs: hex(V.PRS), ci: hex(V.CI), sid: hex(V.sid) };

  it('encodes lengths as LEB128 (draft A.1.2.1)', () => {
    expect(toHex(prependLen(new Uint8Array(0)))).toBe('00');
    expect(toHex(prependLen(utf8('1234')))).toBe('0431323334');
    expect(toHex(prependLen(new Uint8Array(127))).slice(0, 2)).toBe('7F');
    expect(toHex(prependLen(new Uint8Array(128))).slice(0, 4)).toBe('8001');
  });

  it('matches the draft’s test vectors: generator, shares, K, ISK and sid output', () => {
    expect(toHex(generatorString(params.prs, params.ci, params.sid))).toBe(V.generatorString);
    expect(toHex(calculateGenerator(params.prs, params.ci, params.sid).toBytes())).toBe(V.g);
    const a = new CpaceParty('initiator', params, hex(V.ADa), scalar(V.ya));
    const b = new CpaceParty('responder', params, hex(V.ADb), scalar(V.yb));
    expect(toHex(a.share)).toBe(V.Ya);
    expect(toHex(b.share)).toBe(V.Yb);
    const iskA = a.finish(b.share, hex(V.ADb));
    const iskB = b.finish(a.share, hex(V.ADa));
    expect(toHex(iskA)).toBe(V.ISK_IR);
    expect(toHex(iskB)).toBe(V.ISK_IR);
    expect(toHex(intermediateSessionKey({ sid: params.sid, K: hex(V.K), Ya: hex(V.Ya), ADa: hex(V.ADa), Yb: hex(V.Yb), ADb: hex(V.ADb) }))).toBe(V.ISK_IR);
    expect(toHex(sidOutputIR({ Ya: hex(V.Ya), ADa: hex(V.ADa), Yb: hex(V.Yb), ADb: hex(V.ADb) }))).toBe(V.sid_output_ir);
  });

  it('gives both sides the same key with random scalars, and confirmation tags that verify', () => {
    const p = { prs: utf8('M2Q9X'), ci: lvCat(utf8('test'), utf8('room')), sid: utf8('0123456789abcdef') };
    const a = new CpaceParty('initiator', p, utf8('guest'));
    const b = new CpaceParty('responder', p, utf8('host'));
    const iskA = a.finish(b.share, utf8('host'));
    const iskB = b.finish(a.share, utf8('guest'));
    expect(toHex(iskA)).toBe(toHex(iskB));
    expect(verifyConfirmation(iskA, 'host', confirmationTag(iskB, 'host'))).toBe(true);
    // A tag can't be reflected back as the other role's.
    expect(verifyConfirmation(iskA, 'guest', confirmationTag(iskB, 'host'))).toBe(false);
  });

  it('a wrong code gives different keys, so confirmation fails', () => {
    const base = { ci: utf8('ci'), sid: utf8('sid-sid-sid-sid!') };
    const a = new CpaceParty('initiator', { ...base, prs: utf8('M2Q9X') }, utf8('guest'));
    const b = new CpaceParty('responder', { ...base, prs: utf8('M2Q9Y') }, utf8('host'));
    const iskA = a.finish(b.share, utf8('host'));
    const iskB = b.finish(a.share, utf8('guest'));
    expect(toHex(iskA)).not.toBe(toHex(iskB));
    expect(verifyConfirmation(iskA, 'host', confirmationTag(iskB, 'host'))).toBe(false);
  });

  it('binds the transcript: a different channel, session id, share or associated data changes the key', () => {
    const p = { prs: utf8('M2Q9X'), ci: utf8('ci'), sid: utf8('sid-sid-sid-sid!') };
    const a = new CpaceParty('initiator', p, utf8('guest'));
    const b = new CpaceParty('responder', p, utf8('host'));
    const good = toHex(b.finish(a.share, utf8('guest')));
    expect(toHex(a.finish(b.share, utf8('host')))).toBe(good);
    expect(toHex(a.finish(b.share, utf8('HOST')))).not.toBe(good); // associated data
    const otherSid = new CpaceParty('responder', { ...p, sid: utf8('another-session!') }, utf8('host'));
    expect(toHex(a.finish(otherSid.share, utf8('host')))).not.toBe(toHex(otherSid.finish(a.share, utf8('guest'))));
    const otherCi = new CpaceParty('responder', { ...p, ci: utf8('other room') }, utf8('host'));
    expect(toHex(a.finish(otherCi.share, utf8('host')))).not.toBe(toHex(otherCi.finish(a.share, utf8('guest'))));
  });

  it('refuses invalid encodings and the identity element', () => {
    const a = new CpaceParty('initiator', { prs: utf8('x'), ci: utf8('c'), sid: utf8('s') }, utf8('guest'));
    expect(() => a.finish(new Uint8Array(32), utf8('host'))).toThrow(PakeError); // identity encodes as zeros
    expect(() => a.finish(new Uint8Array(32).fill(0xff), utf8('host'))).toThrow(PakeError);
    expect(() => a.finish(new Uint8Array(31), utf8('host'))).toThrow(PakeError);
  });
});

describe('short codes', () => {
  it('are eight characters from the unambiguous alphabet, with a 3-character nameplate', () => {
    for (let i = 0; i < 200; i++) {
      const c = generateShortCode();
      expect(c.value).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
      expect(c.nameplate + c.password).toBe(c.value);
      expect(c.nameplate).toHaveLength(3);
    }
    expect(CODE_ALPHABET).not.toMatch(/[ILOU]/);
  });

  it('carry 25 bits of password: an online attacker’s chance is bounded by the lockout', () => {
    expect(PASSWORD_BITS).toBe(25);
    expect(MAX_ATTEMPTS).toBe(5);
    expect(GUESS_BOUND).toBeLessThan(2e-7);
  });

  it('use every character about equally often (no modulo bias)', () => {
    const counts = new Map<string, number>();
    const N = 4000;
    for (let i = 0; i < N; i++) for (const ch of generateShortCode().value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    const expected = (N * 8) / 32;
    expect(counts.size).toBe(32);
    // Chi-square with 31 degrees of freedom; 61 is far beyond the 0.1% tail (≈ 61.1 only at 0.1%).
    const chi = [...counts.values()].reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
    expect(chi).toBeLessThan(61);
  });

  it('read forgivingly: case, dashes, spaces and look-alike letters', () => {
    expect(parseShortCode('k7pm-2q9x')?.value).toBe('K7PM2Q9X');
    expect(parseShortCode(' K7PM 2Q9X ')?.value).toBe('K7PM2Q9X');
    expect(parseShortCode('O1LI-ABCD')?.value).toBe('0111ABCD');
    expect(parseShortCode('K7PM-2Q9')).toBeNull();
    expect(parseShortCode('K7PM-2Q9XY')).toBeNull();
    expect(parseShortCode('K7PU-2Q9X')).toBeNull(); // U is not in the alphabet
    expect(formatShortCode('K7PM2Q9X')).toBe('K7PM-2Q9X');
  });

  it('meet in a room named by a hash of the nameplate only', async () => {
    const r = await rendezvousRoom('K7P');
    expect(r).toMatch(/^iw1[0-9a-f]{40}$/);
    expect(r).toBe(await rendezvousRoom('K7P'));
    expect(r).not.toBe(await rendezvousRoom('K7Q'));
    expect(r).not.toContain('K7P');
  });

  it('expire, work once, and lock after the attempt budget is spent', () => {
    const g = new CodeGuard(1000, CODE_TTL_MS);
    expect(g.status(1000)).toBe('open');
    expect(g.status(1000 + CODE_TTL_MS)).toBe('expired');
    expect(g.begin(1000 + CODE_TTL_MS)).toBe(false);

    const once = new CodeGuard(0);
    expect(once.begin(1)).toBe(true);
    once.succeed();
    expect(once.status(2)).toBe('used');
    expect(once.begin(2)).toBe(false);

    const locked = new CodeGuard(0);
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect(locked.begin(1)).toBe(true);
    expect(locked.begin(1)).toBe(false);
    // Still open while the last attempts are in flight (the right one may be among them)…
    expect(locked.status(1)).toBe('open');
    for (let i = 0; i < MAX_ATTEMPTS; i++) locked.fail();
    expect(locked.status(1)).toBe('locked');
  });
});

// ---- The rendezvous protocol through an in-memory relay -----------------------------------------

/** A relay in memory that records every message it carries (what a relay operator would see). */
class MemoryRelay {
  readonly seen: { room: string; text: string }[] = [];
  private rooms = new Map<string, { at: number; text: string }[]>();
  private subs = new Map<string, Set<(t: string) => void>>();
  tamper: ((text: string) => string) | null = null;
  transport(): RendezvousTransport {
    return {
      label: 'memory',
      post: async (room, text) => {
        const t = this.tamper ? this.tamper(text) : text;
        this.seen.push({ room, text: t });
        (this.rooms.get(room) ?? this.rooms.set(room, []).get(room)!).push({ at: Date.now(), text: t });
        for (const s of [...(this.subs.get(room) ?? [])]) queueMicrotask(() => s(t));
      },
      subscribe: async (room, on, signal) => {
        const set = this.subs.get(room) ?? this.subs.set(room, new Set()).get(room)!;
        set.add(on);
        signal.addEventListener('abort', () => set.delete(on), { once: true });
      },
      busy: async (room) => (this.rooms.get(room) ?? []).some((m) => Date.now() - m.at < 10 * 60_000),
    };
  }
}

async function device(name: string): Promise<{ identity: KeyPair; info: DeviceInfo }> {
  const identity = await generateKeyPair();
  return { identity, info: { id: newId(), name, key: toBase64Url(identity.publicRaw) } };
}

const NOTE_TITLE = 'Quarterly plan — private';
const SDP = 'v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\na=candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host\r\n';

/**
 * Host and guest, as the app runs them: the host makes a collab offer per attempt with the PAKE
 * psk; the guest answers it; both derive peer-link session keys, which must match.
 */
async function share(relay: MemoryRelay, opts: { guestCode?: (code: string) => string; sdpPad?: number; ttlMs?: number; waitMs?: number } = {}) {
  const host = await device('Ada’s tablet');
  const guest = await device('Grace’s phone');
  const states: HostState[] = [];
  let started: StartedOffer | null = null;
  let hostKeys: Awaited<ReturnType<typeof completeOffer>> | null = null;
  let cancelled = 0;
  const h = await hostShortCode({
    transport: relay.transport(),
    ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
    makeOffer: async (psk) => {
      const s = await createOffer({ device: host.info, purpose: 'collab', sdp: SDP + toBase64Url(crypto.getRandomValues(new Uint8Array(opts.sdpPad ?? 0))), invite: { noteId: 'n1', title: NOTE_TITLE, permission: 'view' }, pakePsk: psk });
      return { code: await encodeCode(s.offer), started: s, cancel: () => cancelled++ };
    },
    accept: async (answerCode, attempt) => {
      started = attempt.started;
      const answer = await decodeCode(answerCode);
      if (answer.t !== 'answer') throw new Error('not an answer');
      hostKeys = await completeOffer({ started: attempt.started, answer, identity: host.identity });
    },
    onState: (s) => states.push(s),
  });
  const typed = opts.guestCode ? opts.guestCode(formatShortCode(h.code)) : formatShortCode(h.code).toLowerCase();
  const join = async () => {
    const j = await joinShortCode({ transport: relay.transport(), code: typed, ...(opts.waitMs ? { waitMs: opts.waitMs } : {}) });
    const offer = (await decodeCode(j.offerCode)) as PeerOffer;
    const { answer, keys } = await answerOffer({ offer, identity: guest.identity, device: guest.info, sdp: 'v=0 guest', pakePsk: j.psk });
    await j.reply(await encodeCode(answer));
    return { offer, keys };
  };
  return { h, host, guest, states, join, hostKeys: () => hostKeys, started: () => started, cancelled: () => cancelled };
}

const until = async (f: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('meeting by short code', () => {
  it('connects host and guest with one code typed one way, and the peer-link keys match', async () => {
    const relay = new MemoryRelay();
    const s = await share(relay);
    const { offer, keys } = await s.join();
    expect(offer.auth).toBe('pake');
    expect(offer.psk).toBeUndefined();
    expect(offer.invite?.title).toBe(NOTE_TITLE);
    await until(() => s.states.some((x) => x.phase === 'done'));
    // The keys really match: a link opens over an in-memory transport (hello = key confirmation).
    const [ta, tb] = memoryTransportPair();
    const hello = (name: string) => ({ device: { id: name, name, key: name === 'a' ? s.host.info.key : s.guest.info.key }, features: ['collab'] });
    const [la, lb] = await Promise.all([PeerLink.open(ta, s.hostKeys()!, hello('a')), PeerLink.open(tb, keys, hello('b'), { answering: true })]);
    expect(la.sas).toBe(lb.sas);
    la.close();
    lb.close();
  });

  it('shows the relay nothing readable: no code, password, title, names, keys or SDP', async () => {
    const relay = new MemoryRelay();
    const s = await share(relay);
    await s.join();
    await until(() => s.states.some((x) => x.phase === 'done'));
    // Device names are checked as JSON strings ("Ada"), which is how they would leak: bare, a
    // three-letter name turns up by chance in random base64 (salts, nonces) about once in 600 runs.
    const secrets = [s.h.code.value, s.h.code.password, formatShortCode(s.h.code), NOTE_TITLE, '"Ada"', '"Grace"', 'fingerprint', '192.168.1.20', 'v=0', 'ink1:', 'ink0:', s.host.info.key, s.guest.info.key, s.host.info.id];
    expect(relay.seen.length).toBeGreaterThanOrEqual(4); // claim, a, b, c
    for (const { room, text } of relay.seen) {
      expect(room).toBe(await rendezvousRoom(s.h.code.nameplate));
      // Look inside every base64 field too, not just the raw text.
      const env = JSON.parse(text) as { d: string };
      const inner = (() => {
        try {
          return JSON.stringify(Object.values(JSON.parse(env.d)).map((v) => new TextDecoder().decode(fromBase64Url(String(v)))));
        } catch {
          return new TextDecoder().decode(fromBase64Url(env.d));
        }
      })();
      for (const x of secrets) {
        expect(text).not.toContain(x);
        expect(inner).not.toContain(x);
      }
    }
  });

  it('a wrong code fails on both sides, costs one attempt, and five lock the code', async () => {
    const relay = new MemoryRelay();
    const s = await share(relay, { guestCode: (c) => c.slice(0, -1) + (c.endsWith('2') ? '3' : '2'), waitMs: 400 });
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      await expect(s.join()).rejects.toMatchObject({ reason: i < MAX_ATTEMPTS ? 'wrong' : expect.stringMatching(/wrong|nobody/) });
    }
    await until(() => s.h.state.phase === 'ended');
    expect(s.h.state).toEqual({ phase: 'ended', status: 'locked' });
    // Each answered attempt made (and dropped) an offer.
    expect(s.cancelled()).toBe(MAX_ATTEMPTS);
    // Now even the right code finds nobody.
    const late = await joinShortCode({ transport: relay.transport(), code: formatShortCode(s.h.code), waitMs: 300 }).catch((e) => e);
    expect(late).toBeInstanceOf(ShortCodeError);
    expect(late.reason).toBe('nobody');
  }, 20_000);

  it('works once: a second guest with the same code finds nobody', async () => {
    const relay = new MemoryRelay();
    const s = await share(relay);
    await s.join();
    await until(() => s.states.some((x) => x.phase === 'done'));
    const again = await joinShortCode({ transport: relay.transport(), code: formatShortCode(s.h.code), waitMs: 300 }).catch((e) => e);
    expect(again.reason).toBe('nobody');
  });

  it('expires', async () => {
    const relay = new MemoryRelay();
    const s = await share(relay, { ttlMs: 50, waitMs: 300 });
    await until(() => s.h.state.phase === 'ended');
    expect(s.h.state).toEqual({ phase: 'ended', status: 'expired' });
    await expect(s.join()).rejects.toMatchObject({ reason: 'nobody' });
  });

  it('a relay that alters a sealed offer or answer breaks the connection instead of fooling either side', async () => {
    const relay = new MemoryRelay();
    // Flip one character inside every sealed blob (`x`).
    relay.tamper = (text) => {
      const env = JSON.parse(text);
      if (env.k !== 'b' && env.k !== 'c') return text;
      const d = JSON.parse(env.d);
      // Always a different character (comparing the one replaced: once in 64 runs the old check
      // compared another one, left the blob untouched, and the honest connection went through).
      d.x = (d.x[0] === 'A' ? 'B' : 'A') + d.x.slice(1);
      return JSON.stringify({ ...env, d: JSON.stringify(d) });
    };
    const s = await share(relay, { waitMs: 300 });
    await expect(s.join()).rejects.toBeInstanceOf(ShortCodeError);
    expect(s.states.some((x) => x.phase === 'done')).toBe(false);
  });

  it('a relay swapping the host’s CPace share (a man in the middle without the code) is caught', async () => {
    const relay = new MemoryRelay();
    const mitm = new CpaceParty('responder', { prs: utf8('AAAAA'), ci: utf8('x'), sid: utf8('y') }, utf8('host'));
    relay.tamper = (text) => {
      const env = JSON.parse(text);
      if (env.k !== 'b') return text;
      const d = JSON.parse(env.d);
      return JSON.stringify({ ...env, d: JSON.stringify({ ...d, Y: toBase64Url(mitm.share) }) });
    };
    const s = await share(relay, { waitMs: 300 });
    await expect(s.join()).rejects.toMatchObject({ reason: 'wrong' });
  });

  it('splits long offers into fragments that fit any relay', async () => {
    const relay = new MemoryRelay();
    const s = await share(relay, { sdpPad: 12_000 });
    await s.join();
    await until(() => s.states.some((x) => x.phase === 'done'));
    expect(relay.seen.length).toBeGreaterThan(4);
    for (const m of relay.seen) expect(m.text.length).toBeLessThan(FRAGMENT_CHARS + 200);
  });

  it('refuses malformed codes before contacting the relay', async () => {
    const relay = new MemoryRelay();
    await expect(joinShortCode({ transport: relay.transport(), code: 'hello' })).rejects.toMatchObject({ reason: 'invalid' });
    expect(relay.seen).toHaveLength(0);
  });

  it('an offer made for a short code can’t be answered without the code’s key', async () => {
    const host = await device('A');
    const guest = await device('B');
    const s = await createOffer({ device: host.info, purpose: 'pair', sdp: 'v=0', pakePsk: new Uint8Array(32).fill(7) });
    const offer = (await decodeCode(await encodeCode(s.offer))) as PeerOffer;
    await expect(answerOffer({ offer, identity: guest.identity, device: guest.info, sdp: 'v=0' })).rejects.toThrow(/short code/);
    // With a different key the answer's MAC fails on the host.
    const { answer } = await answerOffer({ offer, identity: guest.identity, device: guest.info, sdp: 'v=0', pakePsk: new Uint8Array(32).fill(8) });
    await expect(completeOffer({ started: s, answer, identity: host.identity })).rejects.toThrow(/scanned this code/);
  });
});
