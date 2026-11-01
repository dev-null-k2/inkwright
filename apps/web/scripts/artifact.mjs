// Turns the single-file build into an artifact page body: claude.ai wraps pages in its own
// <!doctype><html><head><body> skeleton, so we emit only <title>, styles, the root and scripts.
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('../dist-single/index.html', import.meta.url), 'utf8');
const take = (open, close) => {
  const out = [];
  let i = 0;
  for (;;) {
    const a = src.indexOf(open, i);
    if (a < 0) break;
    const b = src.indexOf(close, a);
    if (b < 0) break;
    out.push(src.slice(a, b + close.length));
    i = b + close.length;
  }
  return out;
};
const title = take('<title>', '</title>')[0] ?? '<title>Inkstone</title>';
const styles = take('<style', '</style>');
const scripts = take('<script', '</script>');
const page = [
  title,
  '<meta name="description" content="Inkstone — handwriting notes that feel like paper, with your own AI.">',
  ...styles,
  '<div id="root"></div>',
  // Literal U+FFFD (used by some libraries in strings/regexes) becomes its JS escape so the page
  // passes the publisher's encoding check; inside JS strings and regexes the meaning is identical.
  ...scripts.map((s) => s.replace(' crossorigin', '').replaceAll('\uFFFD', '\\uFFFD')),
].join('\n');
writeFileSync(new URL('../dist-single/inkstone.html', import.meta.url), page);
console.log(`artifact page: ${(page.length / 1048576).toFixed(2)} MB, ${styles.length} style, ${scripts.length} script blocks`);
