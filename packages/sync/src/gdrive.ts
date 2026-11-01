import { HttpClient, httpError, type RetryOptions } from './http.ts';
import { PreconditionFailedError, type Remote, type RemoteCallOptions, type RemoteEntry, type RemoteFile } from './remote.ts';
import { Inflight, concatBytes, isJunkName, mimeTypeFor, randomToken, safePath, utf8Encode } from './util.ts';

/** OAuth scope: only files this app created (or the user opened with it). */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,mimeType,parents,md5Checksum,modifiedTime,version,size,createdTime,trashed';
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'sharingRateLimitExceeded', 'backendError']);

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  md5Checksum?: string;
  modifiedTime?: string;
  version?: string;
  size?: string;
  createdTime?: string;
  trashed?: boolean;
}

export interface GoogleDriveRemoteOptions {
  /** Returns a valid OAuth access token with {@link DRIVE_SCOPE}. Called lazily and cached. */
  getAccessToken: () => Promise<string>;
  /** Called (at most once per request) after a 401 to get a fresh token. Default: `getAccessToken()` again. */
  refreshAccessToken?: () => Promise<string>;
  /** Name of the visible vault folder. Default "Inkstone". */
  folderName?: string;
  /** Use this folder id as the vault root instead of finding/creating `folderName`. */
  folderId?: string;
  /** Parent of the vault folder when it must be found/created. Default "root" (My Drive). */
  parentFolderId?: string;
  /**
   * How `list()` walks the tree. 'flat' (default) lists every file the app can see in one paged
   * query and rebuilds paths from `parents` — cheap under the drive.file scope. 'tree' walks
   * folders level by level with batched `'<id>' in parents` queries.
   */
  listMode?: 'flat' | 'tree';
  /** Delete permanently instead of moving to Drive's trash (default false: trash, recoverable). */
  permanentDelete?: boolean;
  fetch?: typeof fetch;
  retry?: RetryOptions;
  /** files.list page size (max 1000). */
  pageSize?: number;
}

/** Escapes a value for a Drive `q` string literal. */
export function driveQuote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function revOf(f: DriveFile): string {
  // id + content checksum: changes exactly when content changes, and a re-created file never
  // reuses a rev. Fall back to version/modifiedTime for files Drive doesn't checksum.
  return `${f.id}:${f.md5Checksum ?? `v${f.version ?? ''}`}${f.md5Checksum ? '' : `@${f.modifiedTime ?? ''}`}`;
}

function toEntry(path: string, f: DriveFile): RemoteEntry {
  return {
    path,
    rev: revOf(f),
    mtime: f.modifiedTime ? Date.parse(f.modifiedTime) : undefined,
    size: f.size !== undefined ? Number(f.size) : undefined,
  };
}

function byCreated(a: DriveFile, b: DriveFile): number {
  const c = (a.createdTime ?? '').localeCompare(b.createdTime ?? '');
  return c !== 0 ? c : a.id.localeCompare(b.id);
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Google Drive v3 remote. The vault lives in a visible "Inkstone" folder that mirrors the vault
 * tree, so users can see (and back up) their notes in Drive. Uses only REST + fetch.
 */
export class GoogleDriveRemote implements Remote {
  private readonly http: HttpClient;
  private token: string | null = null;
  private readonly refreshes = new Inflight<string>();
  private readonly inflight = new Inflight<string>();
  private rootPromise: Promise<string> | null = null;
  /** dir path ('' = root) → folder id. */
  private folders = new Map<string, string>();
  /** file path → metadata, from the last list() and our own writes. */
  private files = new Map<string, DriveFile>();
  /** Folders this instance created: nobody else can have files in them yet. */
  private freshFolders = new Set<string>();

  constructor(private readonly opts: GoogleDriveRemoteOptions) {
    this.http = new HttpClient({
      fetch: opts.fetch,
      retry: opts.retry,
      headers: async () => ({ Authorization: `Bearer ${(this.token ??= await opts.getAccessToken())}` }),
      onUnauthorized: async () => {
        // Concurrent requests that all hit 401 share one refresh.
        this.token = await this.refreshes.run('t', () => (opts.refreshAccessToken ?? opts.getAccessToken)());
        return true;
      },
      isRetryable: async (res) => {
        if (res.status !== 403) return false;
        try {
          const j = await res.clone().json();
          const reasons: string[] = (j?.error?.errors ?? []).map((e: { reason?: string }) => e.reason ?? '');
          return reasons.some((r) => RATE_REASONS.has(r));
        } catch {
          return false;
        }
      },
    });
  }

  // ---- HTTP plumbing ------------------------------------------------------------------------

  private async call(method: string, url: string, what: string, init: { body?: Uint8Array | string; headers?: Record<string, string>; signal?: AbortSignal; allow404?: boolean } = {}): Promise<Response | null> {
    const res = await this.http.request({ method, url, body: init.body, headers: init.headers, signal: init.signal });
    if (res.status === 404 && init.allow404) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) throw await httpError(res, `Drive ${what}`);
    return res;
  }

  private async getJson<T>(url: string, what: string, signal?: AbortSignal): Promise<T> {
    return (await (await this.call('GET', url, what, { signal }))!.json()) as T;
  }

  private async query(q: string, signal?: AbortSignal): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: String(this.opts.pageSize ?? 1000),
        spaces: 'drive',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await this.getJson<{ files?: DriveFile[]; nextPageToken?: string }>(`${DRIVE_API}/files?${params}`, 'files.list', signal);
      out.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  private async meta(id: string, signal?: AbortSignal): Promise<DriveFile | null> {
    const res = await this.call('GET', `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}`, 'files.get', { signal, allow404: true });
    if (!res) return null;
    const f = (await res.json()) as DriveFile;
    return f.trashed ? null : f;
  }

  private async createFolder(name: string, parentId: string, signal?: AbortSignal): Promise<DriveFile> {
    const res = await this.call('POST', `${DRIVE_API}/files?fields=${FILE_FIELDS}`, 'create folder', {
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      signal,
    });
    return (await res!.json()) as DriveFile;
  }

  private findChildren(parentId: string, name: string, folder: boolean, signal?: AbortSignal): Promise<DriveFile[]> {
    const kind = folder ? `mimeType = '${FOLDER_MIME}'` : `mimeType != '${FOLDER_MIME}'`;
    return this.query(`name = ${driveQuote(name)} and ${driveQuote(parentId)} in parents and ${kind} and trashed = false`, signal);
  }

  // ---- Folder resolution ---------------------------------------------------------------------

  /** Id of the vault root folder (found or created once per instance). */
  rootId(signal?: AbortSignal): Promise<string> {
    if (this.opts.folderId) return Promise.resolve(this.opts.folderId);
    if (!this.rootPromise) {
      this.rootPromise = (async () => {
        const name = this.opts.folderName ?? 'Inkstone';
        const parent = this.opts.parentFolderId ?? 'root';
        let found = await this.findChildren(parent, name, true, signal);
        if (found.length === 0) {
          await this.createFolder(name, parent, signal);
          // Another device may have raced us; everyone converges on the oldest folder.
          found = await this.findChildren(parent, name, true, signal);
        }
        return found.sort(byCreated)[0]!.id;
      })();
      this.rootPromise.catch(() => (this.rootPromise = null));
    }
    return this.rootPromise;
  }

  /** Folder id for a vault dir, or null when it doesn't exist (never creates). */
  private async findFolder(dir: string, signal?: AbortSignal): Promise<string | null> {
    if (dir === '') return this.rootId(signal);
    const cached = this.folders.get(dir);
    if (cached) return cached;
    const parentId = await this.findFolder(dirOf(dir), signal);
    if (!parentId) return null;
    const found = (await this.findChildren(parentId, nameOf(dir), true, signal)).sort(byCreated)[0];
    if (!found) return null;
    this.folders.set(dir, found.id);
    return found.id;
  }

  /** Folder id for a vault dir, creating missing folders (deduplicated across concurrent calls). */
  private ensureFolder(dir: string, signal?: AbortSignal): Promise<string> {
    if (dir === '') return this.rootId(signal);
    const cached = this.folders.get(dir);
    if (cached) return Promise.resolve(cached);
    return this.inflight.run(dir, async () => {
      const parentId = await this.ensureFolder(dirOf(dir), signal);
      const name = nameOf(dir);
      let found = this.freshFolders.has(dirOf(dir)) ? [] : await this.findChildren(parentId, name, true, signal);
      if (found.length === 0) {
        found = [await this.createFolder(name, parentId, signal)];
        this.freshFolders.add(dir);
      }
      const id = found.sort(byCreated)[0]!.id;
      this.folders.set(dir, id);
      return id;
    });
  }

  /** Current metadata for a vault file (cache first, then Drive), or null. */
  private async lookup(path: string, signal?: AbortSignal, fresh = false): Promise<DriveFile | null> {
    const cached = this.files.get(path);
    if (cached && !fresh) return cached;
    if (cached) {
      const m = await this.meta(cached.id, signal);
      if (m) {
        this.files.set(path, m);
        return m;
      }
      this.files.delete(path);
    }
    const dir = dirOf(path);
    if (this.freshFolders.has(dir)) return null;
    const parentId = await this.findFolder(dir, signal);
    if (!parentId) return null;
    const found = await this.findChildren(parentId, nameOf(path), false, signal);
    // Duplicates (two devices created the same file): the most recently modified wins.
    const f = found.sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''))[0] ?? null;
    if (f) this.files.set(path, f);
    return f;
  }

  // ---- Remote --------------------------------------------------------------------------------

  async list(opts: RemoteCallOptions = {}): Promise<RemoteEntry[]> {
    const rootId = await this.rootId(opts.signal);
    const folderPath = new Map<string, string>([[rootId, '']]);
    const filesByPath = new Map<string, DriveFile>();
    const folders = new Map<string, string>([['', rootId]]);

    const addFile = (path: string, f: DriveFile) => {
      const prev = filesByPath.get(path);
      if (!prev || (f.modifiedTime ?? '') > (prev.modifiedTime ?? '')) filesByPath.set(path, f);
    };
    const usable = (f: DriveFile) => {
      try {
        return !isJunkName(f.name) && safePath(f.name) === f.name && !f.name.includes('/');
      } catch {
        return false;
      }
    };

    if ((this.opts.listMode ?? 'flat') === 'flat') {
      const all = (await this.query('trashed = false', opts.signal)).filter(usable);
      const byId = new Map(all.map((f) => [f.id, f]));
      const resolving = new Set<string>();
      const pathOfFolder = (id: string): string | null => {
        const known = folderPath.get(id);
        if (known !== undefined) return known;
        const f = byId.get(id);
        if (!f || f.mimeType !== FOLDER_MIME || resolving.has(id)) return null;
        resolving.add(id);
        const parent = f.parents?.[0];
        const pp = parent ? pathOfFolder(parent) : null;
        resolving.delete(id);
        if (pp === null) return null;
        const p = pp ? `${pp}/${f.name}` : f.name;
        folderPath.set(id, p);
        return p;
      };
      for (const f of [...all].sort(byCreated)) {
        if (f.mimeType === FOLDER_MIME) {
          const p = pathOfFolder(f.id);
          if (p !== null && !folders.has(p)) folders.set(p, f.id);
        }
      }
      for (const f of all) {
        if (f.mimeType === FOLDER_MIME || f.mimeType.startsWith('application/vnd.google-apps.')) continue;
        const parent = f.parents?.[0];
        const dir = parent ? pathOfFolder(parent) : null;
        if (dir === null) continue;
        addFile(dir ? `${dir}/${f.name}` : f.name, f);
      }
    } else {
      let level = [rootId];
      while (level.length) {
        const next: string[] = [];
        for (let i = 0; i < level.length; i += 40) {
          const chunk = level.slice(i, i + 40);
          const q = `(${chunk.map((id) => `${driveQuote(id)} in parents`).join(' or ')}) and trashed = false`;
          const children = (await this.query(q, opts.signal)).filter(usable).sort(byCreated);
          for (const f of children) {
            const parent = f.parents?.find((p) => folderPath.has(p));
            if (parent === undefined) continue;
            const dir = folderPath.get(parent)!;
            const p = dir ? `${dir}/${f.name}` : f.name;
            if (f.mimeType === FOLDER_MIME) {
              if (folderPath.has(f.id)) continue;
              folderPath.set(f.id, p);
              if (!folders.has(p)) folders.set(p, f.id);
              next.push(f.id);
            } else if (!f.mimeType.startsWith('application/vnd.google-apps.')) addFile(p, f);
          }
        }
        level = next;
      }
    }

    this.folders = folders;
    this.files = filesByPath;
    this.freshFolders.clear();
    return [...filesByPath].map(([p, f]) => toEntry(p, f));
  }

  async read(path: string, opts: RemoteCallOptions = {}): Promise<RemoteFile | null> {
    const p = safePath(path);
    for (let attempt = 0; attempt < 2; attempt++) {
      // Metadata first, then content: the rev can only be older than the bytes, never newer,
      // so a race costs at most one redundant download on the next sync.
      const f = await this.lookup(p, opts.signal, true);
      if (!f) return null;
      const res = await this.call('GET', `${DRIVE_API}/files/${encodeURIComponent(f.id)}?alt=media`, 'download', { signal: opts.signal, allow404: true });
      if (!res) {
        this.files.delete(p);
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { bytes, rev: revOf(f), mtime: f.modifiedTime ? Date.parse(f.modifiedTime) : undefined };
    }
    return null;
  }

  async write(path: string, bytes: Uint8Array, ifMatch?: string | null, opts: RemoteCallOptions = {}): Promise<RemoteEntry> {
    const p = safePath(path);
    if (p === '') throw new Error('Cannot write to the vault root');
    const signal = opts.signal;
    // Drive v3 has no If-Match for content: check the current rev right before writing.
    let existing = await this.lookup(p, signal, ifMatch !== undefined);
    if (ifMatch === null && existing) throw new PreconditionFailedError(p, 'exists');
    if (typeof ifMatch === 'string' && (!existing || revOf(existing) !== ifMatch)) {
      throw new PreconditionFailedError(p, existing ? `rev ${revOf(existing)}` : 'missing');
    }
    const mime = mimeTypeFor(p);
    let f: DriveFile | null = null;
    if (existing) {
      const res = await this.call('PATCH', `${UPLOAD_API}/files/${encodeURIComponent(existing.id)}?uploadType=media&fields=${FILE_FIELDS}`, 'update', {
        body: bytes,
        headers: { 'Content-Type': mime },
        signal,
        allow404: true,
      });
      if (res) f = (await res.json()) as DriveFile;
      else {
        this.files.delete(p);
        if (typeof ifMatch === 'string') throw new PreconditionFailedError(p, 'missing');
        existing = null;
      }
    }
    if (!f) {
      const parentId = await this.ensureFolder(dirOf(p), signal);
      const boundary = `inkstone-${randomToken(12)}`;
      const meta = JSON.stringify({ name: nameOf(p), parents: [parentId], mimeType: mime });
      const body = concatBytes([
        utf8Encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
        bytes,
        utf8Encode(`\r\n--${boundary}--\r\n`),
      ]);
      const res = await this.call('POST', `${UPLOAD_API}/files?uploadType=multipart&fields=${FILE_FIELDS}`, 'create', {
        body,
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        signal,
      });
      f = (await res!.json()) as DriveFile;
    }
    this.files.set(p, f);
    return toEntry(p, f);
  }

  async delete(path: string, ifMatch?: string, opts: RemoteCallOptions = {}): Promise<void> {
    const p = safePath(path);
    const f = await this.lookup(p, opts.signal, ifMatch !== undefined);
    if (!f) {
      if (ifMatch !== undefined) throw new PreconditionFailedError(p, 'missing');
      return;
    }
    if (ifMatch !== undefined && revOf(f) !== ifMatch) throw new PreconditionFailedError(p, `rev ${revOf(f)}`);
    const url = `${DRIVE_API}/files/${encodeURIComponent(f.id)}`;
    if (this.opts.permanentDelete) await this.call('DELETE', url, 'delete', { signal: opts.signal, allow404: true });
    else {
      await this.call('PATCH', `${url}?fields=id`, 'trash', {
        body: JSON.stringify({ trashed: true }),
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        signal: opts.signal,
        allow404: true,
      });
    }
    this.files.delete(p);
  }
}

