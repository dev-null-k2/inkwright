import { describe, expect, it } from 'vitest';
import { captureMarkdown, parseDeepLink } from './deeplinks.ts';

describe('parseDeepLink', () => {
  it('reads inkwright://, web+inkwright:// and app URLs', () => {
    expect(parseDeepLink('inkwright://new?title=Groceries&text=-%20milk&tags=home,%23errands')).toEqual({ action: 'new', title: 'Groceries', text: '- milk', tags: ['home', 'errands'] });
    expect(parseDeepLink('web+inkwright://search?q=pricing')).toEqual({ action: 'search', q: 'pricing' });
    expect(parseDeepLink('inkwright:today')).toEqual({ action: 'today' });
    expect(parseDeepLink('https://app.example.com/?action=open&note=01ABC&page=3')).toEqual({ action: 'open', note: '01ABC', page: 3 });
    expect(parseDeepLink(`https://app.example.com/?link=${encodeURIComponent('web+inkwright://open?title=Launch plan')}`)).toEqual({ action: 'open', title: 'Launch plan' });
    expect(parseDeepLink('inkwright://capture?url=https://example.com/a&title=A&text=quote')).toEqual({ action: 'capture', url: 'https://example.com/a', title: 'A', text: 'quote', tags: [] });
  });

  it('rejects anything else', () => {
    for (const bad of [
      'inkwright://delete?note=X',
      'inkwright://open',
      'inkwright://open?note=../../x',
      'inkwright://search?q=%20',
      'inkwright://capture?url=javascript:alert(1)',
      'https://app.example.com/?title=x',
      'mailto:a@b.c',
      'not a url',
    ]) expect(parseDeepLink(bad), bad).toBeNull();
  });

  it('caps lengths', () => {
    const a = parseDeepLink(`inkwright://new?title=${'t'.repeat(1000)}&text=${'x'.repeat(60_000)}`) as { title: string; text: string };
    expect(a.title.length).toBe(300);
    expect(a.text.length).toBe(50_000);
  });

  it('formats captures as a link and a quote', () => {
    expect(captureMarkdown({ action: 'capture', url: 'https://example.com/a', title: 'An [article]', text: 'one\ntwo', tags: [] })).toBe('[An article](https://example.com/a)\n\n> one\n> two');
    expect(captureMarkdown({ action: 'capture', url: 'https://example.com/a', tags: [] })).toBe('[example.com](https://example.com/a)');
  });
});
