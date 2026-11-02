#!/usr/bin/env node
/**
 * `inkstone` — the vault from a terminal, for developers and coding agents:
 *
 *   inkstone mcp [options]            start the MCP server (same options as inkstone-mcp)
 *   inkstone scan <repo> --vault <v>  scan a repository into the vault's code graph
 *   inkstone drift <vault>            list notes whose linked code changed since they were written
 *
 * `scan` and `drift` need no AI and never change a note: scan writes only
 * `code/sources/<id>/`, drift only reads. Exit codes: 0 ok, 1 drift found with --check, 2 usage.
 */
import { statSync } from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { Vault, VaultLayout, describeDrift, type DriftItem } from '@inkstone/core';
import { expandHome } from './cli.ts';
import { scanFolderIntoVault, vaultDrift } from './dev/repo.ts';
import { NodeFS } from './nodefs.ts';
import { VERSION } from './version.ts';

export const INKSTONE_USAGE = `inkstone — your Inkstone notes vault from the terminal

Usage:
  inkstone mcp --vault <dir> [inkstone-mcp options]   Start the MCP server (see inkstone mcp --help)
  inkstone scan <repo> --vault <dir> [--name <name>] [--id <id>] [--max-files <n>] [--json]
                                                      Scan a repository's code into the vault
  inkstone drift <vault> [--json] [--check]           Code links whose code changed since the note
                                                      was written; --check exits 1 when there are any
  inkstone --version | --help

Scanning parses TypeScript, JavaScript, Python, Go, Rust and Java with tree-sitter (no AI, no
network) and writes code/sources/<id>/graph.json. Notes link code as [[code:path#Symbol]].
`;

class UsageError extends Error {}

function vaultAt(dir: string): Vault {
  const root = path.resolve(expandHome(dir));
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`Vault folder not found: ${dir}`);
  return new Vault(new NodeFS(root));
}

async function scan(argv: string[], out: (s: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { vault: { type: 'string' }, name: { type: 'string' }, id: { type: 'string' }, 'max-files': { type: 'string' }, json: { type: 'boolean' } } });
  const repo = positionals[0];
  const dir = values.vault ?? process.env.INKSTONE_VAULT;
  if (!repo || !dir) throw new UsageError('scan needs a repository folder and --vault <dir>.');
  const vault = vaultAt(dir);
  if ((await vault.fs.readText(VaultLayout.MANIFEST)) == null) await vault.init();
  const maxFiles = values['max-files'] ? Number(values['max-files']) : undefined;
  if (maxFiles !== undefined && !(maxFiles > 0)) throw new UsageError('--max-files must be a positive number.');
  const { source, graph } = await scanFolderIntoVault(vault.fs, expandHome(repo), { name: values.name, id: values.id, limits: maxFiles ? { maxFiles } : undefined });
  if (values.json) {
    out(JSON.stringify({ source, warnings: graph.warnings ?? [] }, null, 2));
    return 0;
  }
  const kinds = new Map<string, number>();
  for (const s of graph.symbols) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
  out(`Scanned ${source.name} into ${path.join(dir, 'code/sources', source.id)}`);
  out(`  ${source.stats.files} files, ${source.stats.symbols} symbols (${[...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}), ${source.stats.edges} edges${source.stats.skipped ? `, ${source.stats.skipped} files skipped` : ''}`);
  for (const w of graph.warnings ?? []) out(`  note: ${w}`);
  return 0;
}

async function drift(argv: string[], out: (s: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean' }, check: { type: 'boolean' }, vault: { type: 'string' } } });
  const dir = positionals[0] ?? values.vault ?? process.env.INKSTONE_VAULT;
  if (!dir) throw new UsageError('drift needs the vault folder.');
  const items: DriftItem[] = await vaultDrift(vaultAt(dir));
  if (values.json) {
    out(JSON.stringify(items.map((d) => ({ note: d.title, noteId: d.noteId, link: d.key, status: d.status, was: d.baseline?.signature ?? null, now: d.current?.signature ?? null, movedTo: d.movedTo?.map((s) => s.id) })), null, 2));
  } else if (!items.length) {
    out('No drift: every code link matches the code it was written against.');
  } else {
    out(`${items.length} code link${items.length === 1 ? '' : 's'} drifted:\n`);
    let last = '';
    for (const d of items) {
      if (d.noteId !== last) { out(`${d.title}  (${d.noteId})`); last = d.noteId; }
      out(`  ${describeDrift(d).replace(/\n/g, '\n  ')}`);
    }
    out('\nReview these notes, then mark the links reviewed in Inkstone (the note text is never changed for you).');
  }
  return values.check && items.length ? 1 : 0;
}

/** Runs the CLI; returns the exit code (the `mcp` command keeps running and never returns). */
export async function runInkstoneCli(argv: string[], out: (s: string) => void = (s) => process.stdout.write(`${s}\n`), err: (s: string) => void = (s) => process.stderr.write(`${s}\n`)): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'scan': return await scan(rest, out);
      case 'drift': return await drift(rest, out);
      case 'mcp': {
        // The MCP server is its own entry (index.ts); it reads process.argv when imported.
        process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
        await import('./index.ts');
        return new Promise<number>(() => {});
      }
      case '--version': case '-v': out(VERSION); return 0;
      case undefined: case 'help': case '--help': case '-h': out(INKSTONE_USAGE); return 0;
      default: throw new UsageError(`Unknown command: ${cmd}`);
    }
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      err(`${(e as Error).message}\n\n${INKSTONE_USAGE}`);
      return 2;
    }
    err(`error: ${process.env.INKSTONE_DEBUG ? ((e as Error).stack ?? e) : ((e as Error).message ?? e)}`);
    return 1;
  }
}

const isMain = process.argv[1] && /inkstone(-cli)?(\.ts|\.js)?$/.test(process.argv[1]);
if (isMain) void runInkstoneCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
