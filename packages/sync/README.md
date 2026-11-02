# @inkwright/sync

Storage backends for the Inkwright vault and multi-device sync with merging. Pure TypeScript,
browser-safe (global `fetch`, WebCrypto, Compression Streams); the Node backend lives in the
separate `@inkwright/sync/node` entry.

## What's inside

| Area | Exports |
|---|---|
| VaultFS backends | `IndexedDBFS` (web), `FileSystemAccessFS` (desktop "open folder"), `CapacitorFS` (Android/iOS; pass the `Filesystem` plugin), `NodeFS` from `@inkwright/sync/node` (atomic temp + rename) |
| Remotes | `GoogleDriveRemote` (Drive v3, `drive.file` scope, visible "Inkwright" folder), `WebDavRemote` (Nextcloud/ownCloud/any WebDAV), `FolderRemote` (any VaultFS), `MemoryRemote` (tests) |
| Merge | `mergePage`, `mergeNote`, `mergeNotebook`, `mergeFileBytes` — pure three-way merges (two-way union without a base) |
| Engine | `SyncEngine`, `SyncScheduler`, `MemoryStateStore`, `FsStateStore`, `SyncSafetyError` |
| Backup | `exportVaultZip`, `importVaultZip({ mode: 'merge' \| 'replace' })`, `writeZip`, `readZip`, `crc32` |

## Usage (web app + Google Drive)

```ts
import { Vault } from '@inkwright/core';
import { DRIVE_SCOPE, FsStateStore, GoogleDriveRemote, IndexedDBFS, SyncEngine, SyncScheduler, hasLocalChanges } from '@inkwright/sync';

const local = new IndexedDBFS({ dbName: 'inkwright-vault' });
const vault = new Vault(local);
const engine = new SyncEngine({
  local,
  remote: new GoogleDriveRemote({ getAccessToken, refreshAccessToken }), // OAuth with DRIVE_SCOPE
  state: new FsStateStore(new IndexedDBFS({ dbName: 'inkwright-sync' }), { prefix: 'gdrive' }), // never inside the vault
});
const scheduler = new SyncScheduler({
  run: async (signal) => {
    const report = await engine.sync({ signal });
    if (hasLocalChanges(report)) vault.invalidate();
    return report;
  },
  subscribeOnline: (cb) => { const on = () => cb(true), off = () => cb(false); addEventListener('online', on); addEventListener('offline', off); return () => { removeEventListener('online', on); removeEventListener('offline', off); }; },
  onError: (e, retryIn) => console.warn('sync failed', e, retryIn),
});
vault.onChange(() => scheduler.notifyLocalChange());
scheduler.start();
```

MCP server / CLI: `import { NodeFS } from '@inkwright/sync/node'`.

## How sync decides

Per file, from the local SHA-256, the remote rev (ETag, Drive `id:md5`, content hash) and the
state recorded at the last sync: unchanged → skip; one side changed → push / pull / delete on the
other side; both changed → merge. An edit always beats a deletion on the other side.

- `*.ink.json`, `note.json`, `notebook.json`: three-way merge against the last-synced base (stored
  in the state store). Strokes/texts/images/recordings union by id with deletions honoured; page
  order and tags merge; scalars take the newer `updatedAt`; `trashedAt` is honoured;
  `recognizedText` follows the newer `recognizedAt`. The merged file is written to both sides and
  the note's `note.md` / SVGs are regenerated.
- Derived files (`*.svg`, `note.md`) and other files: newest wins, never reported as conflicts.
- Assets changed on both sides: the remote version stays, the local one is kept as
  `name.conflict-<time>.ext` (reported in `report.conflicts`).
- Never synced: `.inkwright/` and any dot-folder/dotfile, OS junk, temp files.

Every remote write carries `ifMatch`, so a concurrent writer causes a re-read and merge instead
of an overwrite. State is persisted after each file (resumable), work runs 4 files at a time,
and `sync({ signal })` is cancellable.

**Safety.** The engine throws `SyncSafetyError` before changing anything when the remote (or
local) listing is empty although files were synced before, or when a run would delete more than
half of the synced files (≥ 25). Ask the user, then call `sync({ allowMassDelete: true })`. The
scheduler pauses on this error until `syncNow()`. A failing remote listing always throws; remotes
never return a partial list.

## Notes

- Google Drive deletes move files to Drive's trash (`permanentDelete: true` to change); empty
  folders are left in place.
- `trustLocalMtime: true` skips re-hashing files whose size/mtime are unchanged (recommended for
  large vaults on real file systems).
- ZIP: stored or deflate (via `CompressionStream('deflate-raw')`), UTF-8 names, CRC-checked on
  read; no ZIP64 (archives up to 4 GB / 65 535 files).
