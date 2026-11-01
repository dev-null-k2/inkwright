import type { FsaDirectoryHandle, FsaFile, FsaFileHandle, FsaWritable } from '../../src/fsa-fs.ts';

/** In-memory File System Access API: directory/file handles with Chrome-like semantics. */

function err(name: string, msg: string): DOMException {
  return new DOMException(msg, name);
}

function checkName(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new TypeError(`Invalid name: ${name}`);
}

interface StoredFile {
  data: Uint8Array;
  lastModified: number;
}

export class FakeFileHandle implements FsaFileHandle {
  readonly kind = 'file' as const;
  constructor(
    readonly name: string,
    private readonly parent: FakeDirectoryHandle,
  ) {}

  async getFile(): Promise<FsaFile> {
    const f = this.parent.files.get(this.name);
    if (!f) throw err('NotFoundError', `File ${this.name} not found`);
    const data = f.data.slice();
    return { size: data.length, lastModified: f.lastModified, arrayBuffer: async () => data.buffer };
  }

  async createWritable(options?: { keepExistingData?: boolean }): Promise<FsaWritable> {
    const parent = this.parent;
    const name = this.name;
    if (!parent.files.has(name)) throw err('NotFoundError', `File ${name} not found`);
    // Chrome writes to a visible "<name>.crswap" file and swaps it in on close().
    const swap = `${name}.crswap`;
    let buf = options?.keepExistingData ? parent.files.get(name)!.data.slice() : new Uint8Array(0);
    parent.files.set(swap, { data: buf, lastModified: parent.clock() });
    let done = false;
    return {
      async write(data: BufferSource) {
        if (done) throw new TypeError('Stream closed');
        const chunk = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const next = new Uint8Array(buf.length + chunk.length);
        next.set(buf);
        next.set(chunk, buf.length);
        buf = next;
      },
      async close() {
        if (done) throw new TypeError('Stream closed');
        done = true;
        parent.files.delete(swap);
        parent.files.set(name, { data: buf.slice(), lastModified: parent.clock() });
      },
      async abort() {
        done = true;
        parent.files.delete(swap);
      },
    };
  }
}

export class FakeDirectoryHandle implements FsaDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly files = new Map<string, StoredFile>();
  readonly dirs = new Map<string, FakeDirectoryHandle>();

  constructor(
    readonly name = 'vault',
    readonly clock: () => number = Date.now,
  ) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectoryHandle> {
    checkName(name);
    if (this.files.has(name)) throw err('TypeMismatchError', `${name} is a file`);
    let d = this.dirs.get(name);
    if (!d) {
      if (!options?.create) throw err('NotFoundError', `Directory ${name} not found`);
      d = new FakeDirectoryHandle(name, this.clock);
      this.dirs.set(name, d);
    }
    return d;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    checkName(name);
    if (this.dirs.has(name)) throw err('TypeMismatchError', `${name} is a directory`);
    if (!this.files.has(name)) {
      if (!options?.create) throw err('NotFoundError', `File ${name} not found`);
      this.files.set(name, { data: new Uint8Array(0), lastModified: this.clock() });
    }
    return new FakeFileHandle(name, this);
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    checkName(name);
    if (this.files.delete(name)) return;
    const d = this.dirs.get(name);
    if (!d) throw err('NotFoundError', `${name} not found`);
    if (!options?.recursive && (d.files.size || d.dirs.size)) throw err('InvalidModificationError', `${name} is not empty`);
    this.dirs.delete(name);
  }

  async *values(): AsyncGenerator<FakeDirectoryHandle | FakeFileHandle> {
    for (const d of [...this.dirs.values()]) yield d;
    for (const n of [...this.files.keys()]) yield new FakeFileHandle(n, this);
  }
}
