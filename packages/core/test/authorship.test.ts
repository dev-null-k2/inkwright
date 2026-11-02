import { describe, expect, it } from 'vitest';
import {
  NoteDocument, buildClaim, chainHead, classifyPage, decodePage, encodePage, fingerprintOf, itemDigest, mergeAuthorship, newNote,
  parseCertificate, replayChain, sha256, signClaim, toHex, translateStroke, verifyCertificate, writingRhythm,
  type InkStroke, type SignerInfo, type TextBox,
} from '../src/index.ts';
import { stroke, word } from './helpers.ts';

let clock = 1_700_000_000_000;
const tick = () => (clock += 1000);
let ids = 0;
const newId = () => `id${++ids}`;

function makeDoc() {
  const note = newNote({ id: 'n1', title: 'Essay', pageId: 'p1', now: clock });
  return new NoteDocument(note, [{ id: 'p1', strokes: [], formatVersion: 2 }], tick, newId);
}
const handStroke = (x: number, y: number, input: InkStroke['input'] = 'pen'): InkStroke => ({ ...stroke(newId(), word(x, y, 60)), createdAt: tick(), input });
const text = (t: string, origin?: TextBox['origin']): TextBox => ({ id: newId(), x: 10, y: 10, width: 200, text: t, fontSize: 16, color: '#FF000000', font: 'sans', createdAt: tick(), origin });

async function signer(): Promise<{ info: SignerInfo; key: CryptoKey }> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const publicKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  return { info: { alg: 'ES256', publicKey, fingerprint: fingerprintOf(publicKey), name: 'Test tablet' }, key: kp.privateKey };
}

describe('sha256', () => {
  it('matches the FIPS test vectors', () => {
    expect(toHex(sha256(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(toHex(sha256('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(toHex(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    expect(toHex(sha256('a'.repeat(1000)))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
  });
});

describe('authorship chain', () => {
  it('records every edit as it is committed, and survives a save/load round trip', () => {
    const doc = makeDoc();
    const s = handStroke(10, 10);
    doc.addStroke(0, s);
    const events = doc.page(0).authorship!.events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ op: '+', k: 's', id: s.id, how: 'draw' });
    const reloaded = decodePage(encodePage(doc.page(0)));
    expect(itemDigest('s', reloaded.strokes[0]!)).toBe(events[0]!.d);
    expect(reloaded.strokes[0]!.input).toBe('pen');
    expect(chainHead('p1', reloaded.authorship!.events)).toBe(chainHead('p1', events));
  });

  it('keeps moved and partly-erased handwriting counted as handwriting', () => {
    const doc = makeDoc();
    const s = handStroke(10, 10);
    doc.addStroke(0, s);
    doc.transform(0, { strokes: new Set([s.id]) }, 'Move', { stroke: (x) => translateStroke(x, 20, 0) });
    const moved = doc.page(0).strokes[0]!;
    // Precise erase: the stroke is replaced by a fragment with the same createdAt.
    doc.commitBetween(0, doc.page(0), { ...doc.page(0), strokes: [{ ...moved, id: 'frag', points: moved.points.slice(0, 40) }] }, 'Erase');
    const { counts } = classifyPage(doc.page(0));
    expect(counts.handwritten).toBe(1);
    expect(counts.penWithPressure).toBe(1);
  });

  it('counts pasted ink as copied, AI and machine text separately, and strokes outside the chain as unattested', () => {
    const doc = makeDoc();
    const s = handStroke(10, 10);
    doc.addStroke(0, s);
    doc.paste(0, { strokes: [translateStroke(s, 0, 100)] });
    doc.upsertText(0, text('typed by me'));
    doc.upsertText(0, text('an AI answer', 'ai'));
    doc.upsertText(0, text('recognized words', 'recognized'));
    doc.commit(0, { label: 'AI ink', strokes: { removed: [], added: [{ index: 2, item: { ...handStroke(300, 300), origin: 'ai' } }] } });
    // A stroke slipped into the file without the app (or by an older version).
    const page = { ...doc.page(0), strokes: [...doc.page(0).strokes, handStroke(400, 400)] };
    const { counts } = classifyPage(page);
    expect(counts).toMatchObject({ handwritten: 1, copied: 1, aiInk: 1, unattested: 1, typedText: 1, aiText: 1, recognizedText: 1 });
  });

  it('undo and redo restore handwriting with its history', () => {
    const doc = makeDoc();
    doc.addStroke(0, handStroke(10, 10));
    doc.undo();
    expect(classifyPage(doc.page(0)).counts.handwritten).toBe(0);
    doc.redo();
    expect(classifyPage(doc.page(0)).counts.handwritten).toBe(1);
    expect(doc.page(0).authorship!.events.map((e) => e.op + (e.how ?? ''))).toEqual(['+draw', '-', '+redo']);
  });

  it('records page objects, but not a graph being panned (no content change)', () => {
    const doc = makeDoc();
    const g = { type: 'graph' as const, id: 'g1', x: 0, y: 0, width: 200, height: 150, createdAt: tick(), origin: 'solver' as const, functions: [{ expr: 'x', color: '#FF000000' }], view: { xMin: -1, xMax: 1, yMin: -1, yMax: 1 } };
    doc.editObjects(0, 'Plot', { upsert: [g] });
    expect(doc.page(0).authorship!.events).toHaveLength(1);
    doc.editObjects(0, 'Move graph', { upsert: [{ ...g, view: { xMin: -2, xMax: 2, yMin: -2, yMax: 2 } }] }, { undoable: false });
    expect(doc.page(0).authorship!.events).toHaveLength(1);
    expect(doc.canUndo).toBe(true);
    doc.editObjects(0, 'Add to graph', { upsert: [{ ...g, functions: [...g.functions, { expr: 'x^2', color: '#FF000000' }] }] });
    expect(doc.page(0).authorship!.events.map((e) => e.op + e.k)).toEqual(['+o', '-o', '+o']);
    expect(classifyPage(doc.page(0)).counts.objects).toBe(1);
  });

  it('a stroke drawn by code (no input recorded) is never counted as handwriting', () => {
    const doc = makeDoc();
    doc.addStroke(0, { ...handStroke(10, 10), input: undefined });
    expect(classifyPage(doc.page(0)).counts.handwritten).toBe(0);
  });

  it('merges two devices\' chains by union', () => {
    const a = { v: 1 as const, events: [{ op: '+' as const, k: 's' as const, id: 'a', d: 'x', t: 1 }] };
    const b = { v: 1 as const, events: [{ op: '+' as const, k: 's' as const, id: 'a', d: 'x', t: 1 }, { op: '+' as const, k: 's' as const, id: 'b', d: 'y', t: 0 }] };
    expect(mergeAuthorship(a, b)!.events.map((e) => e.id)).toEqual(['b', 'a']);
    expect(replayChain(mergeAuthorship(a, b)!.events).live.size).toBe(2);
  });

  it('summarises the writing rhythm', () => {
    const r = writingRhythm([{ ...handStroke(0, 0), createdAt: 1000 }, { ...handStroke(0, 0), createdAt: 3000 }]);
    expect(r.firstAt).toBe(1000);
    expect(r.sessions).toBe(1);
    expect(r.pauseMedianMs).toBe(3000 - (1000 + 800));
    expect(r.speedMean).toBeGreaterThan(0);
    expect(r.pressureMean).toBeCloseTo(0.5);
  });
});

describe('authorship certificates', () => {
  async function signedDoc() {
    const doc = makeDoc();
    doc.addStroke(0, handStroke(10, 10));
    doc.addStroke(0, handStroke(10, 60, 'touch'));
    doc.upsertText(0, text('AI wrote this', 'ai'));
    const { info, key } = await signer();
    const { claim, evidence } = buildClaim(doc.meta, doc.pages, info, { now: clock });
    const cert = await signClaim(claim, evidence, key);
    return { doc, cert };
  }

  it('signs and verifies offline, and counts what is what', async () => {
    const { doc, cert } = await signedDoc();
    const json = JSON.stringify(cert);
    const r = await verifyCertificate(parseCertificate(json), doc.pages);
    expect(r.status).toBe('verified');
    expect(r.signatureValid).toBe(true);
    expect(r.totals).toMatchObject({ handwritten: 2, penWithPressure: 1, touch: 1, aiText: 1 });
    expect(cert.claim.actions.map((a) => a.digitalSourceType)).toContain('http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia');
    expect(r.fingerprint).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){4}$/);
  });

  it('detects edits made after signing (and that the history only grew)', async () => {
    const { doc, cert } = await signedDoc();
    doc.addStroke(0, handStroke(200, 200));
    const r = await verifyCertificate(cert, doc.pages);
    expect(r.status).toBe('changed');
    expect(r.pages[0]!.since).toMatchObject({ added: 1, removed: 0, changed: 0, appendOnly: true });
  });

  it('tamper: changing the claimed counts breaks the signature', async () => {
    const { cert } = await signedDoc();
    const bad = structuredClone(cert);
    bad.claim.totals.handwritten = 99;
    const r = await verifyCertificate(bad);
    expect(r.status).toBe('invalid');
    expect(r.signatureValid).toBe(false);
  });

  it('tamper: editing the signed ink breaks the evidence digest', async () => {
    const { cert } = await signedDoc();
    const bad = structuredClone(cert);
    (bad.evidence.pages[0]!.strokes[0] as { points: number[][] }).points[3]![0] += 5;
    const r = await verifyCertificate(bad);
    expect(r.status).toBe('invalid');
    expect(r.evidenceIntact).toBe(false);
    expect(r.pages[0]!.contentMatchesChain).toBe(false);
  });

  it('tamper: rewriting history (even with a recomputed digest) fails the chain head', async () => {
    const { cert } = await signedDoc();
    const bad = structuredClone(cert);
    bad.evidence.pages[0]!.events[0]!.how = 'draw';
    bad.evidence.pages[0]!.events.splice(1, 1);
    const r = await verifyCertificate(bad);
    expect(r.pages[0]!.chainValid).toBe(false);
    expect(r.status).toBe('invalid');
  });

  it('tamper: swapping in another key and fingerprint fails the signature', async () => {
    const { cert } = await signedDoc();
    const other = await signer();
    const bad = structuredClone(cert);
    bad.claim.signer = other.info;
    expect((await verifyCertificate(bad)).signatureValid).toBe(false);
  });

  it('rejects things that are not certificates', () => {
    expect(() => parseCertificate('{"hello":1}')).toThrow();
  });
});
