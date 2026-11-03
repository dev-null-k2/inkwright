/**
 * App-wide pieces of the peer and timeline modules: the time travel bar and dialog, and their
 * search-palette actions. Mounted once by the app; each part follows its module's switch.
 */
import { useEffect } from 'react';
import { History, KeyRound, MonitorSmartphone } from 'lucide-react';
import { useModule } from '../modules/registry.ts';
import { usePaletteActions } from '../lib/palette.ts';
import { useApp } from '../state/app.ts';
import { TimeTravelBar, TimeTravelDialog, useTimeTravelDialog } from '../timeline/TimeTravel.tsx';
import { backToToday, useTimeTravel } from '../timeline/timetravel.ts';
import { isNative } from '../platform/env.ts';
import { JoinSheet, openJoinSheet } from './CodeSheets.tsx';
import { takePendingJoin, watchJoinLinks } from './joinStash.ts';
import { parseJoin } from './shortcode.ts';

/** Opens the join sheet for a link (the person taps Join; nothing connects by itself). */
function openFromLink(text: string): void {
  const j = parseJoin(text);
  if (j) openJoinSheet({ code: j.code, relay: j.relay, fromLink: true });
}

export function PeerGlobal() {
  const timeline = useModule('timeline');
  const peer = useModule('peer');
  const asOf = useTimeTravel((s) => s.asOf);
  const navigate = useApp((s) => s.navigate);
  usePaletteActions('timeline', [
    ...(timeline ? [{ id: 'timeline.asof', label: 'Show notes as of a date…', keywords: 'time travel history past version snapshot when', icon: <History size={16} />, run: () => useTimeTravelDialog.open() }] : []),
    ...(timeline && asOf != null ? [{ id: 'timeline.today', label: 'Back to today', keywords: 'time travel present now', icon: <History size={16} />, run: () => void backToToday() }] : []),
    ...(peer ? [{ id: 'peer.devices', label: 'Devices & sharing', keywords: 'pair sync phone tablet qr join live collaborate', icon: <MonitorSmartphone size={16} />, run: () => navigate({ name: 'settings', section: 'devices' }) }] : []),
    ...(peer ? [{ id: 'peer.join', label: 'Join with a code…', keywords: 'join shared note live code pair device invite', icon: <KeyRound size={16} />, run: () => openJoinSheet() }] : []),
  ]);
  // Join links: the one the app was opened with, ones opened in this tab, and inkwright://join links on Android.
  useEffect(() => {
    if (!peer) return;
    const first = takePendingJoin();
    if (first) openFromLink(first);
    const stop = watchJoinLinks(openFromLink);
    let remove: (() => void) | null = null;
    if (isNative) {
      void import('@capacitor/app').then(async ({ App }) => {
        const h = await App.addListener('appUrlOpen', (e) => { if (/^inkwright:\/\/join/i.test(e.url)) openFromLink(e.url); });
        remove = () => void h.remove();
      });
    }
    return () => {
      stop();
      remove?.();
    };
  }, [peer]);
  // Switching the module off while in the past returns to today.
  useEffect(() => {
    if (!timeline && asOf != null) void backToToday();
  }, [timeline, asOf]);
  return (
    <>
      {timeline && <TimeTravelBar />}
      {timeline && <TimeTravelDialog />}
      {peer && <JoinSheet />}
    </>
  );
}
