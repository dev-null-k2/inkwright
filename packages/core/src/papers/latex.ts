/**
 * The LaTeX that BibTeX files actually contain in field values: accent commands (`{\"o}`, `\'e`,
 * `\c{c}`), special-character commands (`\&`, `\ss`, `\o`), dashes, protective braces (`{DNA}`)
 * and a few text-mode commands (`\emph{…}`, `\textit{…}`). Decoding turns them into plain Unicode
 * for display and formatting; encoding escapes what BibTeX would otherwise misread on export.
 */

const ACCENTS: Record<string, string> = {
  '`': '̀', "'": '́', '^': '̂', '~': '̃', '=': '̄', u: '̆', '.': '̇',
  '"': '̈', r: '̊', H: '̋', v: '̌', d: '̣', c: '̧', k: '̨', b: '̱',
};

const SYMBOLS: Record<string, string> = {
  ss: 'ß', o: 'ø', O: 'Ø', aa: 'å', AA: 'Å', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ',
  '&': '&', '%': '%', $: '$', '#': '#', _: '_', '{': '{', '}': '}', textendash: '–', textemdash: '—',
  textquoteright: '’', textquoteleft: '‘', textquotedblleft: '“', textquotedblright: '”', ldots: '…', dots: '…',
  textellipsis: '…', S: '§', P: '¶', copyright: '©', textregistered: '®', texttrademark: '™', textasciitilde: '~',
  textbackslash: '\\', textbar: '|', textless: '<', textgreater: '>', alpha: 'α', beta: 'β', gamma: 'γ',
  delta: 'δ', mu: 'μ', pi: 'π', sigma: 'σ', lambda: 'λ', theta: 'θ', omega: 'ω', Delta: 'Δ', Omega: 'Ω',
};

/** Commands whose argument is kept as plain text (formatting is dropped). */
const TEXT_COMMANDS = new Set(['emph', 'textit', 'textbf', 'textsc', 'textrm', 'textsf', 'texttt', 'textup', 'mbox', 'url', 'href', 'textsuperscript', 'textsubscript', 'enquote', 'mkbibquote', 'NoCaseChange', 'MakeUppercase']);

/** LaTeX field value → Unicode text. Never throws; unknown commands keep their argument text. */
export function decodeLatex(input: string): string {
  let s = input;
  // Accents in every common spelling: {\"o}, \"{o}, \"o, \'{\i}.
  const accent = (m: string, acc: string, ch: string) => {
    const mark = ACCENTS[acc];
    return mark ? (ch + mark).normalize('NFC') : m;
  };
  // Symbol accents may touch their letter (\"o); letter accents (\v, \c, \u…) need a brace or a
  // space before it, otherwise `\url` would read as a breve on "r".
  s = s.replace(/\{?\\([`'^~=".])\s*\{?\\?([A-Za-z])\}?\}?/g, accent);
  s = s.replace(/\{?\\([uvrHdckb])(?:\s+|\s*\{\\?)([A-Za-z])\}?\}?/g, accent);
  // Named symbols: \ss, {\o}, \&, \textendash{}.
  s = s.replace(/\\([A-Za-z]+|[&%$#_{}])(\{\})?/g, (m, name: string) => (name in SYMBOLS ? SYMBOLS[name]! : m));
  // Text commands: \emph{x} → x (repeat for nesting).
  for (let i = 0; i < 4; i++) s = s.replace(/\\([A-Za-z]+)\*?\s*\{([^{}]*)\}/g, (m, cmd: string, arg: string) => (TEXT_COMMANDS.has(cmd) ? arg : m));
  // Inline maths: keep its content without the dollars.
  s = s.replace(/\$([^$]*)\$/g, '$1');
  // Dashes and quotes.
  s = s.replace(/---/g, '—').replace(/--/g, '–').replace(/``/g, '“').replace(/''/g, '”');
  // Non-breaking space.
  s = s.replace(/(^|[^\\])~/g, '$1 ');
  // Remaining braces only protect case; drop them.
  s = s.replace(/(^|[^\\])[{}]/g, '$1').replace(/(^|[^\\])[{}]/g, '$1');
  // Unknown commands that are left: drop the backslash, keep the name (better than raw LaTeX).
  s = s.replace(/\\([A-Za-z]+)\s?/g, '$1');
  return s.replace(/\s+/g, ' ').trim();
}

/** Escapes text for a braced BibTeX field value. Unicode is kept (biber and modern BibTeX read UTF-8). */
export function encodeLatex(text: string): string {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_])/g, '\\$1')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\^{}')
    .replace(/\\textbackslash\\\{\\\}/g, '\\textbackslash{}')
    .replace(/\\textasciitilde\\\{\\\}/g, '\\textasciitilde{}');
}
