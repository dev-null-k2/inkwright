import { useEffect } from 'react';
import { VersionHistory, type NoteMeta, type PageInk, type SnapshotReason } from '@inkstone/core';
import type { EditorSession } from '../lib/session.ts';
import type { AppVault } from '../lib/vault.ts';
import { useSettings } from '../state/settings.ts';
import { historyPruneOptions } from '@inkstone/ai';
// Retention and legal hold for version history come from the AI policy (docs/TRUST.md).
import { currentPolicy } from '../lib/trust/state.ts';

/**
 * Automatic version history for the open note (core history.ts stores and prunes it):
 *  - when the note is opened and when it is closed,
 *  - every few minutes while it is being edited (after the edit is saved),
 *  - before an assistant or routine changes it (`snapshotBeforeAgentEdit`),
 *  - before a version is restored.
 * Identical states are never stored twice, so opening and closing a note without editing costs
 * nothing. Snapshots of a locked note are encrypted with its key.
 */
export const EDIT_INTERVAL_MS = 10 * 60_000;

const open = new Map<string, NoteVersioning>();

export class NoteVersioning {
  readonly history: VersionHistory;
  private lastAt = Date.now();
  private unsub: () => void;
  private timer = 0;
  private closed = false;

  constructor(readonly session: EditorSession, private interval = EDIT_INTERVAL_MS) {
    this.history = new VersionHistory(session.vault.vault);
    this.unsub = session.doc.subscribe(() => this.onEdit());
    open.set(session.doc.meta.id, this);
  }

  private get device() { return useSettings.getState().authorship.deviceName || undefined; }

  /** Snapshots what is saved now (flushes first, so the snapshot matches the files). */
  async take(reason: SnapshotReason, force = false) {
    if (this.closed && reason !== 'close') return null;
    await this.session.flush();
    const doc = this.session.doc;
    try {
      const info = await this.history.take(doc.meta, [...doc.committedPages], reason, { force, device: this.device });
      this.lastAt = Date.now();
      return info;
    } catch (e) {
      console.warn('version snapshot failed', e);
      return null;
    }
  }

  async start() {
    await this.take('open');
    void this.history.prune(this.session.doc.meta.id, undefined, historyPruneOptions(currentPolicy())).catch(() => {});
  }

  /** While editing: a snapshot once the note has been edited for `interval` since the last one. */
  private onEdit() {
    if (this.closed || this.timer || !this.session.doc.isDirty) return;
    // At most one snapshot per interval while edits keep coming, taken once the save has landed.
    if (Date.now() - this.lastAt >= this.interval) this.timer = window.setTimeout(() => { this.timer = 0; void this.take('interval'); }, 900);
  }

  async close() {
    clearTimeout(this.timer);
    this.unsub();
    await this.take('close');
    this.closed = true;
    if (open.get(this.session.doc.meta.id) === this) open.delete(this.session.doc.meta.id);
    void this.history.prune(this.session.doc.meta.id, undefined, historyPruneOptions(currentPolicy())).catch(() => {});
  }
}

/** The versioning of the open note with this id, if it is open. */
export const versioningFor = (noteId: string) => open.get(noteId) ?? null;

const lastAgentSnapshot = new Map<string, number>();

/**
 * Before the assistant or a routine changes a note: snapshot it as it is now (at most once every
 * two minutes per note, so a run that appends ten times makes one version). The state is taken
 * right away and written in the background, so the agent's edit never waits on it.
 */
export function snapshotBeforeAgentEdit(vault: AppVault, meta: NoteMeta, pages: readonly PageInk[]): void {
  const now = Date.now();
  if (meta.lock || now - (lastAgentSnapshot.get(meta.id) ?? 0) < 120_000) return;
  lastAgentSnapshot.set(meta.id, now);
  const history = versioningFor(meta.id)?.history ?? new VersionHistory(vault.vault);
  void history.take(meta, [...pages], 'agent').catch((e) => console.warn('snapshot before assistant edit failed', e));
}

/**
 * Editor hook: versioning for the open session, and the end of a locked note's unlocked time —
 * after the last save and the closing snapshot, its key is forgotten.
 */
export function useVersioning(session: EditorSession | null, onReady?: (v: NoteVersioning | null) => void) {
  useEffect(() => {
    if (!session) return;
    const v = new NoteVersioning(session);
    onReady?.(v);
    void v.start();
    const id = session.doc.meta.id;
    return () => {
      onReady?.(null);
      void (async () => {
        await session.flush();
        await v.close();
        await session.close();
        if (session.doc.meta.lock) {
          session.vault.vault.forget(id);
          session.vault.assets.clear();
        }
      })();
    };
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps
}
