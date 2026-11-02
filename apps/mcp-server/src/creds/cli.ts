/**
 * `inkwright-mcp creds …` — manage the credential store and run the executor (docs/CREDENTIALS.md).
 * Secrets are read from stdin, a terminal prompt with echo off, or a named environment variable —
 * never from the command line, where `ps` would show them.
 */
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { getProviderInfo } from '@inkwright/ai';
import { CliError, expandHome } from '../cli.ts';
import { CredentialClient } from './client.ts';
import { CredentialExecutor } from './executor.ts';
import { detectKeychain } from './keychain.ts';
import { CredentialStore, defaultCredentialsDir, type CredentialMeta } from './store.ts';

export const CREDS_USAGE = `inkwright-mcp creds — keys held by a separate process (docs/CREDENTIALS.md)

  creds init [--passphrase]                 Create the store (key in the OS keychain, or a passphrase)
  creds add <name> --provider <id> [--base-url <url>] [--model <glob>]…
  creds add <name> --connector <mcp url> [--server <app name>] [--tool <glob>]…
  creds add <name> --api <base url>         Add a key (read from stdin, a prompt, or --from-env VAR)
  creds list                                Names, kinds and where each may be sent (never the keys)
  creds remove <name>
  creds serve --vault <dir> [--policy <file>] [--audit-key <file>]
                                            Run the executor (the runner and the proxy connect to it)
  creds status                              Ask a running executor what it offers

Options: --dir <folder> (default $INKWRIGHT_CREDENTIALS_DIR or ~/.config/inkwright/credentials),
--passphrase-file <file> (0600) or $INKWRIGHT_CREDENTIALS_PASSPHRASE for passphrase stores.
`;

/** Reads a line from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new CliError('No terminal to ask on: pipe the value on stdin, or use --from-env / --passphrase-file.');
  let muted = false;
  const out = new Writable({ write: (chunk, _enc, cb) => { if (!muted) process.stderr.write(chunk); cb(); } });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (a) => {
      rl.close();
      process.stderr.write('\n');
      resolve(a);
    });
    muted = true;
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

export async function passphraseFrom(values: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (typeof values['passphrase-file'] === 'string') return (await readFile(expandHome(values['passphrase-file']), 'utf8')).replace(/\r?\n$/, '');
  if (env.INKWRIGHT_CREDENTIALS_PASSPHRASE) return env.INKWRIGHT_CREDENTIALS_PASSPHRASE;
  return undefined;
}

export async function openStore(dir: string, values: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): Promise<CredentialStore> {
  return CredentialStore.unlock(dir, {
    keychain: detectKeychain({ dir }),
    passphrase: async () => (await passphraseFrom(values, env)) ?? promptHidden('Credential store passphrase: '),
  });
}

export async function credsCli(argv: string[], out: (s: string) => void = (s) => process.stdout.write(`${s}\n`), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [cmd, ...rest] = argv;
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        dir: { type: 'string' }, passphrase: { type: 'boolean' }, 'passphrase-file': { type: 'string' },
        provider: { type: 'string' }, 'base-url': { type: 'string' }, model: { type: 'string', multiple: true },
        connector: { type: 'string' }, server: { type: 'string' }, tool: { type: 'string', multiple: true },
        api: { type: 'string' }, 'from-env': { type: 'string' },
        vault: { type: 'string' }, policy: { type: 'string' }, 'audit-key': { type: 'string' }, json: { type: 'boolean' },
      },
    });
  } catch (e) {
    throw new CliError((e as Error).message);
  }
  const { values, positionals } = parsed;
  const dir = path.resolve(expandHome(values.dir ?? defaultCredentialsDir(env)));
  switch (cmd) {
    case 'init': {
      const keychain = values.passphrase ? null : detectKeychain({ dir });
      let passphrase: string | undefined;
      if (!keychain) {
        passphrase = (await passphraseFrom(values, env)) ?? (await promptHidden('Choose a passphrase (12+ characters): '));
        if (!(await passphraseFrom(values, env))) {
          const again = await promptHidden('Repeat it: ');
          if (again !== passphrase) throw new CliError('The passphrases differ.');
        }
      }
      await CredentialStore.create(dir, { keychain, ...(passphrase !== undefined ? { passphrase } : {}) });
      out(`Created a credential store in ${dir}; its key is kept by ${keychain ? keychain.label : 'your passphrase (scrypt)'}.`);
      out(`Add a key with: inkwright-mcp creds add <name> --provider anthropic`);
      return;
    }
    case 'add': {
      const name = positionals[0];
      if (!name) throw new CliError('creds add needs a name.');
      let meta: CredentialMeta;
      if (values.provider) {
        const info = getProviderInfo(values.provider);
        if (!info) throw new CliError(`Unknown provider ${values.provider}.`);
        const baseUrl = values['base-url'] ?? info.defaultBaseUrl;
        if (!baseUrl) throw new CliError(`${info.label} needs --base-url.`);
        meta = { kind: 'provider', provider: info.id, baseUrl, ...(values.model?.length ? { models: values.model } : {}) };
      } else if (values.connector) meta = { kind: 'connector', url: values.connector, ...(values.server ? { server: values.server } : {}), ...(values.tool?.length ? { tools: values.tool } : {}) };
      else if (values.api) meta = { kind: 'api', baseUrl: values.api };
      else throw new CliError('Say what the key is for: --provider <id>, --connector <url> or --api <url>.');
      const store = await openStore(dir, values, env);
      const secret = values['from-env'] ? env[values['from-env']] : process.stdin.isTTY ? await promptHidden(`Key for ${name}: `) : await readStdin();
      if (!secret) throw new CliError(values['from-env'] ? `${values['from-env']} is empty.` : 'No key given.');
      const info = await store.put(name, meta, secret.trim());
      out(`Stored ${info.name} (${info.kind}). It can only be sent to ${'baseUrl' in info ? info.baseUrl : info.url}.`);
      return;
    }
    case 'list': {
      const store = await openStore(dir, values, env);
      const list = store.list();
      if (values.json) return out(JSON.stringify(list, null, 2));
      if (!list.length) return out('No credentials yet.');
      for (const c of list) out(`${c.name.padEnd(20)} ${c.kind.padEnd(9)} ${c.kind === 'provider' ? `${c.provider} ${c.baseUrl}${c.models ? ` (models ${c.models.join(', ')})` : ''}` : c.kind === 'connector' ? `${c.url}${c.server ? ` (${c.server})` : ''}` : c.baseUrl}`);
      return;
    }
    case 'remove': {
      const name = positionals[0];
      if (!name) throw new CliError('creds remove needs a name.');
      const store = await openStore(dir, values, env);
      out((await store.remove(name)) ? `Removed ${name}.` : `No credential named ${name}.`);
      return;
    }
    case 'serve': {
      const vault = values.vault ?? env.INKWRIGHT_VAULT;
      if (!vault) throw new CliError('creds serve needs --vault <dir>: its AI policy applies to every request and its audit trail records them.');
      const store = await openStore(dir, values, env);
      const ex = new CredentialExecutor({ store, vaultRoot: path.resolve(expandHome(vault)), ...(values.policy ? { managedPolicyFile: path.resolve(expandHome(values.policy)) } : {}), ...(values['audit-key'] ? { auditKeyFile: path.resolve(expandHome(values['audit-key'])) } : {}), log: (m) => process.stderr.write(`[inkwright-creds] ${m}\n`) });
      await ex.listen();
      const stop = () => void ex.close().finally(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      await new Promise(() => {});
      return;
    }
    case 'status': {
      const c = await CredentialClient.connect({ dir, name: 'creds status' });
      const list = await c.list();
      c.close();
      if (values.json) return out(JSON.stringify(list, null, 2));
      out(`The credential executor is running with ${list.length} credential(s):`);
      for (const x of list) out(`  ${x.name.padEnd(20)} ${x.kind.padEnd(9)} ${x.provider ? `${x.provider} ` : ''}${x.url}`);
      return;
    }
    case undefined:
    case 'help':
      out(CREDS_USAGE);
      return;
    default:
      throw new CliError(`Unknown creds command: ${cmd}`);
  }
}
