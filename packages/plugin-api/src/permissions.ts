/**
 * The capabilities a plugin (or the in-page `window.inkwright` automation API) can be granted.
 *
 * Inkwright follows the model browsers use for extensions rather than the "full trust" model of
 * Obsidian or VS Code: plugin code runs in a sandbox and can only reach notes, the network or
 * the assistant through the host, and the host checks every call against what the user granted.
 * Contribution points (commands, panels, importers, exporters, settings, private storage) need no
 * permission — they only run when the user invokes them — but they are listed on the install
 * prompt so nothing a plugin adds is a surprise.
 */

/** Every permission, in the order the install prompt lists them. */
export const PERMISSIONS = ['notes:read', 'notes:write', 'editor:read', 'editor:write', 'events', 'ai:tools', 'network', 'clipboard:write'] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type Risk = 'low' | 'medium' | 'high';

export interface PermissionInfo {
  /** Short sentence-case label for the install prompt and Settings. */
  label: string;
  /** One plain sentence on what it allows. */
  description: string;
  /**
   * How much it exposes: `high` can move note content off the device or change many notes,
   * `medium` reads or changes content the user is looking at, `low` is harmless on its own.
   */
  risk: Risk;
}

export const PERMISSION_INFO: Record<Permission, PermissionInfo> = {
  'notes:read': { label: 'Read your notes', description: 'List, search and read the text of notes, including recognized handwriting.', risk: 'medium' },
  'notes:write': { label: 'Create and change notes', description: 'Create notes, add text and change titles and tags. Changes can be undone.', risk: 'medium' },
  'editor:read': { label: 'See the open note and selection', description: 'Read the title of the open note and the text you have selected.', risk: 'low' },
  'editor:write': { label: 'Add text to the open note', description: 'Place typed text on the page you are looking at. You can undo it.', risk: 'low' },
  events: { label: 'Know when notes change', description: 'Hear when notes are created, saved or opened, and when the selection changes.', risk: 'low' },
  'ai:tools': { label: 'Give the assistant new tools', description: 'Offer tools the assistant may call while it helps you.', risk: 'medium' },
  network: { label: 'Connect to the internet', description: 'Send requests to the websites listed below.', risk: 'high' },
  'clipboard:write': { label: 'Copy to the clipboard', description: 'Put text on the clipboard when you run one of its commands.', risk: 'low' },
};

export function isPermission(v: unknown): v is Permission {
  return typeof v === 'string' && (PERMISSIONS as readonly string[]).includes(v);
}

/** Which notes `notes:read` / `notes:write` reach. Absent fields mean "no restriction". */
export interface NoteScope {
  /** Only notes carrying at least one of these tags (case-insensitive, `#` optional). */
  tags?: string[];
  /** Only notes in these notebooks (by id or exact name) or their sections. */
  notebooks?: string[];
}

/** The minimum a scope check needs to know about a note. */
export interface ScopedNote {
  tags: readonly string[];
  /** The note's notebook and every notebook above it, as ids and names. */
  notebookPath: readonly { id: string; name: string }[];
}

const normTag = (t: string) => t.trim().replace(/^#/, '').toLowerCase();

/** True when a note is inside a scope (an empty or missing scope contains every note). */
export function noteInScope(scope: NoteScope | undefined, note: ScopedNote): boolean {
  if (!scope) return true;
  if (scope.tags?.length) {
    const want = new Set(scope.tags.map(normTag));
    if (!note.tags.some((t) => want.has(normTag(t)))) return false;
  }
  if (scope.notebooks?.length) {
    const want = new Set(scope.notebooks.map((n) => n.trim().toLowerCase()));
    if (!note.notebookPath.some((nb) => want.has(nb.id.toLowerCase()) || want.has(nb.name.toLowerCase()))) return false;
  }
  return true;
}

/** Plain-language summary of a scope for prompts, e.g. "notes tagged #work in Projects". */
export function describeScope(scope: NoteScope | undefined): string {
  if (!scope || (!scope.tags?.length && !scope.notebooks?.length)) return 'all notes';
  const parts: string[] = [];
  if (scope.tags?.length) parts.push(`notes tagged ${scope.tags.map((t) => `#${t.replace(/^#/, '')}`).join(' or ')}`);
  if (scope.notebooks?.length) parts.push(`${parts.length ? 'in' : 'notes in'} ${scope.notebooks.join(' or ')}`);
  return parts.join(' ');
}

/**
 * Network allowlist check. Patterns are origins (`https://hooks.example.com`), wildcard
 * subdomains (`https://*.example.com`), or `*` for any https site. Plain http is only allowed
 * for loopback addresses (a local server), and only when the pattern names it.
 */
export function hostAllowed(patterns: readonly string[] | undefined, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return false;
  for (const raw of patterns ?? []) {
    const p = raw.trim();
    if (p === '*') {
      if (u.protocol === 'https:') return true;
      continue;
    }
    const m = /^(https?):\/\/(\*\.)?([^/:*]+)(?::(\d+))?\/?$/.exec(p);
    if (!m) continue;
    const [, scheme, wild, host, port] = m;
    if (`${scheme}:` !== u.protocol) continue;
    if (port ? u.port !== port : u.port !== '') continue;
    const h = u.hostname.toLowerCase();
    const want = host!.toLowerCase();
    if (wild ? h.endsWith(`.${want}`) : h === want) return true;
  }
  return false;
}
