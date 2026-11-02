import { describe, expect, it } from 'vitest';
import { parseAgentCli } from '../src/agent-cli.ts';
import { parseCli } from '../src/cli.ts';
import { createAgentAI, resolveApiKey } from '../src/agent/ai.ts';
import { decodeServiceContent, launchdPlist, serviceFile, systemdQuote, systemdUnit, windowsQuote, windowsTaskXml } from '../src/runner/services.ts';

const spec = {
  node: '/opt/homebrew/bin/node',
  script: '/Users/me/inkwright/apps/mcp-server/dist/agent.js',
  args: ['--vault', '/Users/me/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/Inkwright', '--config', '/Users/me/.config/inkwright/agent.json'],
  home: '/Users/me',
};

describe('service files', () => {
  it('launchd: a user agent that starts at login, restarts on failure and logs to ~/Library/Logs', () => {
    const f = launchdPlist(spec);
    expect(f.path).toBe('/Users/me/Library/LaunchAgents/app.inkwright.agent.plist');
    const xml = f.content as string;
    expect(xml).toContain('<string>app.inkwright.agent</string>');
    expect(xml).toContain('<string>/opt/homebrew/bin/node</string>\n    <string>/Users/me/inkwright/apps/mcp-server/dist/agent.js</string>\n    <string>run</string>\n    <string>--vault</string>\n    <string>/Users/me/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/Inkwright</string>');
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(xml).toContain('/Users/me/Library/Logs/Inkwright/agent.log');
    expect(f.install).toContain('launchctl bootstrap gui/$(id -u) "/Users/me/Library/LaunchAgents/app.inkwright.agent.plist"');
    expect(f.uninstall[0]).toBe('launchctl bootout gui/$(id -u)/app.inkwright.agent');
    // XML special characters are escaped.
    expect(launchdPlist({ ...spec, args: ['--vault', '/tmp/A&B <notes>'] }).content).toContain('/tmp/A&amp;B &lt;notes&gt;');
  });

  it('systemd: a user unit with correctly quoted ExecStart and an optional env file for secrets', () => {
    const f = systemdUnit({ ...spec, node: '/usr/bin/node', home: '/home/me', script: '/home/me/inkwright/apps/mcp-server/dist/agent.js', args: ['--vault', '/home/me/Drive/My Notes', '--ai-model', 'llama3.2:3b'] });
    expect(f.path).toBe('/home/me/.config/systemd/user/inkwright-agent.service');
    const unit = f.content as string;
    expect(unit).toContain('ExecStart=/usr/bin/node /home/me/inkwright/apps/mcp-server/dist/agent.js run --vault "/home/me/Drive/My Notes" --ai-model llama3.2:3b');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('EnvironmentFile=-%h/.config/inkwright/agent.env');
    expect(unit).toContain('WantedBy=default.target');
    expect(f.install).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable --now inkwright-agent.service', expect.stringContaining('loginctl enable-linger')]);
    expect(systemdQuote('100%')).toBe('100%%');
    expect(systemdQuote('$HOME')).toBe('$$HOME');
    expect(systemdQuote('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('Windows: Task Scheduler XML in UTF-16 with a logon trigger, restart on failure and no time limit', () => {
    const f = windowsTaskXml({ node: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\Users\\me\\inkwright\\apps\\mcp-server\\dist\\agent.js', args: ['--vault', 'G:\\My Drive\\Inkwright'], home: 'C:\\Users\\me', localAppData: 'C:\\Users\\me\\AppData\\Local', user: 'LAPTOP\\me' });
    const bytes = f.content as Uint8Array;
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    const xml = decodeServiceContent(bytes);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>\r\n<Task')).toBe(true);
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<UserId>LAPTOP\\me</UserId>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain('<RestartOnFailure>');
    expect(xml).toContain('<Command>C:\\Program Files\\nodejs\\node.exe</Command>');
    expect(xml).toContain('<Arguments>C:\\Users\\me\\inkwright\\apps\\mcp-server\\dist\\agent.js run --vault &quot;G:\\My Drive\\Inkwright&quot; --log-file C:\\Users\\me\\AppData\\Local\\Inkwright\\agent.log</Arguments>');
    expect(f.install[0]).toBe('schtasks /Create /TN "Inkwright agent" /XML "C:\\Users\\me\\AppData\\Local\\Inkwright\\inkwright-agent-task.xml" /F');
    expect(windowsQuote('C:\\a b\\')).toBe('"C:\\a b\\\\"');
    expect(windowsQuote('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('picks the file for the platform', () => {
    expect(serviceFile('linux', spec).path).toMatch(/inkwright-agent\.service$/);
    expect(serviceFile('macos', spec).path).toMatch(/\.plist$/);
  });
});

describe('command lines', () => {
  it('inkwright-agent install copies the run options (absolute paths) into the service, never the token', () => {
    const c = parseAgentCli(['install', '--vault', 'notes', '--ai-provider', 'ollama', '--ai-model', 'llama3.2', '--http', '8765', '--a2a', '--platform', 'linux', '--dry-run'], {});
    expect(c.command).toBe('install');
    expect(c.platform).toBe('linux');
    expect(c.dryRun).toBe(true);
    expect(c.runArgs).toEqual(['--vault', expect.stringMatching(/^\/.*notes$/), '--ai-provider', 'ollama', '--ai-model', 'llama3.2', '--http', '8765', '--a2a']);
    expect(() => parseAgentCli(['install', '--vault', 'x', '--http', '1', '--token', 'secret'], {})).toThrow(/Don’t put the token in a service file/);
    expect(parseAgentCli(['run', '--vault', 'x', '--tick', '30'], {}).tickMs).toBe(30_000);
    expect(() => parseAgentCli(['run', '--tick', '1'], {})).toThrow(/at least 5/);
    expect(() => parseAgentCli(['dance'], {})).toThrow(/Unknown command/);
    expect(parseAgentCli([], {}).command).toBe('help');
  });

  it('inkwright-mcp options: OAuth, A2A and AI, with config file defaults', () => {
    const o = parseCli(['--vault', 'v', '--http', '8765', '--oauth-issuer', 'https://idp.example/realms/home', '--oauth-audience', 'a,b', '--a2a', '--ai-provider', 'anthropic'], {});
    expect(o.oauth).toEqual({ issuer: 'https://idp.example/realms/home', audience: ['a', 'b'], jwksUrl: undefined, readScope: 'notes:read', writeScope: 'notes:write' });
    expect(o.token).toBeUndefined();
    expect(o.ai).toMatchObject({ provider: 'anthropic' });
    expect(() => parseCli(['--vault', 'v', '--a2a'], {})).toThrow(/--a2a needs --http/);
    expect(() => parseCli(['--vault', 'v', '--http', '1', '--oauth-issuer', 'http://idp.example'], {})).toThrow(/https/);
    expect(parseCli(['--vault', 'v'], { INKWRIGHT_AI_PROVIDER: 'ollama', INKWRIGHT_AI_MODEL: 'qwen3' }).ai).toMatchObject({ provider: 'ollama', model: 'qwen3' });
  });

  it('AI keys come from the environment, with plain errors when missing', () => {
    expect(resolveApiKey({ provider: 'anthropic' }, { ANTHROPIC_API_KEY: 'k1' })).toBe('k1');
    expect(resolveApiKey({ provider: 'openai', apiKeyEnv: 'MY_KEY' }, { MY_KEY: 'k2', OPENAI_API_KEY: 'no' })).toBe('k2');
    expect(resolveApiKey({ provider: 'gemini' }, { GOOGLE_API_KEY: 'k3' })).toBe('k3');
    expect(() => createAgentAI({ provider: 'openai' }, {})).toThrow(/Set OPENAI_API_KEY/);
    expect(() => createAgentAI({ provider: 'nope' }, {})).toThrow(/Unknown AI provider/);
    const local = createAgentAI({ provider: 'ollama', model: 'llama3.2-vision' }, {});
    expect(local.label).toBe('Ollama (local) · llama3.2-vision');
  });
});
