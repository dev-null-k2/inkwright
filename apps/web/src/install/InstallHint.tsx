import { useState } from 'react';
import { Share, X } from 'lucide-react';
import { BUILD_TARGET, isIOS, isIOSHomeScreenApp, isNative, safeStorage } from '../platform/env.ts';
import '../updates/updates.css';

const KEY = 'inkwright.install-hint.dismissed';

/** Safari on iPhone or iPad, not yet opened from the Home Screen. */
export function wantsIosInstallHint(): boolean {
  if (BUILD_TARGET !== 'web' || isNative || !isIOS || typeof window === 'undefined') return false;
  return !isIOSHomeScreenApp();
}

/**
 * Library hint in Safari on iPhone and iPad: add Inkwright to the Home Screen. iOS has no install
 * prompt, and a Home Screen app is what keeps notes safe: Safari clears a website's storage after
 * seven days without a visit, but not a Home Screen app's. Shown until dismissed.
 */
export function IosInstallHint() {
  const [hidden, setHidden] = useState(() => !wantsIosInstallHint() || safeStorage.get(KEY) === '1');
  if (hidden) return null;
  return (
    <section className="update-banner" aria-label="Add to Home Screen">
      <Share size={18} aria-hidden className="update-banner-icon" />
      <div className="update-banner-text">
        <p className="update-banner-title">Add Inkwright to your Home Screen</p>
        <p className="update-banner-detail">
          Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>. It opens full screen, works offline, updates itself, and Safari won’t clear your notes after a week away.
        </p>
      </div>
      <div className="update-banner-actions">
        <button type="button" className="btn btn-ghost" aria-label="Dismiss" onClick={() => { safeStorage.set(KEY, '1'); setHidden(true); }}>
          <X size={16} aria-hidden /> Not now
        </button>
      </div>
    </section>
  );
}
