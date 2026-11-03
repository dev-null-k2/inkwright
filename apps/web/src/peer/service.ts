/**
 * The peer module's background work: while a signalling server is set, answer paired devices
 * that ask to sync through it (this device serves its vault to them). Follows the setting:
 * setting or clearing the server starts or stops listening.
 */
import { listenViaRelay } from './connect.ts';
import { usePeer } from './identity.ts';
import { serveVaultSetup } from './sync.ts';
import { stopLive, useLive } from './collab.ts';
import { cancelLiveCode, useLiveCodes } from './liveCodes.ts';

export function startPeerService(): () => void {
  let ac: AbortController | null = null;
  let url = '';
  const follow = () => {
    const next = usePeer.getState().network.relayUrl.trim();
    if (next === url) return;
    url = next;
    ac?.abort();
    ac = null;
    if (!url) return;
    const mine = new AbortController();
    ac = mine;
    void listenViaRelay({ signal: mine.signal, setup: serveVaultSetup, onLink: () => {} }).catch((e) => console.warn('peer: relay listener stopped', e));
  };
  follow();
  const unsub = usePeer.subscribe(follow);
  return () => {
    unsub();
    ac?.abort();
    // The module was switched off: live sessions end (the notes stay).
    for (const id of Object.keys(useLive.getState().sessions)) stopLive(id);
    for (const id of Object.keys(useLiveCodes.getState())) cancelLiveCode(id);
  };
}
