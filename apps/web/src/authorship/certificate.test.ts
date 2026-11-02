import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { NoteDocument, newNote, verifyCertificate, type InkStroke } from '@inkstone/core';
import { certificateFromFile, createCertificate, embedInPdf, extractFromPdf } from './certificate.ts';
import { deviceKey, deviceSigner } from './keys.ts';

const hand = (id: string, y: number): InkStroke => ({
  id, pen: 'fountain', color: '#FF1B1F24', size: 2, createdAt: 1_700_000_000_000 + y, input: 'pen',
  points: Array.from({ length: 30 }, (_, i) => ({ x: 10 + i * 3, y: y + Math.sin(i) * 4, t: i * 8, p: 0.5, tilt: 0.3, orient: 1 })),
});

function doc() {
  const d = new NoteDocument(newNote({ id: 'n1', title: 'Essay', pageId: 'p1', now: 0 }), [{ id: 'p1', strokes: [], formatVersion: 2 }]);
  d.addStroke(0, hand('a', 40));
  d.addStroke(0, hand('b', 90));
  return d;
}

describe('device key', () => {
  it('is made once, kept in IndexedDB, and its private half cannot be exported', async () => {
    const k1 = await deviceKey();
    const k2 = await deviceKey();
    expect(k1.fingerprint).toBe(k2.fingerprint);
    expect(k1.persistent).toBe(true);
    expect(k1.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('jwk', k1.privateKey)).rejects.toBeTruthy();
    expect((await deviceSigner()).info.fingerprint).toBe(k1.fingerprint);
  });
});

describe('certificates in PDFs', () => {
  it('embeds a signed certificate in a PDF and reads it back, verifiable offline', async () => {
    const d = doc();
    const cert = await createCertificate(d.meta, d.pages);
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 300]);
    await embedInPdf(pdf, cert);
    const bytes = await pdf.save();
    const back = await extractFromPdf(bytes);
    expect(back?.signature).toBe(cert.signature);
    const report = await verifyCertificate(back!, d.pages);
    expect(report.status).toBe('verified');
    expect(report.totals.handwritten).toBe(2);
    // Also through the file reader the verify screen uses (PDF or JSON).
    expect((await certificateFromFile({ name: 'x.pdf', bytes })).claim.evidenceDigest).toBe(cert.claim.evidenceDigest);
    expect((await certificateFromFile({ name: 'x.json', bytes: new TextEncoder().encode(JSON.stringify(cert)) })).signature).toBe(cert.signature);
  });

  it('says so when a PDF has no certificate', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const bytes = await pdf.save();
    expect(await extractFromPdf(bytes)).toBeNull();
    await expect(certificateFromFile({ name: 'plain.pdf', bytes })).rejects.toThrow(/no Inkstone authorship certificate/);
  });

  it('only the exported pages are certified', async () => {
    const d = doc();
    d.addPage();
    d.addStroke(1, hand('c', 50));
    const cert = await createCertificate(d.meta, d.pages, [1]);
    expect(cert.claim.pages.map((p) => p.index)).toEqual([1]);
    expect(cert.claim.totals.handwritten).toBe(1);
  });
});
