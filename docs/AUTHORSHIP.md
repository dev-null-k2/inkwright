# Proof of authorship

Inkwright can show that a note was written by hand on a particular device, and which parts were
not: AI answers, solved results, recognized text, imported files, pasted ink. It is meant for
students handing in handwritten work and for signed agreements. This page describes what is
recorded, the certificate format, how verification works, and — just as important — what it does
not prove.

Reference implementation: `packages/core/src/authorship.ts` (chain, classification, certificates,
verification, no platform code), `packages/core/src/sha256.ts`, and in the app
`apps/web/src/authorship/` (device key, PDF embedding, the panels).

## What is recorded

**How every stroke was made.** Each point already carries position, time since pen-down,
pressure, tilt and azimuth (`InkPoint`). A stroke written in Inkwright also records its input:
`"input": "pen" | "touch" | "mouse"` (set by the ink engine at pen-up; strokes from older
versions or created by code have none).

**Where non-handwritten content came from.** Strokes, text boxes and images may carry
`"origin"`: `ai` (written by an AI model: assistant text, AI ink), `solver` (computed on the
device), `recognized` (machine transcription of the user's own handwriting), `import` (brought
in from a file). Page objects — tables, solved results, graphs — are machine-made by
definition (`MathObject.origin` is `solver`, or `ai` when an AI read the handwriting).
Imported PDF/image page backgrounds are imports.

**A per-page hash chain.** Every edit committed to a page (the single funnel is
`NoteDocument.commit`, plus undo/redo and automatic follow-ups) appends events to
`PageInk.authorship`:

```jsonc
"authorship": { "v": 1, "events": [
  { "op": "+", "k": "s", "id": "01J…", "d": "q0Zt…", "t": 1730000000000, "how": "draw", "dev": "3f2a9c1b" },
  { "op": "-", "k": "s", "id": "01J…", "d": "q0Zt…", "t": 1730000004000 },
  { "op": "+", "k": "s", "id": "01K…", "d": "Xa9p…", "t": 1730000004000, "how": "edit", "from": "01J…" }
] }
```

| Field | Meaning |
|---|---|
| `op` | `+` the item was added to the page, `-` removed |
| `k` | item kind: `s` stroke, `t` text box, `i` image, `o` page object |
| `id` | the item's id |
| `d` | digest of the item's exact saved content: the first 16 bytes of SHA-256 over its canonical JSON (strokes in their compact on-disk encoding, so the digest survives a save/load), base64url |
| `t` | wall-clock time of the edit (epoch ms) |
| `how` | `draw` (written by hand: the engine's pen-up), `edit` (made from `from`: moved, resized, recoloured, partly erased, retyped), `copy` (pasted or duplicated), `undo`, `redo`, `other` |
| `from` | for `edit`: the item it came from |
| `dev` | short id of the signing key of the device that recorded it (first 8 hex digits of its fingerprint) |

The chain head is `h₀ = SHA-256("inkwright.chain/1:" + pageId)`,
`hᵢ₊₁ = SHA-256(hᵢ ‖ UTF-8(canonical JSON of eventᵢ))`. Canonical JSON = keys sorted, no
whitespace, `undefined` omitted. Changing, removing or reordering any event changes every later
head.

**Which strokes count as handwriting.** Replaying the chain gives each live item its *root*:
`draw`, or for edits the root of what it was made from (so moving a word or erasing part of it
keeps it handwriting), for undo/redo the root it had before. A stroke counts as **handwritten**
only if its root is `draw`, it has an `input`, its content digest matches the chain's record,
and it has no `origin`. Pasted ink is *copied*; strokes the chain does not account for (written
before this feature, by another app, or edited in the file by hand) are *unattested*. Nothing
AI-made, solved, recognized or imported can ever be counted as handwriting.

**Sync.** Two devices editing the same page offline produce two chains; the three-way merge
(`packages/sync/src/merge.ts`) unions their events and orders them by time. The merged chain has
a new head, so a certificate signed before the merge reports "history merged from another
device" when compared with the current note; it still verifies on its own evidence.

**Live collaboration.** In a live session ([COLLABORATION.md](COLLABORATION.md)) a
collaborator's edits are committed with an `author` (`NoteDocument.commit(…, { author })`): the
receiving device stamps `"author": { "id", "name" }` on every stroke and text box the edit adds —
never trusting the sender's claim — records `"by": "<author id>"` on the chain events, and keeps
those edits off the local undo stack. Classification checks `author` first: such an item counts
as `collaborator` (a new, optional count, present only when non-zero so older certificates keep
verifying) and never as handwriting, whatever its root, input or origin. Anything a collaborator
changes — even one of your own strokes, moved — becomes theirs: the count can only err on the
side of claiming less as yours.

## The device key

`apps/web/src/authorship/keys.ts`: an ECDSA P-256 key pair made with WebCrypto with
`extractable: false` — the private key can sign but cannot be read out by any script, including
Inkwright's. The `CryptoKey` objects are stored in IndexedDB (`inkwright-authorship`), which
browsers keep opaquely; in the Android app this is the WebView's app-private storage, the same
place the existing secret store keeps its wrapping key. Settings › Privacy & trust › Authorship shows the public
key's **fingerprint** — SHA-256 of the uncompressed public point (`04 ‖ x ‖ y`), first 10 bytes as
five groups of hex (`3F2A 9C1B 0D44 7E10 52AA`) — and an optional, self-chosen name.

Clearing the app's data deletes the key. Old certificates keep verifying (they carry their public
key); new ones get a new fingerprint. Without IndexedDB (private windows, the claude.ai preview)
a session-only key is used and the UI says so.

## Certificates

A certificate is one JSON document, `format: "inkwright.authorship/1"`. The terms follow
[C2PA content credentials](https://c2pa.org/specifications/): a **claim** containing
**assertions** about the content, a **claim signature**, and the evidence it refers to.

```jsonc
{
  "format": "inkwright.authorship/1",
  "claim": {
    "generator": "Inkwright 1.0.0",                       // C2PA claim_generator
    "created": "2026-11-14T15:02:11.000Z",
    "subject": { "noteId": "01J…", "title": "Signals homework 4" },
    "signer": { "alg": "ES256", "publicKey": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
                "fingerprint": "3F2A 9C1B 0D44 7E10 52AA", "name": "Ada (self-named)" },
    "pages": [{
      "pageId": "01J…", "index": 0,
      "chain": { "head": "base64url SHA-256", "length": 412 },
      "counts": { "handwritten": 380, "penWithPressure": 380, "touch": 0, "mouse": 0, "copied": 2,
                  "aiInk": 0, "unattested": 0, "typedText": 1, "aiText": 0, "importedText": 0,
                  "recognizedText": 0, "importedImages": 0, "aiImages": 0, "importedPages": 0, "objects": 1 },
      "rhythm": { "firstAt": 1730000000000, "lastAt": 1730003600000, "inkMs": 1260000, "sessions": 1,
                  "pauseMedianMs": 420, "pauseP90Ms": 2900, "speedMean": 182.4, "speedCv": 0.61,
                  "pressureMean": 0.47, "pressureSd": 0.12, "tiltShare": 1 }
    }],
    "totals": { … },                                      // sum of the pages' counts
    "actions": [                                          // C2PA c2pa.actions, with IPTC digital source types
      { "action": "c2pa.created", "digitalSourceType": "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation", "count": 380, "description": "Handwriting written in Inkwright" },
      { "action": "c2pa.created", "digitalSourceType": "http://cv.iptc.org/newscodes/digitalsourcetype/algorithmicMedia", "count": 1, "description": "Tables, solved results, graphs and recognized text made by the app" }
    ],
    "evidenceDigest": "base64url SHA-256 of canonical evidence"
  },
  "evidence": { "pages": [{ "pageId": "01J…", "events": [ … ], "strokes": [ … ], "texts": [ … ], "images": [ … ], "objects": [ … ], "background": { … } }] },
  "signature": "base64url ECDSA P-256 / SHA-256 signature (IEEE P1363 r‖s) over UTF-8 canonical JSON of claim"
}
```

The evidence is the signed pages' full content (strokes in the compact vault encoding, so a
verifier can redraw the signed ink) and their complete chains. Image *bytes* are not included,
only their entries.

**Where certificates live.** Editor › ••• › Share & export › Authorship › *Sign certificate* signs the note as it
is and stores the certificate with it as `notes/<id>/assets/authorship-<signedAt>.json`, recorded
in `note.json` as `"certificate": { "asset", "signedAt" }` (the latest one). *Download
certificate* saves the JSON. PDF exports (unless turned off in Settings › Privacy & trust › Authorship) sign a fresh
certificate for the exported pages and embed it as an attached file named
`inkwright-authorship.json` (`/EmbeddedFiles`, MIME `application/json`), plus a one-line
`/InkwrightAuthorship` entry in the document info.

## Verifying

`verifyCertificate(cert, currentPages?)` runs offline, anywhere WebCrypto exists (the app,
Node 20+). Settings › Privacy & trust › Authorship › *Verify a certificate* accepts an exported PDF (the attachment
is read with pdf-lib) or a `.json`. It checks, in order:

1. **Signature:** the claim's canonical JSON verifies against the public key in the claim.
2. **Fingerprint:** the fingerprint shown is the one of that key (so a reader can compare it with
   one the writer shared through another channel).
3. **Evidence:** SHA-256 of the canonical evidence equals the signed `evidenceDigest`.
4. **Chains:** each page's events hash to its signed head and length.
5. **Content vs. history:** every signed stroke, text, image and object has the digest the chain
   recorded for it.
6. **Counts:** recomputing the classification from the evidence gives the signed counts.

Any failure makes the certificate **not valid**. With the current note (the editor panel), it
also reports what changed since signing — items added, removed or edited — and whether the
signed history is still a prefix of the current one ("the earlier history is intact"). The
verify screen also draws the signed ink, so a reader can compare it with the PDF's pages.

Tamper cases covered by tests (`packages/core/test/authorship.test.ts`,
`apps/web/e2e/smartink.spec.ts`): editing the claimed counts, moving a point of the signed ink,
rewriting or dropping chain events, swapping in another key, and edits made in the app after
signing.

## What this proves — and what it doesn't

It **does** show:

- the signed writing and its complete edit history are exactly what this device's key signed,
  and nothing in them was changed afterwards;
- the history is consistent: every stroke counted as handwriting was drawn with a pen, finger or
  mouse in Inkwright, with its pressure, tilt and timing, and was never pasted;
- AI answers, solved results, recognized text and imported files are labelled and not counted as
  handwriting;
- when and how long the writing happened, and its rhythm (pauses, speed and its variation,
  pressure).

It **does not** show:

- *who* held the pen — the key belongs to a device, and the name in a certificate is whatever was
  typed;
- that the handwriting wasn't **copied by hand** from an AI's (or anyone's) answer. A determined
  person can trace or transcribe. Writing time and rhythm are evidence a reader can weigh (copying
  tends to be slow and even), not proof;
- that the PDF's pages are untouched: the certificate travels inside the PDF but does not seal the
  PDF's bytes. Compare the pages with the signed ink the verifier draws;
- anything about content made on a device with a modified app — a signature proves integrity
  relative to a key, not that the software holding the key is honest.

## Future work

- **C2PA export.** The claim maps onto a C2PA manifest (`c2pa.actions` with IPTC digital source
  types are already used; the chain and counts would become custom `inkwright.*` assertions). A
  real C2PA manifest needs a JUMBF box and COSE signature in the PDF, and an X.509 certificate
  chain instead of a bare device key; until then the JSON certificate is Inkwright-specific.
- Hardware-backed keys (Android Keystore / StrongBox attestation) so a verifier could see the key
  never left secure hardware.
- Timestamping the chain head with an RFC 3161 time-stamp authority while writing, so the writing
  time is attested by a third party rather than the device clock.
