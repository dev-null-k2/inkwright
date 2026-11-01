import { claudeRuntime, isNative } from './env.ts';

/**
 * Hands a generated file to the user: share sheet / Documents on mobile, the claude.ai download
 * capability inside the live preview, a normal download in browsers.
 */
export async function saveFile(name: string, bytes: Uint8Array, mime: string): Promise<void> {
  if (isNative) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const res = await Filesystem.writeFile({ path: `exports/${name}`, data: btoa(bin), directory: Directory.Cache, recursive: true });
    await Share.share({ title: name, url: res.uri, dialogTitle: `Share ${name}` });
    return;
  }
  const rt = claudeRuntime();
  if (rt) {
    try {
      const dl = await rt.use('downloads');
      if (dl) {
        await dl.save({ filename: name, data: new Blob([bytes as BlobPart], { type: mime }) });
        return;
      }
    } catch (e) {
      if ((e as any)?.code === 'declined' || (e as any)?.code === 'cancelled') return;
    }
  }
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
  const file = typeof File !== 'undefined' ? new File([blob], name, { type: mime }) : null;
  if (file && /Android|iPhone|iPad/.test(navigator.userAgent) && nav.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Opens the system picker for files (works in browsers, WebViews and the preview). */
export function pickFiles(accept: string, multiple = true, capture?: 'environment'): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    if (capture) input.setAttribute('capture', capture);
    input.style.display = 'none';
    input.onchange = () => { resolve([...(input.files ?? [])]); input.remove(); };
    input.oncancel = () => { resolve([]); input.remove(); };
    document.body.appendChild(input);
    input.click();
  });
}
