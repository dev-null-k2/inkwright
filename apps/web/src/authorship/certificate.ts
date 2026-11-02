import {
  buildClaim, canonicalJson, parseCertificate, signClaim, verifyCertificate,
  type AuthorshipCertificate, type NoteDocument, type NoteMeta, type PageInk, type VerifyReport,
} from '@inkstone/core';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString, decodePDFRawStream } from 'pdf-lib';
import { APP_VERSION } from '../platform/env.ts';
import type { AppVault } from '../lib/vault.ts';
import { deviceSigner } from './keys.ts';

/**
 * Authorship certificates in the app: make and sign one for a note, keep the latest with the note
 * (an asset + `NoteMeta.certificate`), carry one inside exported PDFs (an embedded file), and
 * read one back out of a PDF or JSON file to verify offline. Format: docs/AUTHORSHIP.md.
 */

export const PDF_ATTACHMENT_NAME = 'inkstone-authorship.json';

/** Signs a certificate for a note (all pages, or some) with this device's key. */
export async function createCertificate(note: Pick<NoteMeta, 'id' | 'title'>, pages: readonly PageInk[], pageIndexes?: number[]): Promise<AuthorshipCertificate> {
  const { info, key } = await deviceSigner();
  const { claim, evidence } = buildClaim(note, pages, info, { pageIndexes, generator: `Inkstone ${APP_VERSION}` });
  return signClaim(claim, evidence, key);
}

export function certificateJson(cert: AuthorshipCertificate): string {
  return JSON.stringify(cert, null, 1);
}

/** Signs the note as it is now and keeps the certificate with it (replacing the previous one). */
export async function signAndStore(vault: AppVault, doc: NoteDocument): Promise<AuthorshipCertificate> {
  const cert = await createCertificate(doc.meta, doc.pages);
  const signedAt = Date.parse(cert.claim.created);
  const asset = `authorship-${signedAt}.json`;
  await vault.vault.writeAsset(doc.meta.id, asset, new TextEncoder().encode(certificateJson(cert)));
  doc.updateMeta((m) => ({ ...m, certificate: { asset, signedAt } }));
  return cert;
}

export async function loadStoredCertificate(vault: AppVault, note: NoteMeta): Promise<AuthorshipCertificate | null> {
  if (!note.certificate) return null;
  const bytes = await vault.vault.readAsset(note.id, note.certificate.asset);
  if (!bytes) return null;
  try { return parseCertificate(new TextDecoder().decode(bytes)); } catch { return null; }
}

/** Verifies the note's stored certificate against its current content. */
export async function verifyStored(vault: AppVault, doc: NoteDocument): Promise<{ cert: AuthorshipCertificate; report: VerifyReport } | null> {
  const cert = await loadStoredCertificate(vault, doc.meta);
  if (!cert) return null;
  return { cert, report: await verifyCertificate(cert, doc.pages) };
}

/**
 * Embeds a certificate in a PDF being written: as an attached file (what verifiers read), plus a
 * short line in the document info so tools that list metadata show it.
 */
export async function embedInPdf(pdf: PDFDocument, cert: AuthorshipCertificate): Promise<void> {
  const created = new Date(cert.claim.created);
  // As a data URI: pdf-lib's type checks are realm-sensitive for typed arrays (WebViews, tests).
  const utf8 = new TextEncoder().encode(canonicalJson(cert));
  let bin = '';
  for (let i = 0; i < utf8.length; i += 0x8000) bin += String.fromCharCode(...utf8.subarray(i, i + 0x8000));
  await pdf.attach(`data:application/json;base64,${btoa(bin)}`, PDF_ATTACHMENT_NAME, {
    mimeType: 'application/json',
    description: 'Inkstone authorship certificate (signed). Verify it in Inkstone › Settings › Authorship.',
    creationDate: created,
    modificationDate: created,
  });
  const t = cert.claim.totals;
  // The Info dictionary accessor is internal in pdf-lib's typings; it is the standard PDF /Info.
  (pdf as unknown as { getInfoDict(): PDFDict }).getInfoDict().set(PDFName.of('InkstoneAuthorship'), PDFString.of(`${t.handwritten} handwritten strokes; signed by key ${cert.claim.signer.fingerprint}`));
}

/** The certificate attached to a PDF, or null if it has none. */
export async function extractFromPdf(bytes: Uint8Array): Promise<AuthorshipCertificate | null> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const tree = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  if (!tree) return null;
  const found = findInNameTree(tree);
  if (!found) return null;
  const ef = found.lookupMaybe(PDFName.of('EF'), PDFDict);
  const raw = ef?.lookup(PDFName.of('F')) ?? ef?.lookup(PDFName.of('UF'));
  const stream = raw instanceof PDFRawStream ? raw : null;
  if (!stream) return null;
  const data = decodePDFRawStream(stream).decode();
  return parseCertificate(new TextDecoder().decode(data));
}

const text = (o: unknown) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined);

function findInNameTree(node: PDFDict, depth = 0): PDFDict | null {
  if (depth > 8) return null;
  const arr = node.lookupMaybe(PDFName.of('Names'), PDFArray);
  if (arr) {
    for (let i = 0; i + 1 < arr.size(); i += 2) {
      const spec = arr.lookupMaybe(i + 1, PDFDict);
      if (!spec) continue;
      const name = text(arr.lookup(i)) ?? text(spec.lookup(PDFName.of('UF'))) ?? text(spec.lookup(PDFName.of('F')));
      const fname = text(spec.lookup(PDFName.of('UF'))) ?? text(spec.lookup(PDFName.of('F'))) ?? name;
      if (name === PDF_ATTACHMENT_NAME || fname === PDF_ATTACHMENT_NAME) return spec;
    }
  }
  const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
  if (kids) for (let i = 0; i < kids.size(); i++) {
    const k = kids.lookupMaybe(i, PDFDict);
    const r = k ? findInNameTree(k, depth + 1) : null;
    if (r) return r;
  }
  return null;
}

/** Reads a certificate from a dropped/picked file: a PDF with one attached, or the JSON itself. */
export async function certificateFromFile(file: { name: string; bytes: Uint8Array }): Promise<AuthorshipCertificate> {
  const isPdf = file.bytes[0] === 0x25 && file.bytes[1] === 0x50 && file.bytes[2] === 0x44 && file.bytes[3] === 0x46;
  if (isPdf) {
    const cert = await extractFromPdf(file.bytes);
    if (!cert) throw new Error('This PDF has no Inkstone authorship certificate.');
    return cert;
  }
  return parseCertificate(new TextDecoder().decode(file.bytes));
}
