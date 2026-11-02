#!/usr/bin/env node
/**
 * `inkwright` — the vault from a terminal, for developers and coding agents:
 *
 *   inkwright mcp [options]            start the MCP server (same options as inkwright-mcp)
 *   inkwright scan <repo> --vault <v>  scan a repository into the vault's code graph
 *   inkwright drift <vault>            list notes whose linked code changed since they were written
 *   inkwright context validate <file>  check a context pack against the open format
 *                                      (spec/personal-context/v1.md)
 *
 * `scan` and `drift` need no AI and never change a note: scan writes only
 * `code/sources/<id>/`, drift only reads. Exit codes: 0 ok, 1 drift found with --check, 2 usage.
 */
import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { Vault, VaultLayout, describeDrift, validateContextPackText, type DriftItem } from '@inkwright/core';
import { expandHome } from './cli.ts';
import { scanFolderIntoVault, vaultDrift } from './dev/repo.ts';
import { NodeFS } from './nodefs.ts';
import { VERSION } from './version.ts';

export const INKWRIGHT_USAGE = `inkwright — your Inkwright notes vault from the terminal

Usage:
  inkwright mcp --vault <dir> [inkwright-mcp options]   Start the MCP server (see inkwright mcp --help)
  inkwright scan <repo> --vault <dir> [--name <name>] [--id <id>] [--max-files <n>] [--json]
                                                      Scan a repository's code into the vault
  inkwright drift <vault> [--json] [--check]           Code links whose code changed since the note
                                                      was written; --check exits 1 when there are any
  inkwright context validate <file> [--json] [--strict]
                                                      Check a context pack (JSON, or a folder with
                                                      pack.json) against spec/personal-context/v1.md;
                                                      --strict also fails on warnings
  inkwright --version | --help

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
  const dir = values.vault ?? process.env.INKWRIGHT_VAULT;
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
  const dir = positionals[0] ?? values.vault ?? process.env.INKWRIGHT_VAULT;
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
    out('\nReview these notes, then mark the links reviewed in Inkwright (the note text is never changed for you).');
  }
  return values.check && items.length ? 1 : 0;
}

async function context(argv: string[], out: (s: string) => void): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== 'validate') throw new UsageError(sub ? `Unknown context command: ${sub}` : 'context needs a command: validate <file>.');
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: 'boolean' }, strict: { type: 'boolean' } } });
  const target = positionals[0];
  if (!target) throw new UsageError('context validate needs a file.');
  const p = path.resolve(expandHome(target));
  const st = statSync(p, { throwIfNoEntry: false });
  if (!st) throw new UsageError(`No such file: ${target}`);
  // A saved pack (ai/packs/<id>/) holds pack.json next to pack.md.
  const file = st.isDirectory() ? path.join(p, 'pack.json') : p;
  const r = validateContextPackText(readFileSync(file, 'utf8'));
  const failed = !r.ok || (values.strict === true && r.issues.length > 0);
  if (values.json) out(JSON.stringify({ file, valid: !failed, format: r.format, issues: r.issues }, null, 2));
  else {
    for (const i of r.issues) out(`${i.level === 'error' ? 'error' : 'warning'} ${i.path || '/'}: ${i.message}`);
    const errors = r.issues.filter((i) => i.level === 'error').length;
    const warnings = r.issues.length - errors;
    out(failed ? `${file}: not a valid context pack (${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}).` : `${file}: valid ${r.format}${warnings ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : ''}.`);
  }
  return failed ? 1 : 0;
}

/** Runs the CLI; returns the exit code (the `mcp` command keeps running and never returns). */
export async function runInkwrightCli(argv: string[], out: (s: string) => void = (s) => process.stdout.write(`${s}\n`), err: (s: string) => void = (s) => process.stderr.write(`${s}\n`)): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'scan': return await scan(rest, out);
      case 'drift': return await drift(rest, out);
      case 'context': return await context(rest, out);
      case 'mcp': {
        // The MCP server is its own entry (index.ts); it reads process.argv when imported.
        process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
        await import('./index.ts');
        return new Promise<number>(() => {});
      }
      case '--version': case '-v': out(VERSION); return 0;
      case undefined: case 'help': case '--help': case '-h': out(INKWRIGHT_USAGE); return 0;
      default: throw new UsageError(`Unknown command: ${cmd}`);
    }
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      err(`${(e as Error).message}\n\n${INKWRIGHT_USAGE}`);
      return 2;
    }
    err(`error: ${process.env.INKWRIGHT_DEBUG ? ((e as Error).stack ?? e) : ((e as Error).message ?? e)}`);
    return 1;
  }
}

const isMain = process.argv[1] && /inkwright(-cli)?(\.ts|\.js)?$/.test(process.argv[1]);
if (isMain) void runInkwrightCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
