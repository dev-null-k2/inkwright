// @vitest-environment node
/**
 * The release build is shrunk by R8 (android/app/build.gradle). scripts/android/check-r8.mjs reads
 * R8's mapping and fails a build in which something JavaScript or native code finds by name was
 * renamed. These tests pin down that it reads the mapping and the plugin sources correctly, and
 * that the keep rules it relies on are still in place.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM build script without type declarations
import { callableMethods, check, parseMapping } from '../../scripts/android/check-r8.mjs';

const app = fileURLToPath(new URL('../../android/app/', import.meta.url));

const MAPPING = `# compiler: R8
app.inkwright.InkwrightNativePlugin -> a.b:
# {"id":"sourceFile","fileName":"InkwrightNativePlugin.kt"}
    kotlinx.coroutines.CoroutineScope scope -> scope
    1:4:void capabilities(com.getcapacitor.PluginCall):120:123 -> capabilities
    1:4:void kotlin.Foo.inlined():1:1 -> recognize
    5:9:void recognize(com.getcapacitor.PluginCall):200 -> c
com.capacitorjs.plugins.share.SharePlugin -> com.capacitorjs.plugins.share.SharePlugin:
    void share(com.getcapacitor.PluginCall) -> share
com.google.ai.edge.litertlm.Engine -> com.google.ai.edge.litertlm.Engine:
    long nativeHandle -> nativeHandle
com.google.ai.edge.litertlm.Engine$$ExternalSyntheticLambda0 -> com.google.ai.edge.litertlm.a:
com.google.mlkit.genai.common.Feature -> x.y:
`;

describe('R8 mapping check', () => {
  it('reads renamed classes and members, ignoring inlined frames', () => {
    const map = parseMapping(MAPPING);
    expect(map.get('app.inkwright.InkwrightNativePlugin').renamed).toBe('a.b');
    expect([...map.get('app.inkwright.InkwrightNativePlugin').members.get('capabilities')]).toEqual(['capabilities']);
    expect([...map.get('app.inkwright.InkwrightNativePlugin').members.get('recognize')]).toEqual(['c']);
    expect(map.get('app.inkwright.InkwrightNativePlugin').members.has('kotlin.Foo.inlined')).toBe(false);
  });

  it('finds the methods JavaScript can call, in Kotlin and Java', () => {
    expect(callableMethods(`
      @PluginMethod
      fun capabilities(call: PluginCall) {}
      @PluginMethod(returnType = PluginMethod.RETURN_NONE)
      fun inkTipBegin(call: PluginCall) {}
      fun helper() {}
      @PermissionCallback
      private fun onMicrophonePermission(call: PluginCall) {}
    `)).toEqual(['capabilities', 'inkTipBegin', 'onMicrophonePermission']);
    expect(callableMethods('@PluginMethod\n  public void share(PluginCall call) {}')).toEqual(['share']);
  });

  it('flags a renamed method, a renamed plugin loaded by name, and renamed native-facing classes', () => {
    const { problems } = check(MAPPING, [
      { className: 'app.inkwright.InkwrightNativePlugin', loadedByName: false, methods: ['capabilities', 'recognize'] },
      { className: 'com.capacitorjs.plugins.share.SharePlugin', loadedByName: true, methods: ['share'] },
      { className: 'ee.forgr.capacitor.social.login.SocialLoginPlugin', loadedByName: true, methods: [] },
    ]);
    expect(problems).toEqual([
      'app.inkwright.InkwrightNativePlugin.recognize: renamed or removed, but JavaScript calls it by name',
      'ee.forgr.capacitor.social.login.SocialLoginPlugin: missing from the build',
      'com.google.mlkit.genai.common.Feature: renamed to x.y, but native code looks it up by name',
    ]);
  });

  it('passes when every name survived', () => {
    const ok = MAPPING.replace('-> c\n', '-> recognize\n').replace('-> x.y:', '-> com.google.mlkit.genai.common.Feature:');
    expect(check(ok, [{ className: 'app.inkwright.InkwrightNativePlugin', loadedByName: false, methods: ['capabilities', 'recognize'] }]).problems).toEqual([]);
  });
});

describe('release build configuration', () => {
  const gradle = readFileSync(app + 'build.gradle', 'utf8');
  const rules = readFileSync(app + 'proguard-rules.pro', 'utf8');

  it('shrinks code and resources in release builds', () => {
    const release = /buildTypes\s*\{\s*release\s*\{([\s\S]*?)\n {8}\}/.exec(gradle)![1]!;
    expect(release).toMatch(/minifyEnabled true/);
    expect(release).toMatch(/shrinkResources true/);
    expect(release).toMatch(/proguard-android-optimize\.txt/);
  });

  it('keeps what native code reaches by name', () => {
    expect(rules).toMatch(/-keep class com\.google\.ai\.edge\.litertlm\.\*\* \{ \*; \}/);
    expect(rules).toMatch(/-keep class com\.google\.mlkit\.genai\.\*\* \{ \*; \}/);
  });

  it('ships three ABIs and never 32-bit x86', () => {
    expect(gradle).toMatch(/def shippedAbis = \['arm64-v8a', 'armeabi-v7a', 'x86_64'\]/);
    expect(gradle).toMatch(/def droppedAbis = \['x86',/);
  });
});
