/**
 * The credential executor's local wire protocol: one JSON object per line over a Unix domain
 * socket (macOS, Linux) or a named pipe (Windows). Deliberately small — there is no operation
 * that returns a secret:
 *
 * | op | asks the executor to | answer |
 * | --- | --- | --- |
 * | `hello` | accept this connection (with the capability token) | the credentials' names, kinds and hosts |
 * | `list` | describe the credentials again | same, never the secrets |
 * | `http` | make one HTTPS request to a credential's own base URL, authenticated with it | `head`, then `chunk`s, then `end` |
 * | `tools` | list a connector's tools | MCP tool descriptions |
 * | `tool` | call one tool on a connector | the MCP `CallToolResult` |
 * | `cancel` | abort a request in flight | — |
 *
 * Frames are capped (`MAX_FRAME`), so a client can't make the executor buffer without bound.
 */
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import * as path from 'node:path';
import type { Socket } from 'node:net';

export const PROTOCOL_VERSION = 1;
/** Largest frame either side accepts (request bodies with images can be large). */
export const MAX_FRAME = 24 * 1024 * 1024;

export interface Actor {
  /** Who is asking: `runner`, `proxy`, `desktop`, `server`… */
  source: string;
  label?: string;
  runId?: string;
}

export type Request =
  | { id: number; op: 'hello'; token: string; client: { name: string; pid: number; version?: string } }
  | { id: number; op: 'list' }
  | { id: number; op: 'http'; credential: string; actor?: Actor; request: { method: string; url: string; headers: Record<string, string>; body?: string /* base64 */ } }
  | { id: number; op: 'tools'; credential: string; actor?: Actor }
  | { id: number; op: 'tool'; credential: string; actor?: Actor; tool: string; args: Record<string, unknown> }
  | { id: number; op: 'cancel'; target: number };

export interface CredentialSummary {
  name: string;
  kind: 'provider' | 'connector' | 'api';
  /** Provider id (provider credentials). */
  provider?: string;
  /** Base URL or connector URL: where the secret may be sent. Not secret. */
  url: string;
  server?: string;
}

export type Response =
  | { id: number; type: 'ok'; result: unknown }
  | { id: number; type: 'head'; status: number; headers: Record<string, string> }
  | { id: number; type: 'chunk'; data: string /* base64 */ }
  | { id: number; type: 'end' }
  | { id: number; type: 'error'; code: ErrorCode; message: string };

export type ErrorCode = 'unauthenticated' | 'bad_request' | 'not_found' | 'policy_blocked' | 'upstream' | 'too_large' | 'busy' | 'cancelled' | 'internal';

/** Where the executor listens: a socket in the private credentials folder, or a per-user pipe. */
export function executorEndpoint(dir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const h = createHash('sha256').update(`${userInfo().username}\n${path.resolve(dir)}`).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\inkwright-credentials-${h}`;
  }
  return path.join(dir, 'run', 'executor.sock');
}

/** The capability token file: only processes that can read the user's private folder can connect. */
export const tokenFile = (dir: string) => path.join(dir, 'run', 'executor.token');

/**
 * Splits a byte stream into JSON lines. Calls `onFrame` per object and `onError` once (then stops)
 * when a frame is too large or not JSON.
 */
export function readFrames(socket: Socket, onFrame: (v: unknown) => void, onError: (e: Error) => void): void {
  let buf = '';
  let dead = false;
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    if (dead) return;
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        dead = true;
        onError(new Error('Malformed frame'));
        return;
      }
      onFrame(v);
    }
    if (buf.length > MAX_FRAME) {
      dead = true;
      onError(new Error('Frame too large'));
    }
  });
}

export function writeFrame(socket: Socket, v: unknown): boolean {
  if (socket.destroyed) return false;
  return socket.write(`${JSON.stringify(v)}\n`);
}
