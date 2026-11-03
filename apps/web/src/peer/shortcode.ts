/**
 * Short codes in the app: which relay they meet through, the links and QR codes that carry them,
 * and the host and guest sides wired to the peer link (connect.ts) — so pairing, syncing and live
 * sharing all work with one eight-character code typed one way (docs/COLLABORATION.md).
 *
 * Relay choice, in order: the self-hosted `inkwright-mcp --signal-token` mailbox when one is set
 * (Settings › Sync & devices › Devices & sharing › Network), otherwise the ntfy server in
 * "Relay for short codes" (ntfy.sh unless changed), otherwise none — then only the long codes
 * under "Advanced" work. A link may name the host's relay so a guest reaches the same one; it is
 * used for that join only and never saved.
 */
import {
  MailboxTransport,
  NtfyTransport,
  RelayClient,
  decodeCode,
  formatShortCode,
  hostShortCode,
  isOffer,
  joinShortCode,
  parseShortCode,
  type HostState,
  type LinkPurpose,
  type PeerOffer,
  type RendezvousTransport,
  type ShortCodeHost,
} from '@inkwright/sync';
import { isNative } from '../platform/env.ts';
import { getRelayToken, usePeer, type PairedDevice } from './identity.ts';
import { startConnection, type PendingOffer } from './connect.ts';
import type { CollabInvite } from '@inkwright/sync';

/** Where links point when this copy of the app has no public address of its own (the Android app). */
export const PUBLIC_APP_URL = 'https://dev-null-k2.github.io/inkwright/app/';

/** A relay named by a link (the host's), for one join. */
export interface LinkRelay {
  kind: 'ntfy' | 'mailbox';
  url: string;
  token?: string;
}

/** The relay this device uses for short codes, or null when none is set up. */
export async function rendezvousTransport(override?: LinkRelay | null): Promise<RendezvousTransport | null> {
  if (override) {
    if (override.kind === 'ntfy') return new NtfyTransport(override.url);
    return new MailboxTransport(new RelayClient({ url: override.url, ...(override.token ? { token: override.token } : {}) }), override.url);
  }
  const n = usePeer.getState().network;
  if (n.relayUrl.trim()) {
    return new MailboxTransport(new RelayClient({ url: n.relayUrl.trim(), getToken: getRelayToken }), n.relayUrl.trim());
  }
  if (n.publicRelay.trim()) return new NtfyTransport(n.publicRelay.trim());
  return null;
}

export const shortCodesAvailable = (): boolean => {
  const n = usePeer.getState().network;
  return !!(n.relayUrl.trim() || n.publicRelay.trim());
};

/** The relay to name in a link: only when it isn't the default every guest already uses. */
async function linkRelay(): Promise<LinkRelay | null> {
  const n = usePeer.getState().network;
  if (n.relayUrl.trim()) {
    const token = await getRelayToken();
    return { kind: 'mailbox', url: n.relayUrl.trim(), ...(token ? { token } : {}) };
  }
  if (n.publicRelay.trim() && n.publicRelay.trim() !== 'https://ntfy.sh') return { kind: 'ntfy', url: n.publicRelay.trim() };
  return null;
}

/**
 * A link that opens Inkwright on the join screen with the code filled in. The code goes in the
 * fragment (`#join=…`), which browsers never send to the web server hosting the app.
 */
export async function joinLink(code: string): Promise<string> {
  const base = isNative || typeof location === 'undefined' || !/^https?:$/.test(location.protocol) ? PUBLIC_APP_URL : `${location.origin}${location.pathname}`;
  const p = new URLSearchParams({ join: formatShortCode(code) });
  const relay = await linkRelay();
  if (relay) {
    p.set(relay.kind === 'ntfy' ? 'ntfy' : 'relay', relay.url);
    if (relay.token) p.set('token', relay.token);
  }
  return `${base}#${p.toString()}`;
}

/**
 * Reads a join link (or a bare code, or a scanned QR code's text). Returns null when it holds no
 * code. Relay URLs must be https (or http to this computer, for development).
 */
export function parseJoin(text: string): { code: string; relay: LinkRelay | null } | null {
  const raw = text.trim();
  const bare = parseShortCode(raw);
  if (bare) return { code: bare.value, relay: null };
  const hash = raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : raw.replace(/^inkwright:\/\/join\/?\??/i, '');
  const p = new URLSearchParams(hash);
  const code = parseShortCode(p.get('join') ?? '');
  if (!code) return null;
  const okUrl = (u: string | null): u is string => {
    if (!u) return false;
    try {
      const x = new URL(u);
      return x.protocol === 'https:' || (x.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(x.hostname));
    } catch {
      return false;
    }
  };
  const ntfy = p.get('ntfy');
  const mailbox = p.get('relay');
  const relay: LinkRelay | null = okUrl(mailbox) ? { kind: 'mailbox', url: mailbox, ...(p.get('token') ? { token: p.get('token')! } : {}) } : okUrl(ntfy) ? { kind: 'ntfy', url: ntfy } : null;
  return { code: code.value, relay };
}

// ---- Host ------------------------------------------------------------------------------------------

export interface CodeAttempt {
  code: string;
  pending: PendingOffer;
  cancel(): void;
}

/**
 * Shows a short code and connects whoever proves it. Each attempt gets its own WebRTC offer,
 * made with that attempt's PAKE key; `accept` completes the one that proved the code.
 */
export async function hostByCode(o: {
  purpose: LinkPurpose;
  /** Read at each attempt, so a permission changed while waiting applies. */
  invite?: () => CollabInvite;
  expect?: PairedDevice;
  /** For live notes, the offer comes from collab.ts (it also starts the session). */
  makeOffer?: (pakePsk: Uint8Array) => Promise<PendingOffer>;
  accept(answerCode: string, pending: PendingOffer): Promise<void>;
  onState(s: HostState): void;
}): Promise<{ host: ShortCodeHost; link: string; relay: string }> {
  const transport = await rendezvousTransport();
  if (!transport) throw new Error('No relay is set up for short codes (Settings › Sync & devices › Devices & sharing › Network).');
  const host = await hostShortCode<CodeAttempt>({
    transport,
    makeOffer: async (pakePsk) => {
      const pending = o.makeOffer ? await o.makeOffer(pakePsk) : await startConnection(o.purpose, { ...(o.invite ? { invite: o.invite() } : {}), ...(o.expect ? { expect: o.expect } : {}), pakePsk });
      return { code: pending.code, pending, cancel: () => pending.cancel() };
    },
    accept: (answerCode, attempt) => o.accept(answerCode, attempt.pending),
    onState: o.onState,
  });
  return { host, link: await joinLink(host.code.value), relay: transport.label };
}

// ---- Guest -----------------------------------------------------------------------------------------

export interface CodeJoin {
  offer: PeerOffer;
  pakePsk: Uint8Array;
  reply(answerCode: string): Promise<void>;
  close(): void;
}

/** Runs the code against its host and returns the host's offer (still to be answered). */
export async function joinByCode(text: string, opts: { relay?: LinkRelay | null; signal?: AbortSignal } = {}): Promise<CodeJoin> {
  const transport = await rendezvousTransport(opts.relay ?? null);
  if (!transport) throw new Error('No relay is set up for short codes. Set one in Settings › Sync & devices › Devices & sharing › Network, or use the long codes under Advanced.');
  const j = await joinShortCode({ transport, code: text, ...(opts.signal ? { signal: opts.signal } : {}) });
  try {
    const offer = await decodeCode(j.offerCode);
    if (!isOffer(offer)) throw new Error('The other device sent something unexpected.');
    return { offer, pakePsk: j.psk, reply: (a) => j.reply(a), close: () => j.close() };
  } catch (e) {
    j.close();
    throw e;
  }
}
