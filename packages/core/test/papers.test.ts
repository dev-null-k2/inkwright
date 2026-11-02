import { describe, expect, it } from 'vitest';
import {
  apaInText,
  citeTrigger,
  citedKeys,
  decodeLatex,
  detectReferenceFormat,
  findDoi,
  formatApa,
  formatBibliography,
  formatIeee,
  initials,
  matchPdfs,
  parseBibName,
  parseBibtex,
  parseCitations,
  parseCslJson,
  referenceFromProperties,
  referenceProperties,
  referenceToCsl,
  suggestReferences,
  toBibtex,
  uniqueKey,
  type Reference,
} from '../src/index.ts';

const ZOTERO_BIB = String.raw`
% Exported by Zotero / Better BibTeX
@string{jml = "Journal of Machine Learning Research"}

@article{vaswani2017,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N. and Kaiser, {\L}ukasz and Polosukhin, Illia},
  journal = {Advances in Neural Information Processing Systems},
  volume = {30},
  pages = {5998--6008},
  year = {2017},
  month = dec,
  doi = {10.48550/arXiv.1706.03762},
}

@inproceedings{he2016deep,
  author    = "Kaiming He and Xiangyu Zhang and Shaoqing Ren and Jian Sun",
  title     = "Deep Residual Learning for Image Recognition",
  booktitle = {Proceedings of the {IEEE} Conference on Computer Vision and Pattern Recognition},
  pages     = {770--778},
  year      = 2016,
  address   = {Las Vegas, NV},
  doi       = {https://doi.org/10.1109/CVPR.2016.90}
}

@book{knuth1984,
  author = {Donald E. Knuth},
  title = {The {\TeX}book},
  publisher = {Addison-Wesley},
  address = {Reading, MA},
  year = {1984},
  edition = {2},
}

@phdthesis{oezt2019,
  author = {{\"O}zt{\"u}rk, Ay{\c{s}}e},
  title = {Caf{\'e} culture and the {B}ayesian brain},
  school = {Universit{\"a}t Wien},
  year = {2019}
}

@incollection{vdberg2010,
  author = {van den Berg, Jr, Jan},
  editor = {Smith, Anna and Lee, Bo},
  title = {Chapters \& verses},
  booktitle = {Handbook of Things},
  publisher = {Springer},
  pages = {1--20},
  year = 2010
}

@techreport{who2020,
  author = {{World Health Organization}},
  title = {Global report on infection prevention},
  institution = {World Health Organization},
  number = {WHO/2020.1},
  year = {2020}
}

@misc{jmlrpage,
  title = {About} # " " # jml,
  url = {https://jmlr.org/about},
  urldate = {2024-03-05},
  year = {2024}
}

@comment{this is ignored}
@article{broken, title = {Missing close}
`;

describe('BibTeX import', () => {
  const { references, errors } = parseBibtex(ZOTERO_BIB);
  const byId = Object.fromEntries(references.map((r) => [r.id, r]));

  it('reads every entry, expands macros and reports the broken one without failing', () => {
    expect(references.map((r) => r.id)).toEqual(['vaswani2017', 'he2016deep', 'knuth1984', 'oezt2019', 'vdberg2010', 'who2020', 'jmlrpage']);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/Unclosed/);
    expect(byId.jmlrpage!.title).toBe('About Journal of Machine Learning Research');
  });

  it('maps types, dates, pages and DOIs', () => {
    const v = byId.vaswani2017!;
    expect(v.type).toBe('article-journal');
    expect(v.issued).toEqual({ year: 2017, month: 12 });
    expect(v.page).toBe('5998–6008');
    expect(v.doi).toBe('10.48550/arxiv.1706.03762');
    expect(byId.he2016deep!.type).toBe('paper-conference');
    expect(byId.he2016deep!.doi).toBe('10.1109/cvpr.2016.90');
    expect(byId.oezt2019!.genre).toBe('Doctoral dissertation');
    expect(byId.who2020!.number).toBe('WHO/2020.1');
    expect(byId.jmlrpage!.type).toBe('webpage');
    expect(byId.jmlrpage!.accessed).toEqual({ year: 2024, month: 3, day: 5 });
  });

  it('decodes LaTeX accents, symbols and protective braces', () => {
    expect(byId.oezt2019!.author![0]).toEqual({ family: 'Öztürk', given: 'Ayşe' });
    expect(byId.oezt2019!.title).toBe('Café culture and the Bayesian brain');
    expect(byId.oezt2019!.publisher).toBe('Universität Wien');
    expect(byId.vaswani2017!.author![6]).toEqual({ family: 'Kaiser', given: 'Łukasz' });
    expect(byId.vdberg2010!.title).toBe('Chapters & verses');
    expect(decodeLatex(String.raw`\emph{Na\"{\i}ve} {\v{C}}ech \url{x}`)).toBe('Naïve Čech url x'.replace('url x', 'x'));
  });

  it('parses names the way BibTeX does', () => {
    expect(parseBibName('Kaiming He')).toEqual({ family: 'He', given: 'Kaiming' });
    expect(parseBibName('Donald E. Knuth')).toEqual({ family: 'Knuth', given: 'Donald E.' });
    expect(parseBibName('Ludwig van Beethoven')).toEqual({ family: 'Beethoven', given: 'Ludwig', particle: 'van' });
    expect(parseBibName('van den Berg, Jr, Jan')).toEqual({ family: 'Berg', given: 'Jan', particle: 'van den', suffix: 'Jr' });
    expect(parseBibName('{World Health Organization}')).toEqual({ literal: 'World Health Organization' });
    expect(parseBibName('de la Fontaine, Jean')).toEqual({ family: 'Fontaine', given: 'Jean', particle: 'de la' });
    expect(byId.he2016deep!.author!.map((a) => a.family)).toEqual(['He', 'Zhang', 'Ren', 'Sun']);
  });

  it('round-trips through BibTeX export', () => {
    const again = parseBibtex(toBibtex(references)).references;
    expect(again.map((r) => r.id)).toEqual(references.map((r) => r.id));
    for (const r of again) {
      const o = byId[r.id]!;
      expect(r.title).toBe(o.title);
      expect(r.author).toEqual(o.author);
      expect(r.issued?.year).toBe(o.issued?.year);
      expect(r.page).toBe(o.page);
      expect(r.doi).toBe(o.doi);
    }
    expect(toBibtex([byId.vdberg2010!])).toContain('title = {{Chapters \\& verses}}');
    expect(toBibtex([byId.who2020!])).toContain('author = {{World Health Organization}}');
  });
});

describe('CSL-JSON import', () => {
  const csl = JSON.stringify([
    { id: 'http://zotero.org/users/1/items/ABCD', 'citation-key': 'lecun2015', type: 'article-journal', title: 'Deep learning', author: [{ family: 'LeCun', given: 'Yann' }, { family: 'Bengio', given: 'Yoshua' }, { family: 'Hinton', given: 'Geoffrey' }], 'container-title': 'Nature', 'container-title-short': 'Nature', volume: '521', issue: '7553', page: '436-444', issued: { 'date-parts': [[2015, 5, 28]] }, DOI: '10.1038/nature14539' },
    { id: 'smith-web', type: 'post-weblog', title: 'A post', author: [{ literal: 'Smith Lab' }], issued: { raw: '2021-02' }, URL: 'https://example.org/p' },
    { id: 7, type: 'book', title: 'Numbers', editor: [{ family: 'Doe', given: 'J.' }], issued: { 'date-parts': [['2003']] } },
  ]);
  it('reads Zotero CSL-JSON with citation keys, names, dates and odd types', () => {
    const { references, errors } = parseCslJson(csl);
    expect(errors).toEqual([]);
    expect(references.map((r) => r.id)).toEqual(['lecun2015', 'smith-web', '7']);
    expect(references[0]!.issued).toEqual({ year: 2015, month: 5, day: 28 });
    expect(references[0]!.page).toBe('436–444');
    expect(references[1]!.type).toBe('webpage');
    expect(references[1]!.issued).toEqual({ year: 2021, month: 2 });
    expect(references[2]!.issued).toEqual({ year: 2003 });
    expect(parseCslJson('{"items":[{"id":"x","type":"book"}]}').references).toHaveLength(1);
    expect(parseCslJson('nope').errors[0]!.message).toMatch(/JSON/);
    expect(detectReferenceFormat(csl)).toBe('csl-json');
    expect(detectReferenceFormat(ZOTERO_BIB)).toBe('bibtex');
  });
  it('keeps everything in the note front matter and reads it back', () => {
    const r = parseCslJson(csl).references[0]!;
    const props = referenceProperties(r);
    expect(props).toMatchObject({ citekey: 'lecun2015', year: 2015, authors: ['Yann LeCun', 'Yoshua Bengio', 'Geoffrey Hinton'], doi: '10.1038/nature14539' });
    expect(referenceFromProperties(JSON.parse(JSON.stringify(props)))).toEqual(r);
    expect(referenceToCsl(r)).toMatchObject({ DOI: '10.1038/nature14539', 'container-title': 'Nature' });
  });
});

const LECUN: Reference = { id: 'lecun2015', type: 'article-journal', title: 'Deep learning', author: [{ family: 'LeCun', given: 'Yann' }, { family: 'Bengio', given: 'Yoshua' }, { family: 'Hinton', given: 'Geoffrey' }], containerTitle: 'Nature', volume: '521', issue: '7553', page: '436–444', issued: { year: 2015, month: 5, day: 28 }, doi: '10.1038/nature14539' };

describe('APA 7', () => {
  it('formats a journal article with DOI', () => {
    const f = formatApa(LECUN);
    expect(f.text).toBe('LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444. https://doi.org/10.1038/nature14539');
    expect(f.markdown).toBe('LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. *Nature, 521*(7553), 436–444. https://doi.org/10.1038/nature14539');
    expect(f.html).toContain('<i>Nature, 521</i>(7553)');
  });
  it('formats books, chapters, theses, reports and web pages', () => {
    const { references } = parseBibtex(ZOTERO_BIB);
    const by = Object.fromEntries(references.map((r) => [r.id, formatApa(r).text]));
    expect(by.knuth1984).toBe('Knuth, D. E. (1984). The TeXbook (2nd ed.). Addison-Wesley.');
    expect(by.vdberg2010).toBe('van den Berg, J., Jr. (2010). Chapters & verses. In A. Smith & B. Lee (Eds.), Handbook of Things (pp. 1–20). Springer.');
    expect(by.oezt2019).toBe('Öztürk, A. (2019). Café culture and the Bayesian brain [Doctoral dissertation, Universität Wien].');
    expect(by.who2020).toBe('World Health Organization. (2020). Global report on infection prevention (Report No. WHO/2020.1).');
    expect(by.jmlrpage).toBe('About Journal of Machine Learning Research. (2024). https://jmlr.org/about');
    expect(by.he2016deep).toMatch(/^He, K., Zhang, X., Ren, S., & Sun, J\. \(2016\)\. Deep Residual Learning for Image Recognition\. In Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition \(pp\. 770–778\)\. https:\/\/doi\.org\/10\.1109\/cvpr\.2016\.90$/);
  });
  it('handles two authors, 21+ authors, no date and initials', () => {
    expect(formatApa({ id: 'a', type: 'book', title: 'T', author: [{ family: 'A', given: 'Bo' }, { family: 'C', given: 'Di' }] }).text).toBe('A, B., & C, D. (n.d.). T.');
    const many = Array.from({ length: 23 }, (_, i) => ({ family: `F${i + 1}`, given: 'G' }));
    expect(formatApa({ id: 'm', type: 'book', title: 'T', author: many, issued: { year: 2020 } }).text).toContain('F18, G., F19, G., … F23, G. (2020)');
    expect(initials('Jean-Paul Marie')).toBe('J.-P. M.');
    expect(initials('J. R. R.')).toBe('J. R. R.');
  });
  it('sorts by author and disambiguates the same author and year with a, b', () => {
    const a: Reference = { id: 'x1', type: 'book', title: 'Zebra', author: [{ family: 'Smith', given: 'J' }], issued: { year: 2020 } };
    const b: Reference = { id: 'x2', type: 'book', title: 'Apple', author: [{ family: 'Smith', given: 'J' }], issued: { year: 2020 } };
    const c: Reference = { id: 'x3', type: 'book', title: 'Mid', author: [{ family: 'Adams', given: 'K' }], issued: { year: 1999 } };
    const out = formatBibliography([a, b, c], 'apa').map((f) => f.text);
    expect(out[0]).toMatch(/^Adams/);
    expect(out[1]).toContain('(2020a)');
    expect(out[2]).toContain('(2020b)');
    expect(apaInText(LECUN, 'p. 437')).toBe('(LeCun et al., 2015, p. 437)');
  });
});

describe('IEEE', () => {
  it('formats a journal article', () => {
    expect(formatIeee(LECUN, 1).text).toBe('[1] Y. LeCun, Y. Bengio, and G. Hinton, “Deep learning,” Nature, vol. 521, no. 7553, pp. 436–444, May 28, 2015, doi: 10.1038/nature14539.');
  });
  it('formats conference papers, books, theses, reports and pages', () => {
    const { references } = parseBibtex(ZOTERO_BIB);
    const by = Object.fromEntries(references.map((r, i) => [r.id, formatIeee(r, i + 1).text]));
    expect(by.he2016deep).toBe('[2] K. He, X. Zhang, S. Ren, and J. Sun, “Deep Residual Learning for Image Recognition,” in Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition, Las Vegas, NV, 2016, pp. 770–778, doi: 10.1109/cvpr.2016.90.');
    expect(by.knuth1984).toBe('[3] D. E. Knuth, The TeXbook, 2nd ed. Reading, MA: Addison-Wesley, 1984.');
    expect(by.oezt2019).toBe('[4] A. Öztürk, “Café culture and the Bayesian brain,” Ph.D. dissertation, Universität Wien, 2019.');
    expect(by.who2020).toBe('[6] World Health Organization, “Global report on infection prevention,” World Health Organization, Rep. WHO/2020.1, 2020.');
    expect(by.jmlrpage).toBe('[7] “About Journal of Machine Learning Research,” Accessed: Mar. 5, 2024. [Online]. Available: https://jmlr.org/about');
    expect(by.vaswani2017).toMatch(/^\[1\] A\. Vaswani et al\., “Attention Is All You Need,”/);
  });
  it('numbers in citation order', () => {
    const refs = [LECUN, { ...LECUN, id: 'b', title: 'B' }];
    expect(formatBibliography(refs, 'ieee').map((f) => f.text.slice(0, 3))).toEqual(['[1]', '[2]']);
  });
});

describe('citations in typed text', () => {
  it('finds Pandoc citations, locators and suppressed authors, not emails or wiki links', () => {
    const t = 'As shown [@lecun2015, p. 437; -@he2016deep] and [see @knuth1984]. Mail [me@example.com] and [[Note]] and [x](y).';
    const c = parseCitations(t);
    expect(c.map((x) => x.items)).toEqual([
      [{ key: 'lecun2015', locator: 'p. 437' }, { key: 'he2016deep', suppressAuthor: true }],
      [{ key: 'knuth1984' }],
    ]);
    expect(t.slice(c[0]!.start, c[0]!.end)).toBe('[@lecun2015, p. 437; -@he2016deep]');
    expect(citedKeys([t, 'again [@knuth1984] and [@new:key-2]'])).toEqual(['lecun2015', 'he2016deep', 'knuth1984', 'new:key-2']);
  });
  it('triggers autocomplete inside a citation bracket only', () => {
    expect(citeTrigger('see [@le')).toEqual({ at: 5, query: 'le' });
    expect(citeTrigger('see [@lecun2015; @h')).toEqual({ at: 17, query: 'h' });
    expect(citeTrigger('see [@')).toEqual({ at: 5, query: '' });
    expect(citeTrigger('mail me@ex')).toBeNull();
    expect(citeTrigger('[@a] then @b')).toBeNull();
    expect(citeTrigger('[[@x')).toBeNull();
  });
  it('suggests by key, author, title word and year', () => {
    const refs = parseBibtex(ZOTERO_BIB).references;
    expect(suggestReferences('he', refs)[0]!.id).toBe('he2016deep');
    expect(suggestReferences('knu', refs)[0]!.id).toBe('knuth1984');
    expect(suggestReferences('residual', refs)[0]!.id).toBe('he2016deep');
    expect(suggestReferences('öz', refs)[0]!.id).toBe('oezt2019');
    expect(uniqueKey('a', new Set(['a', 'aa']))).toBe('ab');
  });
});

describe('PDF matching', () => {
  const refs = parseBibtex(ZOTERO_BIB).references.concat([LECUN]);
  it('matches by DOI, citation key and Zotero-style names; leaves the rest', () => {
    const m = matchPdfs([
      { name: '10.1038_nature14539.pdf' },
      { name: 'he2016deep - Deep Residual Learning.pdf' },
      { name: 'Knuth - 1984 - The TeXbook.pdf' },
      { name: 'scan-0001.pdf', doiInText: 'https://doi.org/10.48550/arXiv.1706.03762' },
      { name: 'holiday photos.pdf' },
    ], refs);
    const by = Object.fromEntries(m.map((x) => [x.file, [x.refId, x.reason]]));
    expect(by['10.1038_nature14539.pdf']).toEqual(['lecun2015', 'doi']);
    expect(by['he2016deep - Deep Residual Learning.pdf']).toEqual(['he2016deep', 'key']);
    expect(by['Knuth - 1984 - The TeXbook.pdf']).toEqual(['knuth1984', 'title']);
    expect(by['scan-0001.pdf']).toEqual(['vaswani2017', 'doi']);
    expect(by['holiday photos.pdf']).toBeUndefined();
    expect(findDoi('Nature 521, 436 (2015). doi:10.1038/nature14539.')).toBe('10.1038/nature14539');
  });
});
