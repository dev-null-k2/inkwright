/**
 * Plain-language reasons for an update that didn't go through, keyed by the codes the native
 * updater rejects with (UpdaterPlugin.kt) and the install statuses Android reports
 * (InstallOutcome.kt). Each says what happened and, where the person can do something, what.
 */
const REASONS: Record<string, string> = {
  // Downloading
  network: 'The download stopped. Check your connection and try again.',
  server: 'GitHub is busy right now. Try again in a few minutes.',
  forbidden: 'GitHub refused the download. Try again later.',
  gone: 'This update is no longer on GitHub. Check again for a newer one.',
  http: 'GitHub couldn’t send the update. Try again later.',
  'bad-response': 'GitHub sent an unreadable reply. Try again.',
  changed: 'The file on GitHub isn’t the one this release describes, so it wasn’t used.',
  storage: 'There isn’t enough free storage for the update. Free some space and try again.',
  // Checking the file
  invalid: 'This release’s update information isn’t valid, so it can’t be installed from the app.',
  checksum: 'The downloaded file was damaged or changed on the way, so it was deleted. Try again.',
  'not-inkwright': 'The downloaded file isn’t Inkwright, so it wasn’t installed.',
  version: 'The downloaded file isn’t the version this release describes, so it wasn’t installed.',
  'not-newer': 'The downloaded version isn’t newer than this one.',
  signature: 'The downloaded app isn’t signed with Inkwright’s key, so it wasn’t installed.',
  busy: 'An update is already downloading.',
  // Installing (Android's answers)
  aborted: 'The installation was cancelled.',
  conflict: 'Android refused the update: the installed Inkwright was signed with a different key (for example a build you made yourself). Install this release once from GitHub.',
  incompatible: 'This update doesn’t work on this phone.',
  storage_install: 'Android ran out of storage while installing. Free some space and try again.',
  blocked: 'Android blocked the installation. Check that “Install unknown apps” is allowed for Inkwright, or ask your device’s administrator.',
  timeout: 'Android took too long to install the update. Try again.',
  install: 'Android couldn’t start the installation. Try again.',
  failure: 'Android couldn’t install the update. Try again, or install it from the release page.',
  settings: 'Android’s settings couldn’t be opened. Open Settings › Apps › Inkwright › Install unknown apps yourself.',
};

/** What to tell the person about failure `code`. */
export function reasonFor(code: string, during: 'download' | 'install' = 'download'): string {
  if (code === 'storage' && during === 'install') return REASONS.storage_install;
  return REASONS[code] ?? (during === 'install' ? REASONS.failure : 'Something went wrong with the update. Try again.');
}

/** "61 MB" */
export function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}
