// Turns the single-file build into an artifact page body: claude.ai wraps pages in its own
// <!doctype><html><head><body> skeleton, so we emit only <title>, styles, the root and scripts.
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('../dist-single/index.html', import.meta.url), 'utf8');
// Top-level <style> and <script> elements in document order. Scanning sequentially (and skipping
// over each element's body) matters: bundled code contains strings like "<style:master-page" (ODS
// XML in SheetJS) and HTML templates with their own tags, which must not be mistaken for elements.
const blocks = { style: [], script: [] };
for (let i = 0; ; ) {
  const m = /<(style|script)[\s>]/g;
  m.lastIndex = i;
  const hit = m.exec(src);
  if (!hit) break;
  const close = `</${hit[1]}>`;
  const end = src.indexOf(close, hit.index);
  if (end < 0) break;
  blocks[hit[1]].push(src.slice(hit.index, end + close.length));
  i = end + close.length;
}
const titleMatch = /<title>[^<]*<\/title>/.exec(src);
const title = titleMatch ? titleMatch[0] : '<title>Inkwright</title>';
const styles = blocks.style;
const scripts = blocks.script;
const page = [
  title,
  '<meta name="description" content="Inkwright — handwriting notes that feel like paper, with your own AI.">',
  ...styles,
  '<div id="root"></div>',
  // Literal U+FFFD (used by some libraries in strings/regexes) becomes its JS escape so the page
  // passes the publisher's encoding check; inside JS strings and regexes the meaning is identical.
  ...scripts.map((s) => s.replace(' crossorigin', '').replaceAll('\uFFFD', '\\uFFFD')),
].join('\n');
writeFileSync(new URL('../dist-single/inkwright.html', import.meta.url), page);
console.log(`artifact page: ${(page.length / 1048576).toFixed(2)} MB, ${styles.length} style, ${scripts.length} script blocks`);
