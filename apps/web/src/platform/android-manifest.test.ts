// @vitest-environment node
/**
 * The Android manifest's security-relevant settings (security review SR-03 and the Android
 * section of docs/SECURITY_REVIEW.md), checked on every test run: a release can't quietly start
 * backing up API keys to the cloud or export a component.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const main = fileURLToPath(new URL('../../android/app/src/main/', import.meta.url));
const read = (p: string) => readFileSync(main + p, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const manifest = read('AndroidManifest.xml');
const application = /<application\b[^>]*>/.exec(manifest)![0];

describe('Android manifest', () => {
  it('backs nothing up to the cloud (the WebView storage holds the API-key encryption key)', () => {
    expect(application).toMatch(/android:allowBackup="false"/);
    expect(application).toMatch(/android:dataExtractionRules="@xml\/data_extraction_rules"/);
    expect(application).toMatch(/android:fullBackupContent="@xml\/backup_rules"/);
    const rules = read('res/xml/data_extraction_rules.xml');
    const cloud = /<cloud-backup>([\s\S]*?)<\/cloud-backup>/.exec(rules)?.[1] ?? '';
    for (const domain of ['root', 'file', 'database', 'sharedpref', 'external']) {
      expect(cloud).toContain(`<exclude domain="${domain}" path="." />`);
      expect(read('res/xml/backup_rules.xml')).toContain(`<exclude domain="${domain}" path="." />`);
    }
    expect(cloud).not.toMatch(/<include\b/);
  });

  it('exports only the launcher activity; the file provider is private', () => {
    const exported = [...manifest.matchAll(/<(activity|service|receiver|provider)\b[^>]*android:exported="true"[^>]*>/g)].map((m) => /android:name="([^"]+)"/.exec(m[0])?.[1]);
    expect(exported).toEqual(['.MainActivity']);
    expect(/<provider\b[^>]*>/.exec(manifest)![0]).toMatch(/android:exported="false"/);
    expect(manifest).not.toMatch(/usesCleartextTraffic="true"/);
    expect(manifest).not.toMatch(/android:debuggable="true"/);
  });
});
