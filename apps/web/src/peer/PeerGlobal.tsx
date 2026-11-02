/**
 * App-wide pieces of the peer and timeline modules: the time travel bar and dialog, and their
 * search-palette actions. Mounted once by the app; each part follows its module's switch.
 */
import { useEffect } from 'react';
import { History, MonitorSmartphone } from 'lucide-react';
import { useModule } from '../modules/registry.ts';
import { usePaletteActions } from '../lib/palette.ts';
import { useApp } from '../state/app.ts';
import { TimeTravelBar, TimeTravelDialog, useTimeTravelDialog } from '../timeline/TimeTravel.tsx';
import { backToToday, useTimeTravel } from '../timeline/timetravel.ts';

export function PeerGlobal() {
  const timeline = useModule('timeline');
  const peer = useModule('peer');
  const asOf = useTimeTravel((s) => s.asOf);
  const navigate = useApp((s) => s.navigate);
  usePaletteActions('timeline', [
    ...(timeline ? [{ id: 'timeline.asof', label: 'Show notes as of a date…', keywords: 'time travel history past version snapshot when', icon: <History size={16} />, run: () => useTimeTravelDialog.open() }] : []),
    ...(timeline && asOf != null ? [{ id: 'timeline.today', label: 'Back to today', keywords: 'time travel present now', icon: <History size={16} />, run: () => void backToToday() }] : []),
    ...(peer ? [{ id: 'peer.devices', label: 'Devices & sharing', keywords: 'pair sync phone tablet qr join live collaborate', icon: <MonitorSmartphone size={16} />, run: () => navigate({ name: 'settings', section: 'devices' }) }] : []),
  ]);
  // Switching the module off while in the past returns to today.
  useEffect(() => {
    if (!timeline && asOf != null) void backToToday();
  }, [timeline, asOf]);
  if (!timeline) return null;
  return (
    <>
      <TimeTravelBar />
      <TimeTravelDialog />
    </>
  );
}
