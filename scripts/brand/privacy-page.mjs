#!/usr/bin/env node
/**
 * Renders docs/PRIVACY.md to site/privacy.html — the public privacy policy URL Google Play needs
 * (https://karthikkasukurti.github.io/inkwright/privacy.html). The Markdown stays the source of
 * truth; the Pages workflow regenerates this file on every deploy.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const md = readFileSync(join(root, 'docs', 'PRIVACY.md'), 'utf8')
  // Links to other docs point at the repository.
  .replace(/\]\((?!https?:)([A-Z_]+\.md)(#[^)]*)?\)/g, '](https://github.com/karthikkasukurti/inkwright/blob/main/docs/$1$2)');
const body = marked.parse(md);
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy policy — Inkwright</title>
<meta name="description" content="Inkwright collects nothing. Your notes stay on your devices and in storage you choose.">
<link rel="icon" href="app/favicon.svg" type="image/svg+xml">
<style>
  :root { --desk:#e8e5ea; --paper:#fffdf7; --ink:#2b2330; --ink-2:#5f5666; --line:rgba(43,35,48,.12); --iron:#356b53; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --desk:#1a161c; --paper:#221d25; --ink:#eee8f0; --ink-2:#b9b0bf; --line:rgba(238,232,240,.12); --iron:#8cc4a8; } }
  body { margin:0; background:var(--desk); color:var(--ink); font:17px/1.65 'Hanken Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 40px 20px 80px; }
  article { background: var(--paper); border-radius: 14px; padding: clamp(20px, 5vw, 48px); border: 1px solid var(--line); }
  h1, h2 { font-family: 'Brygada 1918', 'Iowan Old Style', Georgia, serif; font-weight: 500; line-height: 1.2; }
  h1 { font-size: 34px; margin-top: 0; } h2 { font-size: 24px; margin-top: 2em; }
  a { color: var(--iron); } code { font-size: .9em; } p, li { color: var(--ink); } em { color: var(--ink-2); }
  nav { margin-bottom: 18px; } nav a { text-decoration: none; font-weight: 600; }
</style></head>
<body><main><nav><a href="./">← Inkwright</a></nav><article>
${body}
</article></main></body></html>
`;
writeFileSync(join(root, 'site', 'privacy.html'), html);
console.log('wrote site/privacy.html');
