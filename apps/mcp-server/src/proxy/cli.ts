/** `inkwright-mcp proxy` — the context-saving proxy (proxy/server.ts, docs/PROXY.md). */
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { CliError, expandHome } from '../cli.ts';
import { DiskContentStore, defaultOriginalsDir } from './originals.ts';
import { ContextProxy, type Upstream, type UpstreamAuth } from './server.ts';

export const PROXY_USAGE = `inkwright-mcp proxy — shorten large tool output before it reaches the model (docs/PROXY.md)

Usage:
  inkwright-mcp proxy --vault <dir> [--port 8787] [options]

Then point a tool at it:  OPENAI_BASE_URL=http://127.0.0.1:8787/v1   ANTHROPIC_BASE_URL=http://127.0.0.1:8787

Options:
  --vault <dir>               Vault whose AI policy (compression settings) applies and whose usage files
                              record what was saved (the app's AI usage page). Default $INKWRIGHT_VAULT.
  --port <n>                  Port on 127.0.0.1 (default 8787).
  --openai-upstream <url>     Where OpenAI-style requests go (default https://api.openai.com/v1).
  --anthropic-upstream <url>  Where Anthropic requests go (default https://api.anthropic.com).
  --key-from <client|env>     Upstream key: the client's own header (default), or OPENAI_API_KEY /
                              ANTHROPIC_API_KEY from this process's environment.
  --openai-credential <name>  Make OpenAI-style calls through the credential executor with this credential
  --anthropic-credential <n>  (the proxy then holds no key; docs/CREDENTIALS.md).
  --credentials-dir <dir>     The credential executor's folder.
  --originals-dir <dir>       Where originals are kept (default ~/.local/state/inkwright/originals).
  --no-compress               Forward and meter only.
  --policy <file>             Managed AI policy.
`;

export async function proxyCli(argv: string[], env: NodeJS.ProcessEnv = process.env, log: (m: string) => void = (m) => process.stderr.write(`[inkwright-proxy] ${m}\n`)): Promise<ContextProxy> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        vault: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' },
        'openai-upstream': { type: 'string' }, 'anthropic-upstream': { type: 'string' },
        'key-from': { type: 'string' }, 'openai-credential': { type: 'string' }, 'anthropic-credential': { type: 'string' },
        'credentials-dir': { type: 'string' }, 'originals-dir': { type: 'string' }, 'no-compress': { type: 'boolean' }, policy: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (e) {
    throw new CliError((e as Error).message);
  }
  if (values.help) {
    process.stdout.write(PROXY_USAGE);
    process.exit(0);
  }
  const vault = values.vault ?? env.INKWRIGHT_VAULT;
  if (!vault) throw new CliError('proxy needs --vault <dir>: savings are recorded in its usage files and its AI policy applies.');
  const port = Number(values.port ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliError(`Invalid --port ${values.port}`);
  if (values.host && !/^(127\.0\.0\.1|localhost|::1)$/.test(values.host)) throw new CliError('The proxy only listens on this computer (127.0.0.1).');
  const keyFrom = values['key-from'] ?? 'client';
  if (keyFrom !== 'client' && keyFrom !== 'env') throw new CliError('--key-from is client or env.');

  let executor: import('../creds/client.ts').CredentialClient | null = null;
  const auth = async (up: Upstream): Promise<UpstreamAuth> => {
    const cred = up === 'openai' ? values['openai-credential'] : values['anthropic-credential'];
    if (cred) {
      const { CredentialClient } = await import('../creds/client.ts');
      const { defaultCredentialsDir } = await import('../creds/store.ts');
      executor ??= await CredentialClient.connect({ dir: values['credentials-dir'] ? path.resolve(expandHome(values['credentials-dir'])) : defaultCredentialsDir(env), name: 'inkwright-proxy', actor: { source: 'proxy', label: 'Context proxy' } });
      const c = executor.find(cred);
      if (!c || c.kind === 'connector') throw new CliError(`The credential executor has no provider or API credential named ${cred}.`);
      return { kind: 'executor', fetch: executor.fetchFor(cred) as typeof globalThis.fetch, baseUrl: c.url };
    }
    if (keyFrom === 'env') {
      const key = up === 'openai' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY;
      if (key) return { kind: 'key', key };
      log(`No ${up === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} in the environment: ${up} requests use the client's own key.`);
    }
    return { kind: 'client' };
  };
  const originals = new DiskContentStore(values['originals-dir'] ? path.resolve(expandHome(values['originals-dir'])) : defaultOriginalsDir(env));
  const proxy = new ContextProxy({
    vaultRoot: path.resolve(expandHome(vault)),
    ...(values.policy ? { managedPolicyFile: path.resolve(expandHome(values.policy)) } : {}),
    originals,
    port,
    compress: !values['no-compress'],
    upstreams: {
      openai: { baseUrl: values['openai-upstream'] ?? 'https://api.openai.com/v1', auth: await auth('openai') },
      anthropic: { baseUrl: values['anthropic-upstream'] ?? 'https://api.anthropic.com', auth: await auth('anthropic') },
    },
    log,
  });
  const url = await proxy.listen();
  log(`Listening on ${url} — OPENAI_BASE_URL=${url}/v1  ANTHROPIC_BASE_URL=${url}`);
  log(`Originals kept in ${originals.dir}; savings recorded in ${path.join(vault, 'ai/usage')} as ${proxy.device}`);
  const stop = () => void proxy.close().finally(() => { executor?.close(); process.exit(0); });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return proxy;
}
