/**
 * The assistant panel's additions, kept out of AIPanel.tsx: the header menu into the assistant's
 * screens, the screen itself, the push-to-talk microphone, and a quiet strip above the input for
 * things waiting on the user (memory suggestions, approvals, background tasks).
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Loader2, Mic, MoreHorizontal } from 'lucide-react';
import { isTerminal } from '@inkstone/ai';
import { useAgent } from '../../lib/agent/hub.ts';
import { useMcp } from '../../lib/agent/mcp.ts';
import { startListening, voiceInputAvailable, type Listening } from '../../lib/agent/voice.ts';
import { useApp } from '../../state/app.ts';
import { IconButton, Menu, Popover, cx } from '../primitives.tsx';
import { MemoryRow } from './MemoryView.tsx';
import { AGENT_VIEWS, AgentView, ApprovalList, type AgentViewId } from './shared.tsx';

/** Header button with the menu of assistant screens. */
export function AgentMenuButton({ onOpen }: { onOpen: (v: AgentViewId) => void }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const waiting = useAgent((s) => s.approvals.length + s.memory.filter((m) => m.status === 'proposed').length);
  return (
    <>
      <button ref={btn} type="button" className={cx('icon-btn', 'ag-menu-btn')} aria-label="Assistant menu" title="Activity, routines, connected apps, skills, memory" onClick={() => setOpen(true)}>
        <MoreHorizontal size={18} />
        {waiting > 0 && <span className="ag-menu-dot" aria-label={`${waiting} waiting`} />}
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} title="Assistant" placement="below">
        <Menu onClose={() => setOpen(false)} items={AGENT_VIEWS.map((v) => ({ label: v.label, icon: v.icon, onClick: () => onOpen(v.id) }))} />
      </Popover>
    </>
  );
}

/** One assistant screen inside the panel, with a way back to the chat. */
export function PanelAgentView({ view, onBack }: { view: AgentViewId; onBack: () => void }) {
  const v = AGENT_VIEWS.find((x) => x.id === view)!;
  return (
    <div className="ag-panel-view">
      <div className="ag-panel-view-head">
        <IconButton label="Back to chat" onClick={onBack}><ArrowLeft size={17} /></IconButton>
        <h3>{v.label}</h3>
      </div>
      <div className="ag-panel-view-body"><AgentView view={view} /></div>
    </div>
  );
}

/** Things waiting on the user, shown above the input without crowding the chat. */
export function PanelWaiting({ onOpen }: { onOpen: (v: AgentViewId) => void }) {
  // Select stable state and derive here: selectors must not return new arrays (zustand re-renders).
  const memory = useAgent((s) => s.memory);
  const approvals = useAgent((s) => s.approvals.length);
  const allTasks = useMcp((s) => s.tasks);
  const proposals = memory.filter((m) => m.status === 'proposed');
  const tasks = allTasks.filter((t) => !isTerminal(t.task.status));
  const needInput = tasks.filter((t) => t.task.status === 'input_required').length;
  if (!proposals.length && !approvals && !tasks.length) return null;
  return (
    <div className="ag-waiting">
      {approvals > 0 && <ApprovalList />}
      {proposals.slice(0, 2).map((p) => (
        <div key={p.id} className="ag-proposal">
          <span className="ag-proposal-label">Remember this?</span>
          <ul className="ag-list"><MemoryRow item={p} compact /></ul>
        </div>
      ))}
      {tasks.length > 0 && (
        <button type="button" className="ag-tasks-chip" onClick={() => onOpen('apps')}>
          <Loader2 size={13} className="ag-spin" /> {tasks.length} background {tasks.length === 1 ? 'task' : 'tasks'}{needInput ? ` · ${needInput} need${needInput === 1 ? 's' : ''} your answer` : ''}
        </button>
      )}
    </div>
  );
}

/**
 * Push-to-talk: hold to talk and release to send — or tap once to start and tap again to send.
 * The live transcript shows in the input while the browser recognizes speech.
 */
export function MicButton({ disabled, onPartial, onText }: { disabled?: boolean; onPartial: (t: string) => void; onText: (t: string) => void }) {
  const toast = useApp((s) => s.toast);
  const [available, setAvailable] = useState(false);
  const [state, setStateRaw] = useState<'idle' | 'starting' | 'listening' | 'working'>('idle');
  const stateRef = useRef(state);
  const setState = (s: typeof state) => { stateRef.current = s; setStateRaw(s); };
  const listening = useRef<Listening | null>(null);
  const pressedAt = useRef(0);
  const released = useRef(false);
  const stopNext = useRef(false);
  useEffect(() => { void voiceInputAvailable().then(setAvailable).catch(() => setAvailable(false)); }, []);
  if (!available) return null;

  const stop = async () => {
    const l = listening.current;
    if (!l) return;
    listening.current = null;
    setState('working');
    try {
      const text = await l.stop();
      if (text) onText(text);
      else toast({ text: 'Didn’t catch that. Hold the microphone while you talk.' });
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    } finally {
      setState('idle');
    }
  };
  const start = async () => {
    setState('starting');
    released.current = false;
    try {
      listening.current = await startListening({ onPartial });
      setState('listening');
      // Released while the microphone was starting after a long press: that was push-to-talk.
      if (released.current && Date.now() - pressedAt.current > 350) void stop();
    } catch (e) {
      setState('idle');
      toast({ text: (e as Error).message, tone: 'error' });
    }
  };
  const down = () => {
    if (stateRef.current === 'idle') { pressedAt.current = Date.now(); void start(); }
    else if (stateRef.current === 'listening') stopNext.current = true;
  };
  const up = () => {
    released.current = true;
    if (stateRef.current !== 'listening') return;
    if (stopNext.current || Date.now() - pressedAt.current > 350) { stopNext.current = false; void stop(); }
  };
  return (
    <button
      type="button"
      className={cx('mic-btn', state === 'listening' && 'is-listening')}
      aria-label={state === 'listening' ? 'Stop and send' : 'Hold to talk'}
      aria-pressed={state === 'listening'}
      title="Hold to talk, or tap to start and stop"
      disabled={disabled || state === 'working'}
      onPointerDown={(e) => { e.preventDefault(); down(); }}
      onPointerUp={up}
      onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (stateRef.current === 'idle') void start(); else if (stateRef.current === 'listening') void stop(); } }}
    >
      {state === 'working' || state === 'starting' ? <Loader2 size={16} className="ag-spin" /> : <Mic size={17} />}
    </button>
  );
}
