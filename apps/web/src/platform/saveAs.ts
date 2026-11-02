import { isArtifact, isNative } from './env.ts';
import { saveFile } from './files.ts';

/**
 * Saves a finished document where the user chooses. Desktop browsers with the File System Access
 * API get a real "Save as" dialog (pick the folder and name, e.g. next to the original); Android
 * writes the file with Capacitor Filesystem and opens the share sheet (Save to Files, Drive, mail…);
 * everywhere else it's a normal download. Returns false when the user cancelled.
 */
export async function saveDocument(name: string, bytes: Uint8Array, mime: string, ext: string): Promise<boolean> {
  const w = window as Window & { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> };
  // Automated browsers (tests) can't answer a native dialog; embedded previews can't open one.
  const canPick = !isNative && !isArtifact && typeof w.showSaveFilePicker === 'function' && !navigator.webdriver && window.top === window;
  if (canPick) {
    try {
      const handle = await w.showSaveFilePicker!({ suggestedName: name, types: [{ description: 'Document', accept: { [mime]: [ext] } }] });
      const out = await handle.createWritable();
      await out.write(new Blob([bytes as BlobPart], { type: mime }));
      await out.close();
      return true;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false;
      console.warn('Save dialog unavailable, downloading instead', e);
    }
  }
  await saveFile(name, bytes, mime);
  return true;
}
