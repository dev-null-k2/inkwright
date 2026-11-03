/**
 * @inkwright/sync/storage — everything in @inkwright/sync except device-to-device sync (`peer/`).
 *
 * The app imports this entry on its startup path (opening the vault, the sync loop, merging a
 * note's pages), so that the peer protocol and its curve cryptography (@noble, ≈ 40 kB of
 * compressed JavaScript) load with the screens that pair devices, not with the library.
 * A barrel that re-exports a module puts that module in the importer's chunk, whichever exports
 * are used (docs/PERFORMANCE.md).
 */
export * from './util.ts';
export * from './idb-fs.ts';
export * from './fsa-fs.ts';
export * from './capacitor-fs.ts';
export * from './remote.ts';
export * from './http.ts';
export * from './gdrive.ts';
export * from './webdav.ts';
export * from './merge.ts';
export * from './merge-listen.ts';
export * from './derived.ts';
export * from './state.ts';
export * from './engine.ts';
export * from './scheduler.ts';
export * from './zip.ts';
export * from './merge-platform.ts';
export * from './branch-merge.ts';
export * from './merge-recall.ts';
