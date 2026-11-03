# R8 rules for Inkwright's release builds (minifyEnabled + shrinkResources in app/build.gradle).
#
# Most libraries ship their own consumer rules, which R8 applies automatically:
#   - Capacitor: classes annotated @CapacitorPlugin and their @PluginMethod methods (found by
#     reflection when the bridge registers and calls plugins), which covers InkwrightNativePlugin
#     and the Capacitor plugins; @capgo/capacitor-social-login keeps itself and the sign-in APIs.
#   - ML Kit digital ink, the ML Kit GenAI task APIs, Play services, AndroidX graphics-core and
#     motion prediction.
# This file covers what does not: code reached by name from native code or reflection.
# scripts/android/check-r8.mjs checks a release build's mapping against all of it; see
# docs/PERFORMANCE.md ("R8 and resource shrinking").

# Readable stack traces in crash reports (deobfuscate with build/outputs/mapping/release/mapping.txt).
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# LiteRT-LM ships no consumer rules, and its JNI library looks up Java classes, fields and
# callbacks by name (engine config, conversation, streaming callbacks). Its Java layer is small
# (~200 kB), so it is kept whole rather than guessed at.
-keep class com.google.ai.edge.litertlm.** { *; }
-dontwarn com.google.ai.edge.litertlm.**

# ML Kit GenAI's shared module (genai-common) also has no consumer rules; the task APIs that use it
# do. Kept whole: Gemini Nano runs in AICore and this is the IPC boundary to it, which only a real
# device with AICore exercises (docs/ANDROID.md).
-keep class com.google.mlkit.genai.** { *; }
-dontwarn com.google.mlkit.genai.**

# The WebView bridge: methods called from JavaScript must keep their names. (Capacitor's own
# rules keep its bridge classes; this covers any @JavascriptInterface added later.)
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
