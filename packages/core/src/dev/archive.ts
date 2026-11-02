/**
 * Reading repository archives without a server: GitHub's "Download tarball" (`.tar.gz`) on any
 * platform. (Zip archives use `readZip` from @inkwright/sync.) Plain ustar with the POSIX pax and
 * GNU long-name extensions GitHub and `git archive` produce; gunzip through the platform's
 * `DecompressionStream` (browsers, Node 18+).
 */
import type { RepoFile } from './codescan.ts';

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unpack .tar.gz files. Use a .zip of the repository instead.');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const dec = new TextDecoder();
const cstr = (b: Uint8Array, at: number, len: number) => { const s = b.subarray(at, at + len); const z = s.indexOf(0); return dec.decode(z >= 0 ? s.subarray(0, z) : s); };
const octal = (b: Uint8Array, at: number, len: number) => parseInt(cstr(b, at, len).trim() || '0', 8);

/** Regular files in a tar archive. `keep` filters by path before any bytes are copied. */
export function readTar(tar: Uint8Array, keep: (path: string, size: number) => boolean = () => true): RepoFile[] {
  const out: RepoFile[] = [];
  let at = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (at + 512 <= tar.length) {
    const h = tar.subarray(at, at + 512);
    if (h.every((x) => x === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = cstr(h, 345, 155);
    let name = cstr(h, 0, 100);
    if (prefix && cstr(h, 257, 6).startsWith('ustar')) name = `${prefix}/${name}`;
    const body = at + 512;
    if (body + size > tar.length) throw new Error('The archive is truncated.');
    if (type === 'L') longName = cstr(tar, body, size);
    else if (type === 'x') {
      const pax = dec.decode(tar.subarray(body, body + size));
      paxPath = /(?:^|\n)\d+ path=([^\n]*)/.exec(pax)?.[1] ?? paxPath;
    } else if (type === 'g') {
      // pax global header (GitHub puts the commit id here): nothing to keep.
    } else {
      const path = (paxPath ?? longName ?? name).replace(/^\.\//, '');
      longName = paxPath = null;
      if ((type === '0' || type === '\0' || type === '7') && path && !path.split('/').includes('..') && keep(path, size)) {
        out.push({ path, bytes: tar.slice(body, body + size) });
      }
    }
    at = body + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** `.tar.gz` / `.tgz` (or a plain `.tar`) → files. */
export async function readTarball(bytes: Uint8Array, keep?: (path: string, size: number) => boolean): Promise<RepoFile[]> {
  const gz = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return readTar(gz ? await gunzip(bytes) : bytes, keep);
}
