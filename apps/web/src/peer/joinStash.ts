/**
 * Takes a join link's code out of the address bar before the app routes. A link someone sent
 * (`…/app/#join=K7PM-2Q9X`) carries the code in the URL fragment, which browsers never send to
 * the server hosting the app; the router would replace that fragment with a route, so this module
 * — imported first by main.tsx — keeps it for the join sheet (PeerGlobal) and removes it from the
 * address bar and history. Nothing connects until the person taps Join.
 */
let pending: string | null = null;

const isJoin = (hash: string) => /^#(?:.*&)?join=/.test(hash);

if (typeof location !== 'undefined' && isJoin(location.hash)) {
  pending = location.hash.slice(1);
  history.replaceState(history.state, '', location.pathname + location.search);
}

/**
 * Join links opened in this tab while nobody is listening yet. The join sheet (PeerGlobal) mounts
 * in the background phase after the library appears (src/boot), so a link opened in that first
 * moment would otherwise be missed: this module listens from startup and keeps it.
 */
let listener: ((fragment: string) => void) | null = null;
let onQueued: (() => void) | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    if (!isJoin(location.hash)) return;
    const frag = location.hash.slice(1);
    history.replaceState(history.state, '', location.pathname + location.search);
    if (listener) listener(frag);
    else {
      pending = frag;
      onQueued?.();
    }
  });
}

/** The join fragment the app was opened with (or one opened before the sheet was ready), once. */
export function takePendingJoin(): string | null {
  const p = pending;
  pending = null;
  return p;
}

/** Calls `on` with join fragments that arrive while the app is open (a link opened in this tab). */
export function watchJoinLinks(on: (fragment: string) => void): () => void {
  listener = on;
  return () => { if (listener === on) listener = null; };
}

/** Called when a join link arrives before anyone watches, so the app can mount the sheet sooner. */
export function whenJoinLinkQueued(fn: () => void): void {
  onQueued = fn;
}
