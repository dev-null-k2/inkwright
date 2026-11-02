// Regenerates the desktop icons (src-tauri/icons: PNG sizes, .icns for macOS, .ico for Windows,
// tray icons) from the app's own icon, apps/web/public/icons/icon.svg, so the brand has one source.
//   npm run icons -w @inkwright/desktop
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const svg = readFileSync(path.resolve(root, '../web/public/icons/icon.svg'), 'utf8');

const render = (size, source = svg) => new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng();

const tmp = mkdtempSync(path.join(tmpdir(), 'inkwright-icons-'));
const master = path.join(tmp, 'icon-1024.png');
writeFileSync(master, render(1024));
execFileSync(process.execPath, [path.resolve(root, '../../node_modules/@tauri-apps/cli/tauri.js'), 'icon', master, '-o', path.join(root, 'src-tauri/icons')], { stdio: 'inherit' });
// The phone apps have their own icons (Capacitor); only the desktop ones are kept.
for (const d of ['android', 'ios']) rmSync(path.join(root, 'src-tauri/icons', d), { recursive: true, force: true });

// Tray: the inkstone alone on a transparent ground (the full tile reads as a blob at 22 px).
// macOS treats it as a template image (monochrome, follows the menu bar), so it is drawn in black.
const stone = svg.replace(/<rect width="64" height="64"[^>]*\/>/, '').replace(/fill="#[0-9A-Fa-f]{6}"/g, 'fill="#000000"').replace(/stroke="#[0-9A-Fa-f]{6}"/g, 'stroke="#000000"');
writeFileSync(path.join(root, 'src-tauri/icons/tray.png'), render(64, stone));
writeFileSync(path.join(root, 'src-tauri/icons/tray-paused.png'), render(64, stone.replace('<circle cx="43" cy="45" r="4.5" fill="#000000"/>', '<circle cx="43" cy="45" r="4.5" fill="none" stroke="#000000" stroke-width="1.4"/>')));
console.log('Icons written to src-tauri/icons');
