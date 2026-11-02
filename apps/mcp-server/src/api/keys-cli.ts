/**
 * `inkstone-mcp keys …` — manage REST API keys from a terminal (the app's Settings › Developer
 * does the same). Keys are written hashed to the vault's `api/keys.json`, so a running server
 * (here or on another computer, once synced) accepts them without a restart.
 */
import { parseArgs } from 'node:util';
import { API_SCOPES, type ApiScope } from '@inkstone/core';
import { CliError, expandHome } from '../cli.ts';
import { createContext } from '../context.ts';
import { KeyStore } from './keys.ts';

export const KEYS_USAGE = `inkstone-mcp keys — API keys for the REST API (docs/API.md)

  inkstone-mcp keys create --vault <dir> --name <name> --scope <scope> [--scope …] [--expires-days <n>]
  inkstone-mcp keys list   --vault <dir>
  inkstone-mcp keys revoke --vault <dir> <key id>

Scopes: ${API_SCOPES.join(', ')}
The key is printed once; only its hash is stored.
`;

export async function keysCli(argv: string[], out: (s: string) => void = (s) => process.stdout.write(s), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [cmd, ...rest] = argv;
  let parsed;
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, strict: true, options: { vault: { type: 'string' }, name: { type: 'string' }, scope: { type: 'string', multiple: true }, 'expires-days': { type: 'string' }, json: { type: 'boolean', default: false } } });
  } catch (e) {
    throw new CliError((e as Error).message);
  }
  const { values, positionals } = parsed;
  const vault = values.vault ?? env.INKSTONE_VAULT;
  if (!cmd || !['create', 'list', 'revoke'].includes(cmd)) throw new CliError(`Unknown keys command "${cmd ?? ''}".`);
  if (!vault) throw new CliError('Pass --vault <dir> (or set INKSTONE_VAULT).');
  const ctx = await createContext({ root: expandHome(vault), watch: false });
  try {
    const keys = new KeyStore(ctx);
    if (cmd === 'list') {
      const list = await keys.list();
      if (values.json) return out(`${JSON.stringify(list.map(({ hash: _h, ...k }) => k), null, 2)}\n`);
      if (!list.length) return out('No API keys yet. Create one with: inkstone-mcp keys create --vault … --name … --scope notes:read\n');
      for (const k of list) out(`${k.id}  ${k.prefix}_…  ${k.name}  [${k.scopes.join(' ')}]${k.revokedAt ? '  revoked' : k.expiresAt && k.expiresAt < Date.now() ? '  expired' : ''}\n`);
      return;
    }
    if (cmd === 'create') {
      if (!values.name) throw new CliError('Pass --name, e.g. --name "Shortcuts on my phone".');
      const scopes = (values.scope ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
      if (!scopes.length) throw new CliError(`Pass at least one --scope (${API_SCOPES.join(', ')}).`);
      const bad = scopes.filter((s) => !(API_SCOPES as readonly string[]).includes(s));
      if (bad.length) throw new CliError(`Unknown scope ${bad.join(', ')}. Known: ${API_SCOPES.join(', ')}.`);
      const days = values['expires-days'] ? Number(values['expires-days']) : undefined;
      if (days !== undefined && (!Number.isInteger(days) || days < 1)) throw new CliError('--expires-days must be a whole number of days.');
      const { key, record } = await keys.create({ name: values.name, scopes: scopes as ApiScope[], createdBy: 'cli', ...(days ? { expiresInDays: days } : {}) });
      if (values.json) return out(`${JSON.stringify({ id: record.id, key, scopes: record.scopes }, null, 2)}\n`);
      out(`Created "${record.name}" (${record.id}) with ${record.scopes.join(', ')}.\n\n  ${key}\n\nCopy it now: it is not shown again (only a hash is stored).\n`);
      return;
    }
    const id = positionals[0];
    if (!id) throw new CliError('Pass the id of the key to revoke (see keys list).');
    const r = await keys.revoke(id);
    if (!r) throw new CliError(`There is no key ${id}.`);
    out(`Revoked "${r.name}" (${r.id}).\n`);
  } finally {
    ctx.close();
  }
}
