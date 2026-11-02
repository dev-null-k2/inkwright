/**
 * Keeps `inkwright-agent run` running in the background on each desktop OS, the native way:
 *
 * - macOS: a launchd user agent (`~/Library/LaunchAgents/app.inkwright.agent.plist`), started at
 *   login and restarted if it exits; logs to `~/Library/Logs/Inkwright/agent.log`.
 * - Linux: a systemd user unit (`~/.config/systemd/user/inkwright-agent.service`); logs in the
 *   journal. `loginctl enable-linger` keeps it running while logged out.
 * - Windows: a Task Scheduler task (XML for `schtasks /Create /XML`), started at logon with
 *   restart on failure and no time limit; logs to `%LOCALAPPDATA%\Inkwright\agent.log`.
 *
 * These are pure functions from a spec to file contents plus the exact commands to load and
 * unload the service, so they are unit-tested and `inkwright-agent install --dry-run` can show
 * everything before anything is written. Secrets never go into these files: the AI key and the
 * bearer token belong in the 0600 config file or an environment file.
 */
import * as path from 'node:path';

export type ServicePlatform = 'macos' | 'linux' | 'windows';

export interface ServiceSpec {
  /** Absolute path of the node binary. */
  node: string;
  /** Absolute path of the agent script (dist/agent.js). */
  script: string;
  /** Arguments after `run` (vault, config, http…). */
  args: string[];
  home: string;
  /** Windows: %LOCALAPPDATA% (default <home>\AppData\Local). */
  localAppData?: string;
  /** Windows: DOMAIN\user for the logon trigger. */
  user?: string;
}

export interface ServiceFile {
  platform: ServicePlatform;
  path: string;
  /** File contents (Windows task XML is UTF-16LE with a BOM, as schtasks expects). */
  content: string | Uint8Array;
  install: string[];
  uninstall: string[];
  logs: string;
}

export const LAUNCHD_LABEL = 'app.inkwright.agent';
export const SYSTEMD_UNIT = 'inkwright-agent.service';
export const WINDOWS_TASK = 'Inkwright agent';

export function currentPlatform(p: NodeJS.Platform = process.platform): ServicePlatform {
  return p === 'darwin' ? 'macos' : p === 'win32' ? 'windows' : 'linux';
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function launchdPlist(spec: ServiceSpec): ServiceFile {
  const logDir = path.posix.join(spec.home, 'Library/Logs/Inkwright');
  const argv = [spec.node, spec.script, 'run', ...spec.args];
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xml(spec.home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(`${path.posix.dirname(spec.node)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(`${logDir}/agent.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(`${logDir}/agent.log`)}</string>
</dict>
</plist>
`;
  const file = path.posix.join(spec.home, 'Library/LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  return {
    platform: 'macos',
    path: file,
    content,
    install: [`mkdir -p "${logDir}"`, `launchctl bootstrap gui/$(id -u) "${file}"`, `launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`],
    uninstall: [`launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`, `rm "${file}"`],
    logs: `tail -f "${logDir}/agent.log"`,
  };
}

/** One systemd ExecStart word: quoted when needed, with `%` and `$` escaped (systemd.service(5)). */
export function systemdQuote(a: string): string {
  const escaped = a.replace(/%/g, '%%').replace(/\$/g, '$$$$');
  return /[\s"'\\;]/.test(escaped) || escaped === '' ? `"${escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : escaped;
}

export function systemdUnit(spec: ServiceSpec): ServiceFile {
  const exec = [spec.node, spec.script, 'run', ...spec.args].map(systemdQuote).join(' ');
  const content = `[Unit]
Description=Inkwright agent (runs your routines; MCP and A2A for your notes)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
WorkingDirectory=%h
Restart=on-failure
RestartSec=30
# Secrets (AI key, token) can live here instead of the config file: KEY=value lines.
EnvironmentFile=-%h/.config/inkwright/agent.env
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
  const file = path.posix.join(spec.home, '.config/systemd/user', SYSTEMD_UNIT);
  return {
    platform: 'linux',
    path: file,
    content,
    install: ['systemctl --user daemon-reload', `systemctl --user enable --now ${SYSTEMD_UNIT}`, 'loginctl enable-linger "$USER"   # optional: keep running while logged out'],
    uninstall: [`systemctl --user disable --now ${SYSTEMD_UNIT}`, `rm "${file}"`, 'systemctl --user daemon-reload'],
    logs: `journalctl --user -u ${SYSTEMD_UNIT} -f`,
  };
}

/** One Windows command-line argument (CommandLineToArgvW rules). */
export function windowsQuote(a: string): string {
  if (a && !/[\s"]/.test(a)) return a;
  let out = '"';
  let slashes = 0;
  for (const ch of a) {
    if (ch === '\\') slashes++;
    else if (ch === '"') { out += '\\'.repeat(slashes * 2 + 1) + '"'; slashes = 0; }
    else { out += '\\'.repeat(slashes) + ch; slashes = 0; }
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

export function windowsTaskXml(spec: ServiceSpec): ServiceFile {
  const local = spec.localAppData ?? path.win32.join(spec.home, 'AppData', 'Local');
  const logFile = path.win32.join(local, 'Inkwright', 'agent.log');
  const args = [spec.script, 'run', ...spec.args, '--log-file', logFile].map(windowsQuote).join(' ');
  const text = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Inkwright agent: runs your routines and serves your notes to AI agents while you are signed in.</Description>
    <URI>\\${xml(WINDOWS_TASK)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>${spec.user ? `\n      <UserId>${xml(spec.user)}</UserId>` : ''}
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">${spec.user ? `\n      <UserId>${xml(spec.user)}</UserId>` : ''}
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(spec.node)}</Command>
      <Arguments>${xml(args)}</Arguments>
      <WorkingDirectory>${xml(spec.home)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`.replace(/\n/g, '\r\n');
  // schtasks reads task XML as UTF-16 (little endian, with a byte order mark).
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    bytes[2 + i * 2] = c & 0xff;
    bytes[3 + i * 2] = c >> 8;
  }
  const file = path.win32.join(local, 'Inkwright', 'inkwright-agent-task.xml');
  return {
    platform: 'windows',
    path: file,
    content: bytes,
    install: [`schtasks /Create /TN "${WINDOWS_TASK}" /XML "${file}" /F`, `schtasks /Run /TN "${WINDOWS_TASK}"`],
    uninstall: [`schtasks /End /TN "${WINDOWS_TASK}"`, `schtasks /Delete /TN "${WINDOWS_TASK}" /F`, `del "${file}"`],
    logs: `Get-Content -Wait "${logFile}"`,
  };
}

export function serviceFile(platform: ServicePlatform, spec: ServiceSpec): ServiceFile {
  return platform === 'macos' ? launchdPlist(spec) : platform === 'windows' ? windowsTaskXml(spec) : systemdUnit(spec);
}

/** Decodes the UTF-16LE task XML (tests, --dry-run). */
export function decodeServiceContent(c: string | Uint8Array): string {
  if (typeof c === 'string') return c;
  if (c[0] === 0xff && c[1] === 0xfe) return new TextDecoder('utf-16le').decode(c.subarray(2));
  return new TextDecoder().decode(c);
}
