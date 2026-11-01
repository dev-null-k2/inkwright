/** The Inkstone mark: a drop of ink on a slate, sealed with a cinnabar dot. */
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="15" fill="var(--ink)" />
      <path d="M32 10c7 9 12 17 12 25a12 12 0 0 1-24 0c0-8 5-16 12-25z" fill="var(--ink-inverse)" />
      <path d="M32 25v17" stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="47" cy="48" r="6" fill="var(--seal)" />
    </svg>
  );
}
