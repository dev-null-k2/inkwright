/**
 * The short code a host is showing for a live note: one per note at a time, alive until someone
 * joins with it, it expires (ten minutes), it locks after wrong tries, or the host stops. It
 * outlives the share sheet — close the sheet, keep writing, and the person can still join — and
 * the permission can change until they do (each attempt reads it when it makes its offer).
 */
import { create } from 'zustand';
import type { NoteDocument } from '@inkwright/core';
import type { CollabPermission, HostState, ShortCodeHost } from '@inkwright/sync';
import { useApp } from '../state/app.ts';
import { admitGuest, inviteToNote } from './collab.ts';
import { hostByCode } from './shortcode.ts';

export interface LiveCode {
  host: ShortCodeHost | null;
  link: string;
  relay: string;
  state: HostState | null;
  permission: CollabPermission;
  /** Who joined with this code, once someone did. */
  joined: string | null;
  error: string | null;
  /** Which start this entry belongs to (a newer code replaces an older one still starting). */
  gen: number;
}

let generation = 0;

export const useLiveCodes = create<Record<string, LiveCode>>(() => ({}));

const patch = (noteId: string, p: Partial<LiveCode>) => useLiveCodes.setState((s) => (s[noteId] ? { [noteId]: { ...s[noteId]!, ...p } } : s));

/** Makes a fresh code for the note (replacing any code still showing for it). */
export async function startLiveCode(doc: NoteDocument, permission: CollabPermission): Promise<void> {
  const noteId = doc.meta.id;
  useLiveCodes.getState()[noteId]?.host?.cancel();
  const gen = ++generation;
  useLiveCodes.setState({ [noteId]: { host: null, link: '', relay: '', state: null, permission, joined: null, error: null, gen } });
  const mine = () => useLiveCodes.getState()[noteId]?.gen === gen;
  try {
    const h = await hostByCode({
      purpose: 'collab',
      makeOffer: (pakePsk) => inviteToNote(doc, useLiveCodes.getState()[noteId]?.permission ?? 'view', { pakePsk }),
      accept: async (answerCode, pending) => {
        const who = await admitGuest(doc, pending, answerCode);
        if (mine()) patch(noteId, { joined: who.name });
        useApp.getState().toast({ text: `${who.name} joined`, tone: 'success' });
      },
      onState: (state) => { if (mine()) patch(noteId, { state }); },
    });
    if (mine()) patch(noteId, { host: h.host, link: h.link, relay: h.relay });
    else h.host.cancel();
  } catch (e) {
    if (mine()) patch(noteId, { error: (e as Error)?.message ?? String(e) });
  }
}

export function setLiveCodePermission(noteId: string, permission: CollabPermission): void {
  patch(noteId, { permission });
}

/** Stops showing the note's code (sharing stopped, or the module was switched off). */
export function cancelLiveCode(noteId: string): void {
  useLiveCodes.getState()[noteId]?.host?.cancel();
  useLiveCodes.setState((s) => {
    const next = { ...s };
    delete next[noteId];
    return next;
  }, true);
}

/** A code is showing for the note and nobody has used it yet. */
export const codeWaiting = (c: LiveCode | undefined): boolean => !!c && !c.error && (!c.state || c.state.phase === 'waiting');
