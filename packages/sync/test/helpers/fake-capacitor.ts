import type { CapacitorFileInfo, CapacitorFilesystemLike } from '../../src/capacitor-fs.ts';

type Node = { type: 'file'; data: string; mtime: number } | { type: 'directory'; mtime: number };

export interface FakeCapacitorOptions {
  /** Old plugin versions returned plain names from readdir. */
  legacyReaddir?: boolean;
  /** iOS-like: rename fails when the destination exists. */
  renameRefusesOverwrite?: boolean;
  /** Web-like: readFile returns a Blob instead of base64. */
  blobReads?: boolean;
  clock?: () => number;
}

/** In-memory stand-in for @capacitor/filesystem with the plugin's error behaviour. */
export class FakeCapacitorFilesystem implements CapacitorFilesystemLike {
  readonly nodes = new Map<string, Node>();
  readonly calls: string[] = [];
  private readonly clock: () => number;

  constructor(private readonly opts: FakeCapacitorOptions = {}) {
    this.clock = opts.clock ?? Date.now;
  }

  private key(directory: string | undefined, path: string): string {
    const clean = path.split('/').filter(Boolean).join('/');
    return `${directory ?? 'NONE'}:${clean}`;
  }

  private parentKey(directory: string | undefined, path: string): string | null {
    const parts = path.split('/').filter(Boolean);
    if (parts.length <= 1) return null; // directory root always exists
    return this.key(directory, parts.slice(0, -1).join('/'));
  }

  private mkdirs(directory: string | undefined, path: string): void {
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const k = this.key(directory, parts.slice(0, i).join('/'));
      const n = this.nodes.get(k);
      if (n && n.type === 'file') throw new Error('Parent is a file');
      if (!n) this.nodes.set(k, { type: 'directory', mtime: this.clock() });
    }
  }

  async readFile(o: { path: string; directory?: string }): Promise<{ data: string | Blob }> {
    this.calls.push(`readFile ${o.path}`);
    const n = this.nodes.get(this.key(o.directory, o.path));
    if (!n || n.type !== 'file') throw new Error('File does not exist.');
    if (this.opts.blobReads) {
      const bin = atob(n.data);
      return { data: new Blob([Uint8Array.from(bin, (c) => c.charCodeAt(0))]) };
    }
    return { data: n.data };
  }

  async writeFile(o: { path: string; data: string; directory?: string; recursive?: boolean }): Promise<unknown> {
    this.calls.push(`writeFile ${o.path}`);
    const k = this.key(o.directory, o.path);
    if (this.nodes.get(k)?.type === 'directory') throw new Error('Is a directory');
    const pk = this.parentKey(o.directory, o.path);
    if (pk && !this.nodes.has(pk)) {
      if (!o.recursive) throw new Error('Parent directory must exist');
      this.mkdirs(o.directory, o.path);
    }
    this.nodes.set(k, { type: 'file', data: o.data, mtime: this.clock() });
    return { uri: `file:///${k}` };
  }

  async deleteFile(o: { path: string; directory?: string }): Promise<void> {
    this.calls.push(`deleteFile ${o.path}`);
    const k = this.key(o.directory, o.path);
    if (this.nodes.get(k)?.type !== 'file') throw new Error('File does not exist.');
    this.nodes.delete(k);
  }

  async rmdir(o: { path: string; directory?: string; recursive?: boolean }): Promise<void> {
    this.calls.push(`rmdir ${o.path}`);
    const k = this.key(o.directory, o.path);
    if (this.nodes.get(k)?.type !== 'directory') throw new Error('Folder does not exist.');
    const prefix = k + '/';
    const children = [...this.nodes.keys()].filter((x) => x.startsWith(prefix));
    if (children.length && !o.recursive) throw new Error('Folder is not empty');
    for (const c of children) this.nodes.delete(c);
    this.nodes.delete(k);
  }

  async readdir(o: { path: string; directory?: string }): Promise<{ files: (CapacitorFileInfo | string)[] }> {
    this.calls.push(`readdir ${o.path}`);
    const k = this.key(o.directory, o.path);
    const isRoot = k.endsWith(':');
    if (!isRoot && this.nodes.get(k)?.type !== 'directory') throw new Error('Folder does not exist.');
    const prefix = isRoot ? k : k + '/';
    const files: (CapacitorFileInfo | string)[] = [];
    for (const [key, n] of this.nodes) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      if (this.opts.legacyReaddir) files.push(rest);
      else files.push({ name: rest, type: n.type, size: n.type === 'file' ? Math.floor((n.data.replace(/=+$/, '').length * 3) / 4) : 0, mtime: n.mtime, uri: `file:///${key}` });
    }
    return { files };
  }

  async stat(o: { path: string; directory?: string }): Promise<CapacitorFileInfo> {
    this.calls.push(`stat ${o.path}`);
    const k = this.key(o.directory, o.path);
    if (k.endsWith(':')) return { type: 'directory', size: 0, mtime: 0 };
    const n = this.nodes.get(k);
    if (!n) throw new Error('Entry does not exist.');
    return { type: n.type, size: n.type === 'file' ? Math.floor((n.data.replace(/=+$/, '').length * 3) / 4) : 0, mtime: n.mtime, uri: `file:///${k}` };
  }

  async rename(o: { from: string; to: string; directory?: string; toDirectory?: string }): Promise<void> {
    this.calls.push(`rename ${o.from} -> ${o.to}`);
    const from = this.key(o.directory, o.from);
    const to = this.key(o.toDirectory ?? o.directory, o.to);
    const n = this.nodes.get(from);
    if (!n || n.type !== 'file') throw new Error('File does not exist.');
    if (this.nodes.has(to) && this.opts.renameRefusesOverwrite) throw new Error('Destination exists');
    this.mkdirs(o.toDirectory ?? o.directory, o.to);
    this.nodes.delete(from);
    this.nodes.set(to, n);
  }
}
