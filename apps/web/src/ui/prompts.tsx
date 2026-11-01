import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Dialog } from './primitives.tsx';

type Req =
  | { kind: 'text'; title: string; label: string; value: string; confirm: string; resolve: (v: string | null) => void }
  | { kind: 'confirm'; title: string; body: string; confirm: string; danger?: boolean; resolve: (v: boolean) => void };

const usePrompts = create<{ req: Req | null; set: (r: Req | null) => void }>((set) => ({ req: null, set: (req) => set({ req }) }));

export function askText(title: string, label: string, value = '', confirm = 'Save'): Promise<string | null> {
  return new Promise((resolve) => usePrompts.getState().set({ kind: 'text', title, label, value, confirm, resolve }));
}

export function askConfirm(title: string, body: string, confirm = 'OK', danger = false): Promise<boolean> {
  return new Promise((resolve) => usePrompts.getState().set({ kind: 'confirm', title, body, confirm, danger, resolve }));
}

export function Prompts() {
  const { req, set } = usePrompts();
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (req?.kind === 'text') {
      setValue(req.value);
      setTimeout(() => { input.current?.focus(); input.current?.select(); }, 30);
    }
  }, [req]);
  if (!req) return null;
  const close = (v: any) => { set(null); (req.resolve as (x: any) => void)(v); };
  if (req.kind === 'confirm') {
    return (
      <Dialog open title={req.title} onClose={() => close(false)} actions={<>
        <button type="button" className="btn" onClick={() => close(false)}>Cancel</button>
        <button type="button" className={req.danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={() => close(true)} autoFocus>{req.confirm}</button>
      </>}>
        <p>{req.body}</p>
      </Dialog>
    );
  }
  return (
    <Dialog open title={req.title} onClose={() => close(null)} actions={<>
      <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
      <button type="submit" form="prompt-form" className="btn btn-primary">{req.confirm}</button>
    </>}>
      <form id="prompt-form" onSubmit={(e) => { e.preventDefault(); close(value.trim() || null); }}>
        <label className="field">
          <span className="field-label">{req.label}</span>
          <input ref={input} value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
      </form>
    </Dialog>
  );
}
