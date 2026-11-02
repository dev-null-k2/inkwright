#!/usr/bin/env node
/**
 * Renders the GitHub social preview (docs/media/social.png, 1280×640) from social.html, using the
 * README art and a real screenshot. Run after `npm run art` and the screenshot spec.
 */
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await page.goto(pathToFileURL(join(here, 'social.html')).href);
await page.waitForLoadState('networkidle').catch(() => {});
await page.screenshot({ path: join(here, '..', '..', 'docs', 'media', 'social.png') });
await browser.close();
console.log('wrote docs/media/social.png');
