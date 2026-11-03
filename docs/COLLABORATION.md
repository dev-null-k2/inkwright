# Devices and people, writing together

Inkwright can sync your devices with each other and let several people write on one page at the
same time — without a server of ours. This page says exactly what is peer-to-peer, what still
needs a helper on the network, where it can fail, and what the encryption protects against.

Reference implementation:

| Part | Where |
|---|---|
| Encryption, framing, handshake, RPC, the peer `Remote` | `packages/sync/src/peer/` |
| Short codes: CPace, code format and lockout, the rendezvous protocol and relays | `packages/sync/src/peer/{cpace,shortcode,rendezvous}.ts` |
| Live-collaboration CRDT and its bridge to `NoteDocument` | `packages/core/src/collab.ts` |
| WebRTC, pairing, device sync and live sessions in the app | `apps/web/src/peer/` |
| Short codes in the app: relay choice, links, the share, pair and join sheets | `apps/web/src/peer/{shortcode,liveCodes,joinStash}.ts`, `CodeSheets.tsx` |
| Optional self-hosted relay | `apps/mcp-server/src/signal.ts` (`inkwright-mcp --signal-token`) |
| Tests | `packages/sync/test/{peer,shortcode}.test.ts`, `packages/core/test/collab.test.ts`, `apps/mcp-server/test/{signal,rendezvous}.test.ts`, `apps/web/src/peer/shortcode.test.ts`, `apps/web/e2e/peer.spec.ts` |

Both features are the **Devices & live sharing** module (Settings › Extend › Modules) and can be switched
off; the vault keeps everything they wrote.

## What you can do

Everything starts with **one short code, passed one way**: eight letters and digits like
`K7PM-2Q9X`, with a QR code and a link next to it. The other person types the code, scans the QR
code (any phone camera opens the link), or taps the link you sent — and they are connected. No
code comes back.

- **Share a page live** — Editor › ••• › Share & export › *Share live* shows a code at once, with
  *Send link* (the Android share sheet, or Web Share in browsers: WhatsApp, Messages, mail…) and
  *Can write* / *Can view*, which you can change until someone joins. The other person chooses
  *Join with a code* (Settings › Sync & devices › Devices & sharing, or the search palette) or opens
  the link. Your sheet says "Priya joined" and lists who is in. Strokes appear as they are being
  drawn, cursors show where everyone is (name and a calm colour), and edits made at the same
  moment on different devices never conflict. *Invite someone else* makes the next code. A guest's
  copy is an ordinary note in their own vault; when the session ends it stays, like a photocopy.
- **Pair a device** — Devices & sharing › *Pair a device* shows a code; on the other device,
  *Join with a code*, enter it, and confirm "Pair with “Laptop”?" (pairing lets the devices sync
  everything, so the joining device always asks). Both devices then remember each other's public
  key and show the same six digits; *Remove* forgets a device.
- **Sync two devices directly** — *Sync now* next to a paired device. With a self-hosted relay
  (below) it happens by itself while Inkwright is open on both; otherwise it shows a short code to
  enter on the other device. The sync is the same engine as Google Drive or WebDAV sync, with the
  same three-way merge of ink and text, conflict copies for images, and the same safety stops (an
  empty or wiped device is never mistaken for "delete everything").
- **Without any relay** — *Advanced* (in the share sheet and in Devices & sharing) keeps the
  original long codes: one device shows an offer, the other shows an answer back, as QR codes or
  pasted text. Nothing but the two devices is involved.

## What is peer-to-peer, and what is not

| Step | How | Needs a server? |
|---|---|---|
| Finding each other's addresses | ICE with **STUN** (default `stun:stun.l.google.com:19302`, configurable, can be empty) | A STUN server sees the devices' public IP addresses, nothing else. Empty STUN list: same network only. |
| Meeting by short code (signalling) | A **relay**: [ntfy.sh](https://ntfy.sh) by default, your own ntfy server, or `inkwright-mcp --signal-token` | Yes — but it sees a hashed room name, PAKE values that reveal nothing, and sealed messages (below). |
| … or by long codes (Advanced) | QR codes or pasted text, in both directions | **No.** You are the signalling channel. |
| Paired devices finding each other by themselves | A **relay you run**: `inkwright-mcp --http <port> --signal-token <secret>` | Yes, but it only ever holds sealed, unlinkable messages (below). |
| The connection itself | WebRTC data channel (SCTP over DTLS over UDP), device to device | No — unless the network blocks it (next section). |
| Your notes and strokes | End-to-end encrypted on top of DTLS | Never pass through anything that can read them. |

## NAT traversal: when devices can't reach each other

WebRTC tries, in order: the devices' local addresses (same network), then their public addresses
learned from STUN (most home routers and many mobile networks allow this "hole punching"). **Some
networks do not**: symmetric NATs (common on carrier-grade mobile networks and some corporate
networks), firewalls that block UDP, captive portals. Without a TURN server, two devices on such
networks **cannot connect at all**; Inkwright then says so ("The devices could not reach each
other…") instead of pretending.

The fix is a **TURN relay**, which forwards the (still encrypted) traffic. Inkwright does not run
one. To use your own — for example [coturn](https://github.com/coturn/coturn) on a small VPS:

```
# /etc/turnserver.conf (minimal)
listening-port=3478
fingerprint
lt-cred-mech
user=inkwright:<a long random password>
realm=turn.example.com
```

Then in Settings › Sync & devices › Devices & sharing › Network set *TURN server* to
`turn:turn.example.com:3478` (or `turns:…:5349` with TLS), the username and the credential (kept in
the encrypted secret store, never in the vault). A TURN relay sees connection metadata (which IP
addresses talk, when, how much) and ciphertext; it cannot read or alter content (see the threat
model). Managed TURN services (Twilio, Cloudflare Calls, Metered) work the same way.

## Short codes: how a few characters are enough

A WebRTC connection needs both devices' session descriptions (about a kilobyte each), and the
end-to-end encryption needs both devices' keys. A short code can't carry those, and a short
secret sent as a hash would be guessed offline in milliseconds by whoever relays it. So the code
is used as the password of a **PAKE** (password-authenticated key exchange), and everything
else travels through a relay, sealed under the key the PAKE produces.

**The code.** Eight characters of Crockford's base 32 (digits and capitals without I, L, O and
U; when typing, case, spaces and dashes don't matter, `O` reads as `0`, `I` and `L` as `1`). The
first three are the **nameplate** (15 bits): they only choose where to meet. The relay room is
`iw1` + SHA-256("inkwright.rendezvous.v1 " + nameplate), so the relay never sees the typed
characters — but anyone can compute a room from three characters, and the design does not rely
on the nameplate being secret. The last five are the **password** (25 bits); they never leave
the device. Before showing a code, the host checks that its room was unused for ten minutes and
posts an opaque claim, so two codes rarely share a room (and if they do, each host still accepts
only its own code).

**The exchange** (`packages/sync/src/peer/rendezvous.ts`):

```
guest → room   a: sid, Ya                               (CPace share; sid = 16 random bytes)
host  → room   b: sid, Yb, tagHost, seal(offer)         (counts one attempt)
guest          checks tagHost — a wrong code stops here (and tells the host at once)
guest → room   c: sid, tagGuest, seal(answer)
host           checks tagGuest — the code is now used up; the host stops listening
then           WebRTC device to device, and the Noise handshake below with psk = K(ISK)
```

- **CPace** (draft-irtf-cfrg-cpace-12, ristretto255 and SHA-512, `cpace.ts`): the generator is
  derived from the password, the channel identifier (protocol label and room) and the session id;
  each side sends one group element and both derive the intermediate session key **ISK**. We
  chose CPace because the IRTF CFRG selected it as the recommended balanced PAKE, it has a
  security proof without a trusted setup, and it is small. SPAKE2 needs two fixed points with
  unknown discrete logs, which RFC 9382 does not define for ristretto255; OPAQUE is for
  client/server, not two equal devices. No vetted JavaScript CPace library exists, so `cpace.ts`
  composes audited primitives — `@noble/curves` (ristretto255 and RFC 9496 element derivation;
  independently audited by Cure53 in 2024, whose scope included ed25519, its add-ons and
  hash-to-curve, and by Trail of Bits in 2023) and `@noble/hashes` (Cure53, 2022); both are pinned
  to exact versions — and its tests reproduce the
  draft's published test vectors (generator, both shares, K, ISK and the session-id output).
- **Key confirmation**: each side proves it holds the same ISK with an HMAC tag that differs per
  role, before anything else is used.
- **Everything else is sealed** with AES-256-GCM under keys derived from ISK: the host's offer
  and the guest's answer are the same offers and answers as the long codes, with identity keys,
  ephemeral keys and the SDP including the **DTLS fingerprints**.
- **Bound to the peer link**: the offer's pairing secret is not sent at all (`auth: 'pake'`);
  both devices derive it from ISK. It goes into the Noise handshake's key schedule and the
  answer's MAC, and the transcript hashed into the session keys contains both SDPs. A relay that
  swaps an SDP, a key or a PAKE value gets different keys, and the link fails to open.
- **One-time, ten minutes, five tries.** The host counts every attempt it answers — answering is
  what lets a guesser test a guess — and locks the code after five; a code expires after ten
  minutes and is used up by the first guest who proves it. Each attempt gets its own WebRTC
  offer, closed when the attempt fails.

**Guessing bound.** CPace gives an active attacker one guess per attempt and a passive one none
(the shares are uniformly random group elements). With 25 bits and five attempts, the chance
of getting into someone's live code is at most 5 / 2²⁵ ≈ **1.5 × 10⁻⁷** per code, within its
ten minutes. Offline guessing from what the relay saw is not possible.

### Which relay, and why ntfy.sh

The relay must be reachable from a browser and an Android WebView, free, and need no account —
and since it learns almost nothing, its job is availability. We compared:

| Option | For | Against |
|---|---|---|
| **ntfy** ([ntfy.sh](https://ntfy.sh), open source, self-hostable) | Plain HTTPS: publish is a CORS "simple request", subscribe is one streaming `GET /<topic>/json`; caches messages so a reconnect with `since=` loses nothing; one Go binary to self-host | One operator for the public instance; per-IP rate limits; 4 KB messages |
| PeerJS cloud server | Built for WebRTC signalling | Its protocol registers peer ids; the public server is often overloaded; messages to a peer that isn't connected yet are dropped |
| Nostr relays | Many independent relays | Every event must be signed (Schnorr/secp256k1); relays differ in policy (ephemeral kinds, proof of work, auth), so behaviour is unpredictable |
| Public MQTT brokers over WSS (EMQX, HiveMQ, Mosquitto) | Simple pub/sub | Offered explicitly for testing only; needs an MQTT client |
| Public WebSocket echo/relay services | Simple | No guarantees, most are demos |

So Inkwright uses **ntfy.sh** by default, through `NtfyTransport`: room names are topics, every
message is one JSON envelope (fragmented under 3,000 characters, inside ntfy's limit), publishing
retries rate limits and server errors with backoff (honouring `Retry-After`), and subscriptions
resume from the last message id after a drop. Settings › Sync & devices › Devices & sharing ›
Network › *Relay for short codes* takes any ntfy server — run your own with the official
`binwiederhier/ntfy` image — or nothing (then only the long codes work). If a **self-hosted
`inkwright-mcp` relay** is set there too, short codes use it instead (`MailboxTransport`).

A link names the host's relay when it is not the default (`#join=K7PM-2Q9X&ntfy=…`, or
`&relay=…&token=…` for a self-hosted mailbox), so a guest reaches the same relay without
changing settings; it is used for that join only and never saved, and only `https` relays (or
`http` to this computer) are accepted. The code is in the URL **fragment**, which browsers do not
send to the server hosting the app. On Android the link opens the hosted web app
(`dev-null-k2.github.io/inkwright/app/`), or the code can be typed in the app.

## Signalling without a server — and with one you run

**No server (Advanced).** The device that starts a connection shows an *offer* code; the other device
answers with an *answer* code. Each code carries a complete WebRTC session description with all
its ICE candidates (non-trickle: each side waits up to 3 s for candidates), the device's identity
key, a fresh ephemeral key and a nonce — and, for pairing and invites, a one-time secret.
`ink1:` codes are deflate-compressed base64url JSON and fit a QR code (typically 0.8–1.5 KB);
offers expire after ten minutes and can be used once.

**Your own relay (optional).** `inkwright-mcp --http 8765 --signal-token "$(openssl rand -hex 16)"`
adds `/signal/v1` to the MCP server's HTTP port: a mailbox you `POST` sealed messages to and
long-poll with `GET ?after=<seq>`. Set the URL and token in Settings › Sync & devices › Devices & sharing ›
Network on every device. Then *Sync now* posts the offer to the other paired device's mailbox and
waits for its answer; a device with Inkwright open answers paired devices by itself. The relay:

- uses its **own token** — it opens a mailbox, never the vault;
- sees **room names derived from secrets only the two devices hold** (HKDF of their X25519
  shared secret), so it can't tell which devices talk;
- stores **sealed bytes only** (AES-GCM with a key from the same secret), at most 16 per room,
  for ten minutes, in memory;
- can **drop or delay** messages (that fails a connection), but cannot read, forge or redirect
  one: a forged message doesn't open, and the session keys need the devices' private keys.

## End-to-end encryption

WebRTC's DTLS already encrypts the channel, but DTLS keys are only as trustworthy as the session
descriptions that carried their fingerprints — and those may travel through a relay or a TURN
server. So every message is encrypted again, with keys only the two devices can compute.

**Keys.** Each device has an **identity key**: X25519, generated with WebCrypto as
*non-extractable* (scripts — Inkwright's included — can use it but never read it out), stored in
IndexedDB. Its fingerprint (SHA-256, first 10 bytes) is shown in Settings. Each connection adds
an **ephemeral** X25519 key per side.

**Handshake** (Noise KK pattern, without Noise's message framing):

```
ikm  = DH(eI, eR) ‖ DH(eI, sR) ‖ DH(sI, eR) ‖ DH(sI, sR) ‖ psk?
salt = SHA-256(transcript)        transcript = offer (minus psk) + answer (minus mac), SDP included
kI→R = HKDF-SHA-256(ikm, salt, "inkwright.peer.v1 initiator->responder")
kR→I = HKDF-SHA-256(ikm, salt, "inkwright.peer.v1 responder->initiator")
sas  = HKDF(…, "sas") → six digits shown on both screens after pairing
```

- `psk` is the **one-time pairing secret** from the QR code (pairing and live invites). The answer
  carries `mac = HMAC(HKDF(psk), transcript)`, so the inviting device rejects an answer from
  anyone who didn't see the code before connecting.
- Paired devices reconnect without a secret: they accept only each other's remembered identity
  keys, and only holders of the matching private keys derive the session keys.
- The SDP — with the DTLS certificate fingerprints — is part of the transcript: swapping it
  changes the keys.

**Messages.** AES-256-GCM, one key per direction; the 96-bit nonce is the message's sequence
number, which is also in the associated data. Each side accepts sequence numbers strictly in
order, once, so replayed, dropped, reordered or altered messages fail and close the link. A
sealed message is cut into ≤ 16 KiB frames (12-byte header: version, sequence number, chunk
index and count) and reassembled before it is opened; messages above 128 MiB are refused. The
first message each way is a `hello` (key confirmation): different keys never get past it. The
answering device sends its hello only after the first one arrives.

### Threat model

| Adversary | Can | Cannot |
|---|---|---|
| Someone on the network, a STUN server | see that two IP addresses exchange encrypted UDP | read or change anything |
| A TURN relay | see and drop or delay ciphertext, timing and sizes | read, forge or replay messages; learn the keys |
| A signalling relay (yours, or a compromised one) | see that sealed messages are posted to unlinkable rooms; drop or delay them | read offers or answers; swap in its own keys (the transcript, the pairing secret and the identity keys all go into the session keys) |
| A short-code relay (ntfy.sh, yours, or a compromised one) — or anyone who posts to its rooms | see a hashed room name, when a code is used, IP addresses and message sizes; make **one guess per attempt** (≤ 5 per code: ≤ 1.5 × 10⁻⁷ to succeed); lock a live code with five wrong guesses or drop messages (denial of service) | learn the code or test guesses offline; read the offer, answer, note title or names; swap SDPs or keys unnoticed (the link fails to open) |
| Anyone who sees the code or link before your guest uses it (a group chat, over a shoulder) | join instead of the person you meant, within its ten minutes | do so unnoticed — the sheet shows who joined and their device's name; *Stop sharing* ends it. Send the code only to that person |
| Someone who photographs a pairing QR code within its ten minutes | answer it before you do: the device that showed it accepts the first valid answer | do so unnoticed — the answering device's name is shown, and the six-digit code then differs from the one on your other device. Compare it when it matters. |
| A paired device | sync your whole vault (that is what pairing means) | anything after you *Remove* it: its key is no longer accepted |
| A live-session guest with *can view* | see the note and its live strokes | change it: the host ignores their edits (and their device rolls them back) |
| A live-session guest with *can write* | change the shared note | change anything else in your vault, or make their writing count as yours (below) |
| Someone with your unlocked device | everything the app can do | read the identity private key out through the app (non-extractable), though they can use it while the browser profile is theirs. A copy of the profile's files does contain it (IndexedDB stores the key bytes), which is why the Android app allows no cloud backup |

**Not protected:** metadata (who connects to whom, when, how much — visible to STUN/TURN/relay
operators at the IP level; the short-code relay additionally sees when codes are made and used); availability (any relay can refuse service); a compromised device or
browser (end-to-end encryption protects the path, not the ends). Forward secrecy holds per
connection (ephemeral keys); if an identity key leaks, past sessions stay sealed, but the holder
could impersonate that device until it is removed.

## Live collaboration: why not Yjs, Loro or Automerge

We compared a general-purpose CRDT library with modelling what Inkwright's pages already are.

- **Yjs / Loro / Automerge** shine on text with character-level concurrent edits, nested maps and
  lists, and long histories. Using one would mean a second document model next to the vault's
  page files, a binary update log to persist and sync, mapping every `NoteDocument` edit into it
  and back, and a dependency of 50–300 KB (Loro and Automerge ship WebAssembly).
- **A page is a set of immutable-ish items with ids.** Strokes are never edited in place — moving,
  recolouring or partly erasing produces a replacement (same id) or new items; text boxes are
  replaced whole when you finish typing; page objects likewise. Concurrent character-level text
  editing inside one box is not a goal.

So `packages/core/src/collab.ts` models a page as a **last-writer-wins register per item id**,
ordered by a **fractional index**: an op is `{ page, kind, id, pos, ver, item | null }`; the
greatest Lamport stamp `ver` wins; positions merge by taking the smallest key; pages are
registers too. Merging is commutative, associative and idempotent, so devices that have seen the
same ops show identical pages regardless of order or duplicates (`collab.test.ts` checks this
under random concurrent drawing, erasing, undo, recolouring, text and page adds with shuffled,
duplicated delivery). It is one file with no dependency, and the vault format is untouched:
the shared state lives only in memory during a session; what lands in the note are ordinary items.

Trade-offs, stated plainly: two people retyping the *same* text box at once — the later one wins
the whole box; strokes, text boxes and page objects (tables, sticky notes…) are shared live, but
images and page backgrounds added *during* a session are not (those already in the note come with
it when you join); a page reordered locally during a session snaps back to the shared order.

**Topology.** The person who shares is the host; each guest connects to the host, which relays
ops, cursors and live ink between guests (a star, so N people need N−1 connections, not N²).
When the host leaves, the session ends.

**Live ink.** While a stroke is being written, its new points go out every 60 ms and the others
draw them with the real pen outline; at pen-up the finished stroke arrives as an op and the live
preview disappears. Cursors are sent at most every 90 ms, in page coordinates.

## Authorship stays honest

A collaborator's stroke is not your handwriting, and must never be counted as such
([AUTHORSHIP.md](AUTHORSHIP.md)):

- Remote edits go through `NoteDocument.commit(…, { author })`. The **receiving** device stamps
  every stroke and text box the edit adds with the collaborator as `author` — whatever the
  sender claimed — and records `by` on the chain events. They are not on your undo stack.
- `classifyPage` counts anything with an `author` as **collaborator** content, before any other
  rule. A forged message claiming "no author" can't turn someone else's ink into yours.
- Anything a collaborator changes — even moving one of your strokes — becomes attributed to
  them. That under-counts your handwriting rather than ever over-counting it.
- A guest's copy marks everything from the host's snapshot as written by the host (or by whoever
  the host says), so joining someone's page never gives you their handwriting either.
- Certificates made before live collaboration keep verifying: the new `collaborator` count is
  only present when it is not zero.

## Device sync over the peer link

The device where *Sync now* was pressed runs its `SyncEngine` with a **`PeerRemote`**: the other
device's vault, served over the encrypted link by `servePeerVault` as a `FolderRemote` whose revs
are content hashes. So:

- the same three-way merge (`packages/sync/src/merge.ts`) applies — two devices that both added
  strokes offline keep both;
- every write is guarded by the rev it was based on; if the person on the other device edits the
  same file mid-sync, the guard fails, the engine re-reads both sides and merges again;
- the same safety stops refuse runs that would delete much of either side;
- sync state is kept per paired device (outside the vault); dot-folders never cross the link.

Each side saves its open note before the run and reloads it afterwards if the other side
changed it.

## Limits

- Both devices must be online and have Inkwright open at the same time (it is peer-to-peer).
  Cloud sync (Drive, WebDAV, a folder) remains the way to sync devices that are never on together.
- Without TURN, some networks can't connect (above).
- X25519 in WebCrypto is required: Chrome/Edge 133+, Firefox 130+, Safari 17+ (and the Android
  WebView that follows Chrome). Older browsers are told to update.
- In a private window the identity key lasts only the session, so pairing does not survive it.
- Scanning QR codes in the app needs the camera barcode reader (`BarcodeDetector`); a phone's own
  camera app opens the join link from the QR code anyway, and the code can always be typed.
- ntfy.sh limits requests per IP address. Many phones behind one carrier or office address can
  hit it; Inkwright retries, and says so plainly if the relay stays busy. A self-hosted ntfy or
  `inkwright-mcp` relay has no such limit.
- Short codes need both devices to reach the same relay; long codes (Advanced) need nothing.
