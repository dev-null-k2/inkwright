/**
 * Takes a web clip out of the address bar before the app routes. The bookmarklet opens Inkwright
 * with the clip in the URL fragment (`#clip=…`, never sent to a server); the router would replace
 * that fragment with a route, so this module — imported first by main.tsx — keeps it for the web
 * clipper module and removes it from the address bar and history. Nothing is saved here: the
 * clipper asks the person first, and drops the clip if its module is switched off.
 */
let pending: string | null = null;

if (typeof location !== 'undefined' && location.hash.startsWith('#clip=')) {
  pending = location.hash.slice(1);
  history.replaceState(history.state, '', location.pathname + location.search);
}

/** The clip fragment the app was opened with (`clip=…`), once. */
export function takePendingClip(): string | null {
  const c = pending;
  pending = null;
  return c;
}
