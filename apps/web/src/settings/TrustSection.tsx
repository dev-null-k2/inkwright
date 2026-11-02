/**
 * Settings › Privacy & trust › AI privacy: the trust layer's screens (docs/TRUST.md) in one place,
 * next to authorship, instead of at the bottom of the assistant's list. Each opens in place, like
 * the assistant's screens in Settings › AI, and uses the same views.
 */
import { useState } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { AGENT_VIEWS, AgentView, type AgentViewId } from '../ui/agent/shared.tsx';

/** The assistant screens that belong to privacy and trust rather than to the assistant itself. */
export const TRUST_VIEWS: readonly AgentViewId[] = ['routing', 'usage', 'audit'];

export function TrustSection() {
  const [open, setOpen] = useState<AgentViewId | null>(null);
  const views = AGENT_VIEWS.filter((v) => TRUST_VIEWS.includes(v.id));
  if (open) {
    const v = views.find((x) => x.id === open)!;
    return (
      <section className="set-group ag-settings-view">
        <button type="button" className="ag-back" onClick={() => setOpen(null)}><ArrowLeft size={16} /> AI privacy</button>
        <h2 className="ag-view-title">{v.label}</h2>
        <AgentView view={open} />
      </section>
    );
  }
  return (
    <section className="set-group">
      <h2>What AI may see and do</h2>
      <div className="set-card ag-nav">
        {views.map((v) => (
          <button key={v.id} type="button" className="ag-nav-row" onClick={() => setOpen(v.id)}>
            <span className="nav-icon">{v.icon}</span>
            <span className="ag-nav-text"><span className="row-label">{v.label}</span><span className="row-hint">{v.hint}</span></span>
            <ChevronRight size={16} className="muted" />
          </button>
        ))}
      </div>
      <p className="set-note">Every AI request goes through these rules, whichever provider answers it.</p>
    </section>
  );
}
