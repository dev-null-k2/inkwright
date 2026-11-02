import { CalendarDays, Waypoints } from 'lucide-react';
import { dayKey, findDailyNote } from '@inkstone/core';
import { openToday } from '../../lib/knowledge.ts';
import { useApp } from '../../state/app.ts';
import { GRAPH_KEYS, TODAY_KEYS } from './shortcuts.ts';

/** "Today" in the library sidebar: opens (or starts) today's daily note in the Journal. */
export function TodayNavItem({ onDone }: { onDone?: () => void }) {
  const notes = useApp((s) => s.notes);
  const exists = !!findDailyNote(notes, dayKey(new Date()));
  return (
    <button type="button" className="nav-item" title={`Today’s daily note (${TODAY_KEYS})`} onClick={() => { onDone?.(); void openToday(); }}>
      <span className="nav-icon"><CalendarDays size={17} /></span>
      <span className="nav-label">Today</span>
      <span className="nav-count">{exists ? new Date().toLocaleDateString(undefined, { weekday: 'short' }) : 'New'}</span>
    </button>
  );
}

/** "Graph" in the library sidebar: the full-screen knowledge graph. */
export function GraphNavItem() {
  const navigate = useApp((s) => s.navigate);
  return (
    <button type="button" className="nav-item" title={`Graph of your notes (${GRAPH_KEYS})`} onClick={() => navigate({ name: 'graph' })}>
      <span className="nav-icon"><Waypoints size={17} /></span>
      <span className="nav-label">Graph</span>
    </button>
  );
}
