/**
 * This device on the peer link: its identity key, its name, the devices it is paired with, and
 * how it reaches them (docs/COLLABORATION.md).
 *
 * The identity key is an X25519 key pair made with WebCrypto as **non-extractable**: the private
 * half can be used for key agreement but never read out by any script, Inkstone's included. Like
 * the authorship key, the CryptoKey object itself lives in IndexedDB (stored opaquely by the
 * browser; app-private storage on Android). Paired devices are remembered by their *public*
 * keys only, in local storage, and can be removed at any time — a removed device can no longer
 * connect, because its key is no longer accepted.
 */
import { create } from 'zustand';
import { generateKeyPair, keyFingerprint, x25519Supported, type DeviceInfo, type KeyPair } from '@inkstone/sync';
import { fromBase64Url, newId, toBase64Url } from '@inkstone/core';
import { safeStorage } from '../platform/env.ts';
import { useSettings } from '../state/settings.ts';
import { getSecret, setSecret } from '../lib/secrets.ts';

const DB = 'inkstone-peer';
const STORE = 'keys';

export interface PairedDevice {
  id: string;
  name: string;
  /** Identity public key, base64url. */
  key: string;
  fingerprint: string;
  pairedAt: number;
  lastSync?: number;
}

export interface PeerNetwork {
  /** STUN servers (one URL per line); empty for LAN only. */
  stun: string[];
  /** Optional TURN relay for networks where direct connections fail. */
  turn: { url: string; username: string } | null;
  /** Optional self-hosted signalling relay (apps/mcp-server --signal-token). */
  relayUrl: string;
}

interface PeerStored {
  deviceId: string;
  paired: PairedDevice[];
  network: PeerNetwork;
}

/** Google's public STUN server: only tells each device its public address; sees no content. */
export const DEFAULT_STUN = ['stun:stun.l.google.com:19302'];

const KEY = 'inkstone.peer.v1';

const NETWORK_DEFAULTS: PeerNetwork = { stun: DEFAULT_STUN, turn: null, relayUrl: '' };

function load(): PeerStored {
  try {
    const v = JSON.parse(safeStorage.get(KEY) ?? 'null') as PeerStored | null;
    if (v && typeof v.deviceId === 'string' && Array.isArray(v.paired)) return { ...v, network: { ...NETWORK_DEFAULTS, ...v.network } };
  } catch {
    /* fall through */
  }
  return { deviceId: newId(), paired: [], network: { ...NETWORK_DEFAULTS } };
}

export const usePeer = create<PeerStored>(() => load());
usePeer.subscribe((s) => safeStorage.set(KEY, JSON.stringify(s)));

export function setNetwork(patch: Partial<PeerNetwork>): void {
  usePeer.setState((s) => ({ network: { ...s.network, ...patch } }));
}

export function rememberDevice(d: Omit<PairedDevice, 'pairedAt'>): void {
  usePeer.setState((s) => ({ paired: [...s.paired.filter((p) => p.key !== d.key), { ...d, pairedAt: Date.now() }] }));
}

/** Removes a paired device: its key is no longer accepted for syncing. */
export function forgetDevice(key: string): void {
  usePeer.setState((s) => ({ paired: s.paired.filter((p) => p.key !== key) }));
}

export function pairedByKey(key: string): PairedDevice | undefined {
  return usePeer.getState().paired.find((p) => p.key === key);
}

export function markSynced(key: string): void {
  usePeer.setState((s) => ({ paired: s.paired.map((p) => (p.key === key ? { ...p, lastSync: Date.now() } : p)) }));
}

// ---- Identity key -----------------------------------------------------------------------------

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const t = open.result.transaction(STORE, mode);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(r.result);
      t.onerror = () => reject(t.error);
    };
  });
}

export interface Identity {
  key: KeyPair;
  info: DeviceInfo;
  fingerprint: string;
  /** False when IndexedDB is unavailable: the key lasts this session only, and pairing won't survive a reload. */
  persistent: boolean;
}

let identity: Promise<Identity> | null = null;

/** This device's identity, made on first use. */
export function deviceIdentity(): Promise<Identity> {
  identity ??= (async () => {
    if (!(await x25519Supported())) throw new Error('This browser can’t make X25519 keys. Update it to pair devices (Chrome 133, Firefox 130, Safari 17 or newer).');
    let key: KeyPair | null = null;
    let persistent = true;
    try {
      const stored = await idb<{ privateKey: CryptoKey; publicRaw: string } | undefined>('readonly', (s) => s.get('identity'));
      if (stored?.privateKey) key = { privateKey: stored.privateKey, publicRaw: fromBase64Url(stored.publicRaw) };
      if (!key) {
        key = await generateKeyPair();
        await idb('readwrite', (s) => s.put({ privateKey: key!.privateKey, publicRaw: toBase64Url(key!.publicRaw) }, 'identity'));
      }
    } catch {
      key ??= await generateKeyPair();
      persistent = false;
    }
    const fingerprint = await keyFingerprint(key.publicRaw);
    return { key, fingerprint, persistent, info: { id: usePeer.getState().deviceId, name: deviceName(), key: toBase64Url(key.publicRaw) } };
  })();
  return identity.then((i) => ({ ...i, info: { ...i.info, name: deviceName() } }));
}

/** The name people see for this device (Settings › Authorship's device name, or a plain default). */
export function deviceName(): string {
  return useSettings.getState().authorship.deviceName.trim() || 'Inkstone device';
}

/** A short, stable id for a peer's key, used as `author.id` on what they write. */
export function shortKeyId(fingerprint: string): string {
  return fingerprint.replace(/\s+/g, '').slice(0, 8).toLowerCase();
}

// ---- Secrets: TURN credential and relay token stay in the encrypted secret store ---------------

export const getTurnCredential = () => getSecret('peer.turn');
export const setTurnCredential = (v: string | null) => setSecret('peer.turn', v);
export const getRelayToken = () => getSecret('peer.relay');
export const setRelayToken = (v: string | null) => setSecret('peer.relay', v);

/** ICE servers for RTCPeerConnection from the settings (STUN, plus TURN when set). */
export async function iceServers(): Promise<RTCIceServer[]> {
  const n = usePeer.getState().network;
  const out: RTCIceServer[] = [];
  if (n.stun.length) out.push({ urls: n.stun });
  if (n.turn?.url) out.push({ urls: n.turn.url, username: n.turn.username, credential: (await getTurnCredential()) ?? '' });
  return out;
}
