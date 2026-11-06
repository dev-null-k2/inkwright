/**
 * The CHANGELOG section for `version` (its heading names it), else "Unreleased": the same rule as
 * release.yml, so the web app's "What's new" matches the release notes.
 */
export function changelogNotes(changelog: string, version: string): string {
  const section = (match: (heading: string) => boolean) => {
    const out: string[] = [];
    let on = false;
    for (const line of changelog.split('\n')) {
      if (line.startsWith('## ')) { if (on) break; on = match(line); continue; }
      if (on) out.push(line);
    }
    return out.join('\n').trim();
  };
  const base = version.split('+')[0]!;
  return section((h) => h.includes(base)) || section((h) => h.includes('Unreleased'));
}
