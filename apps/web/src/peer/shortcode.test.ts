import { beforeEach, describe, expect, it } from 'vitest';
import { joinLink, parseJoin, rendezvousTransport, shortCodesAvailable } from './shortcode.ts';
import { setNetwork } from './identity.ts';

describe('join links', () => {
  beforeEach(() => setNetwork({ relayUrl: '', publicRelay: 'https://ntfy.sh' }));

  it('carry the code in the fragment, never the query, so the web server never sees it', async () => {
    const link = await joinLink('K7PM2Q9X');
    const u = new URL(link);
    expect(u.search).toBe('');
    expect(u.hash).toBe('#join=K7PM-2Q9X');
    expect(parseJoin(link)).toEqual({ code: 'K7PM2Q9X', relay: null });
  });

  it('name the host’s relay only when it isn’t the default', async () => {
    setNetwork({ publicRelay: 'https://ntfy.example.org' });
    const link = await joinLink('K7PM2Q9X');
    expect(parseJoin(link)).toEqual({ code: 'K7PM2Q9X', relay: { kind: 'ntfy', url: 'https://ntfy.example.org' } });
  });

  it('read bare codes, fragments, inkwright:// links and scanned text forgivingly', () => {
    expect(parseJoin('k7pm 2q9x')?.code).toBe('K7PM2Q9X');
    expect(parseJoin('join=K7PM-2Q9X')?.code).toBe('K7PM2Q9X');
    expect(parseJoin('inkwright://join?join=K7PM-2Q9X')?.code).toBe('K7PM2Q9X');
    expect(parseJoin('https://example.com/app/#join=K7PM-2Q9X&ntfy=https%3A%2F%2Fntfy.example.org')?.relay).toEqual({ kind: 'ntfy', url: 'https://ntfy.example.org' });
    expect(parseJoin('https://example.com/app/')).toBeNull();
    expect(parseJoin('ink1:abcdef')).toBeNull();
  });

  it('refuse relays a link could use to downgrade to plain http on the network', () => {
    expect(parseJoin('#join=K7PM-2Q9X&ntfy=http%3A%2F%2Fevil.example')?.relay).toBeNull();
    expect(parseJoin('#join=K7PM-2Q9X&relay=javascript%3Aalert(1)')?.relay).toBeNull();
    expect(parseJoin('#join=K7PM-2Q9X&ntfy=http%3A%2F%2F127.0.0.1%3A8080')?.relay).toEqual({ kind: 'ntfy', url: 'http://127.0.0.1:8080' });
  });

  it('pick the self-hosted mailbox over the public relay, and none when both are empty', async () => {
    expect((await rendezvousTransport())?.label).toBe('ntfy.sh');
    setNetwork({ relayUrl: 'https://notes.example.com' });
    expect((await rendezvousTransport())?.label).toBe('notes.example.com');
    setNetwork({ relayUrl: '', publicRelay: '' });
    expect(await rendezvousTransport()).toBeNull();
    expect(shortCodesAvailable()).toBe(false);
  });
});
