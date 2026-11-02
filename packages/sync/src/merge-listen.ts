import {
  sortSegments,
  type LectureSummary,
  type PageSummariesFile,
  type PageSummary,
  type TranscriptFile,
} from '@inkwright/core';

/*
 * Three-way merges for recording transcripts (`assets/<clip>.transcript.json`) and page
 * summaries (`assets/page-summaries.json`); see docs/VAULT_FORMAT.md § Transcripts.
 *
 * - A transcript belongs to one transcription *run*. When both sides hold the same run (one device
 *   was still transcribing while another synced, or both edited), segments are unioned by id
 *   (a segment changed on one side takes the change; changed on both, the newer file wins).
 *   Different runs ("transcribe again" on one device): the newer file's run replaces the other
 *   wholesale, so the same speech never appears twice.
 * - The lecture summary follows the newer `at`; `complete` is true when either side finished.
 * - Page summaries merge per page id, the newer `at` winning; a page summary deleted on one side
 *   and unchanged on the other is deleted.
 */

type Side = 'a' | 'b';

const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

function newerLecture(a?: LectureSummary, b?: LectureSummary): LectureSummary | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.at > a.at ? b : a;
}

export function mergeTranscript(base: TranscriptFile | null, local: TranscriptFile, remote: TranscriptFile, opts: { prefer?: 'local' | 'remote' } = {}): TranscriptFile {
  const newer: Side = local.updatedAt > remote.updatedAt ? 'a' : remote.updatedAt > local.updatedAt ? 'b' : opts.prefer === 'remote' ? 'b' : 'a';
  const n = newer === 'a' ? local : remote;
  const lecture = newerLecture(local.lecture, remote.lecture);
  if (local.run !== remote.run) {
    const out: TranscriptFile = { ...n, complete: n.complete, updatedAt: Math.max(local.updatedAt, remote.updatedAt) };
    if (lecture) out.lecture = lecture;
    else delete out.lecture;
    return out;
  }
  const baseMap = base && base.run === local.run ? new Map(base.segments.map((s) => [s.id, s])) : null;
  const am = new Map(local.segments.map((s) => [s.id, s]));
  const bm = new Map(remote.segments.map((s) => [s.id, s]));
  const segments = [];
  for (const id of new Set([...am.keys(), ...bm.keys()])) {
    const x = am.get(id), y = bm.get(id), o = baseMap?.get(id);
    if (x && y) {
      if (same(x, y)) segments.push(x);
      else if (o && same(x, o)) segments.push(y);
      else if (o && same(y, o)) segments.push(x);
      else segments.push(newer === 'a' ? x : y);
    } else {
      const only = (x ?? y)!;
      if (o && same(only, o)) continue; // deleted on the other side, unchanged here
      segments.push(only);
    }
  }
  const out: TranscriptFile = {
    ...n,
    complete: local.complete || remote.complete,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    segments: sortSegments(segments),
  };
  if (lecture) out.lecture = lecture;
  else delete out.lecture;
  return out;
}

export function mergePageSummaries(base: PageSummariesFile | null, local: PageSummariesFile, remote: PageSummariesFile): PageSummariesFile {
  const pages: Record<string, PageSummary> = {};
  for (const id of new Set([...Object.keys(local.pages), ...Object.keys(remote.pages)])) {
    const x = local.pages[id], y = remote.pages[id], o = base?.pages[id];
    if (x && y) pages[id] = y.at > x.at ? y : x;
    else {
      const only = (x ?? y)!;
      if (o && same(only, o)) continue;
      pages[id] = only;
    }
  }
  return { formatVersion: Math.max(local.formatVersion, remote.formatVersion), updatedAt: Math.max(local.updatedAt, remote.updatedAt), pages };
}
