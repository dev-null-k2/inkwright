import { LockKeyhole } from 'lucide-react';

/**
 * Library cover of a locked note: frosted paper with a seal. Its pages are encrypted, so there is
 * no thumbnail to show (and none is ever stored).
 */
export function LockedCover() {
  return (
    <span className="locked-cover" aria-label="Locked">
      <span className="locked-lines" aria-hidden />
      <span className="locked-seal" aria-hidden><LockKeyhole size={18} /></span>
    </span>
  );
}
