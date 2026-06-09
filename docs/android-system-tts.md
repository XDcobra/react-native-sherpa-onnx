# Android System TTS Engine

Let users pick your app as the device-wide TTS engine under **Settings → Text-to-speech output**. Maps, readers, and accessibility tools can then use your on-device sherpa-onnx voices.

| Doc | Use when |
| --- | --- |
| [tts-offline.md](tts-offline.md) | TTS inside your React Native app (`createTTS`) |
| **This page** | TTS as an Android system engine (Kotlin only) |
| [model-delivery-pad-odr.md](model-delivery-pad-odr.md) | Ship models to device storage |
| [model-detect.md](model-detect.md) | Detect model type and languages |

> [!NOTE]
> **Android only. Opt-in.** Installing the SDK does not register an engine. No JavaScript API — you subclass Kotlin base classes and edit `AndroidManifest.xml`.

**Package:** `com.sherpaonnx.tts.system`

---

## Table of contents

- [Checklist](#checklist)
- [SDK vs your app](#sdk-vs-your-app)
- [Languages](#languages)
- [What goes in `SystemTtsConfig`](#what-goes-in-systemttsconfig)
- [Quick start](#quick-start)
- [After model extract](#after-model-extract)
- [API reference](#api-reference)
- [Troubleshooting](#troubleshooting)
- [See also](#see-also)

---

## Checklist

1. **Model on disk (RN)** — `DocumentDirectoryPath/models/{modelId}` via PAD + `extractArchive`.
2. **App data (Kotlin)** — voices, `localeTagByHint`, preview phrases.
3. **Config resolver (Kotlin)** — `TtsModelDetect` → `SystemTtsConfig` or `null`.
4. **Three subclasses** — service + `CHECK_TTS_DATA` + `GET_SAMPLE_TEXT`.
5. **Manifest** — service, activities, `tts_engine.xml`.
6. **Optional** — settings activity + default voice in `SharedPreferences`.

---

## SDK vs your app

| SDK (`com.sherpaonnx.tts.system`) | Your app |
| --- | --- |
| `TextToSpeechService` callbacks, PCM streaming | Which model id and folder |
| `TtsModelDetect` (blocking detect) | `localeTagByHint` map (`de` → `de-DE`) |
| ISO-3 ↔ hint conversion (`deu` → `de`) | Voice list + speaker ids |
| `CHECK_TTS_DATA` / `GET_SAMPLE_TEXT` base activities | Preview phrases, synthesis extras |
| | Manifest, branding, settings UI |

---

## Languages

Three formats. **You only supply the middle row.**

| | Format | Example |
| --- | --- | --- |
| **Model** (from `TtsModelDetect`) | ISO 639-1 hint | `de` |
| **Your app** (`localeTagByHint`) | BCP-47 default region | `de-DE` |
| **Android system** (SDK converts for you) | ISO 639-2/T + alpha-3 country | `deu`, `DEU` → `deu-DEU` |

```kotlin
// Your only locale job: pick a default region per hint
val localeTagByHint = mapOf(
  "de" to "de-DE",
  "en" to "en-US",
  "vi" to "vi-VN",
)
```

Detect gives `languageHints`. You add `localeTagByHint`. The SDK builds everything Android needs (`deu-DEU` in settings, `de-DE` as voice name, `de` for synthesis).

See [model-languages.md](model-languages.md) for catalog alignment.

---

## What goes in `SystemTtsConfig`

| Field | Who fills it | What it is |
| --- | --- | --- |
| `modelDir`, `modelType`, `paths` | From `TtsModelDetect` | On-disk model |
| `languageHints` | From detect | `["de", "en", …]` |
| `localeTagByHint` | **You** | `de` → `de-DE` |
| `voiceDescriptors` | **You** | `voiceName`, `sid`, label |
| `defaultVoiceName` | **You** | Fallback speaker |
| `sampleTextByHint` | **You** | Preview phrase per hint |
| `synthesisExtrasForLangHint` | **You** | e.g. Supertonic: `{ lang: hint }` |
| `modelMissingMessage` | **You** | User-facing “model not ready” text |
| `preferencesName`, `defaultVoicePreferenceKey` | **You** | Where default voice is stored |

---

## Quick start

End-to-end flow: **RN delivers the model → Kotlin builds config → three subclasses + manifest register the engine**.

Examples use package `com.example.myapp.systemtts` and Supertonic 3 model `sherpa-onnx-supertonic-3-tts-int8-2026-05-11`. Adapt `MODEL_ID`, `PACK`, and voice names to your app.

### 1) Model on disk (React Native)

The system engine has no React Native context. It only reads files from the app sandbox. On Android that is the same path as `DocumentDirectoryPath/models/{modelId}`.

Run this once (e.g. on first launch or after login) before users open system TTS settings:

```typescript
import { ensureAssetPackReady, getAssetPackPath } from 'react-native-sherpa-onnx/utils';
import { listBundledArchives, extractArchive } from 'react-native-sherpa-onnx/extraction';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';

const PACK = 'core_tts'; // Gradle assetPack.packName — see model-delivery-pad-odr.md
const MODEL_ID = 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11';

// 1) Download on-demand PAD pack (skip for install-time PAD)
await ensureAssetPackReady(PACK);

// 2) Resolve pack path on disk
const packPath = await getAssetPackPath(PACK);
if (!packPath) throw new Error(`${PACK} not ready`);

// 3) Extract .tar.zst archives → DocumentDirectoryPath/models/{modelId}/
for (const archive of await listBundledArchives(packPath)) {
  await extractArchive(archive, `${DocumentDirectoryPath}/models`);
}

// Kotlin resolver below expects: context.filesDir/models/{MODEL_ID}/
// On Android, DocumentDirectoryPath === filesDir (not filesDir/Documents)
```

After extract, invalidate the Kotlin config cache so the engine picks up the new files — see [After model extract](#after-model-extract).

### 2) Voices and locale map (Kotlin)

Define these **before** the resolver. They are app-owned product data the SDK does not ship.

```kotlin
// Speaker catalog — sid must match the model's preset speakers (0..numSpeakers-1)
object MyAppVoices {
  const val DEFAULT = "myapp_supertonic_f1"

  val descriptors = listOf(
    SystemTtsVoiceDescriptor("myapp_supertonic_f1", sid = 0, displayLabel = "F1"),
    SystemTtsVoiceDescriptor("myapp_supertonic_f2", sid = 1, displayLabel = "F2"),
    SystemTtsVoiceDescriptor("myapp_supertonic_m1", sid = 5, displayLabel = "M1"),
    // … one entry per speaker your model exposes
  )
}

// Hint → default region — one entry per language your model supports (see §Languages)
object MyAppLocaleTags {
  val localeTagByHint = mapOf(
    "de" to "de-DE",
    "en" to "en-US",
    "fr" to "fr-FR",
    "vi" to "vi-VN",
  )
}

// Preview phrases for system TTS settings play button (GET_SAMPLE_TEXT)
object MyAppSampleText {
  val phraseByHint = mapOf(
    "de" to "Dies ist ein Beispiel für Sprachsynthese.",
    "en" to "This is an example of speech synthesis.",
  )
}
```

- `voiceName` — stored in `SharedPreferences` as the user's default speaker
- `sid` — passed to sherpa-onnx `generate()`
- `displayLabel` — shown only in your settings UI

### 3) Config resolver (Kotlin)

Single entry point used by the service and both activities. Returns `null` when the model is not ready — the engine then stays invisible or reports "not installed".

```kotlin
object MyAppSystemTtsModelPaths {
  const val MODEL_ID = "sherpa-onnx-supertonic-3-tts-int8-2026-05-11"
  const val PREFERENCES_NAME = "myapp_system_tts"
  const val DEFAULT_VOICE_KEY = "default_voice_name"

  fun resolve(context: Context): SystemTtsConfig? {
    // Step A — model folder must exist (written by RN extract above)
    val dir = File(context.filesDir, "models/$MODEL_ID")
    if (!dir.isDirectory) return null

    // Step B — detect without loading the engine (cheap; safe on service bind)
    val detect = TtsModelDetect.detect(
      modelDir = dir.absolutePath,
      assetName = null,
      modelType = "supertonic",
    )
    if (!detect.success || detect.modelType != "supertonic") return null

    // Step C — languages from detect + your locale map
    val localeTagByHint = MyAppLocaleTags.localeTagByHint
    val hints = SystemTtsLocaleMapping.normalizeHints(
      detect.languageRows.map { it.iso6391Hint },
      localeTagByHint,
    )
    if (hints.isEmpty()) return null

    // Step D — preview phrases only for hints you support
    val sampleTextByHint = hints.mapNotNull { hint ->
      MyAppSampleText.phraseByHint[hint]?.let { hint to it }
    }.toMap()

    // Step E — hand config to SDK transport layer
    return SystemTtsConfig(
      modelDir = dir.absolutePath,
      modelType = "supertonic",
      paths = detect.paths,                    // from detect — engine init paths
      languageHints = hints,                     // ["de", "en", …]
      localeTagByHint = localeTagByHint,         // your de → de-DE map
      voiceDescriptors = MyAppVoices.descriptors,
      defaultVoiceName = MyAppVoices.DEFAULT,
      preferencesName = PREFERENCES_NAME,
      defaultVoicePreferenceKey = DEFAULT_VOICE_KEY,
      modelMissingMessage = "Open the app once to download speech models.",
      sampleTextByHint = sampleTextByHint,
      synthesisExtrasForLangHint = { hint ->
        mapOf("lang" to hint)                   // Supertonic needs lang hint; VITS/Piper: omit
      },
    )
  }
}
```

If detect is slow, cache the returned `SystemTtsConfig` and clear it in `onConfigReloadRequested()` — see [After model extract](#after-model-extract).

### 4) Subclasses (Kotlin)

Three thin classes. All delegate to the same resolver — keep config logic in one place.

```kotlin
// Binds when Android (or another app) needs speech output
class MyAppTtsService : SherpaOnnxTextToSpeechService() {
  override fun loadConfig() = MyAppSystemTtsModelPaths.resolve(applicationContext)

  override fun onConfigReloadRequested() {
    // Drop cache after PAD extract — if you cache resolve() results
  }
}

// System settings → language dropdown (without this, the list stays empty)
class MyAppCheckVoiceDataActivity : SherpaOnnxCheckVoiceDataActivity() {
  override fun loadConfig() = MyAppSystemTtsModelPaths.resolve(applicationContext)
}

// System settings → preview play button (without this, preview is silent)
class MyAppGetSampleTextActivity : SherpaOnnxGetSampleTextActivity() {
  override fun loadConfig() = MyAppSystemTtsModelPaths.resolve(applicationContext)
}
```

### 5) Manifest and `tts_engine.xml`

Register inside `<application>`. The service makes the engine selectable; the two no-display activities are required for settings UI.

```xml
<!-- Engine entry — shown in Settings → Text-to-speech output -->
<service
  android:name=".systemtts.MyAppTtsService"
  android:label="@string/system_tts_engine_name"
  android:exported="true"
  android:permission="android.permission.BIND_TEXT_TO_SPEECH_SERVICE">
  <intent-filter>
    <action android:name="android.intent.action.TTS_SERVICE" />
    <category android:name="android.intent.category.DEFAULT" />
  </intent-filter>
  <!-- Links to tts_engine.xml for settings activity -->
  <meta-data android:name="android.speech.tts" android:resource="@xml/tts_engine" />
</service>

<!-- Populates language list in system TTS settings -->
<activity
  android:name=".systemtts.MyAppCheckVoiceDataActivity"
  android:exported="true"
  android:theme="@android:style/Theme.NoDisplay">
  <intent-filter>
    <action android:name="android.speech.tts.engine.CHECK_TTS_DATA" />
    <category android:name="android.intent.category.DEFAULT" />
  </intent-filter>
</activity>

<!-- Supplies preview text — required for audio preview -->
<activity
  android:name=".systemtts.MyAppGetSampleTextActivity"
  android:exported="true"
  android:theme="@android:style/Theme.NoDisplay">
  <intent-filter>
    <action android:name="android.speech.tts.engine.GET_SAMPLE_TEXT" />
    <category android:name="android.intent.category.DEFAULT" />
  </intent-filter>
</activity>

<!-- Optional — opens when user taps the gear icon next to your engine -->
<activity
  android:name=".systemtts.MyAppTtsSettingsActivity"
  android:exported="true"
  android:label="@string/system_tts_settings_title">
  <intent-filter>
    <action android:name="android.speech.tts.engine.CONFIGURE_ENGINE" />
    <category android:name="android.intent.category.DEFAULT" />
  </intent-filter>
</activity>
```

`res/xml/tts_engine.xml` — points the gear icon at your settings screen:

```xml
<?xml version="1.0" encoding="utf-8"?>
<tts-engine xmlns:android="http://schemas.android.com/apk/res/android"
    android:settingsActivity="com.example.myapp.systemtts.MyAppTtsSettingsActivity" />
```

### 6) Default voice in settings (optional)

The SDK reads `preferencesName` + `defaultVoicePreferenceKey` during synthesis to pick the speaker (`sid`). Persist the user's choice in your settings activity:

```kotlin
val prefs = getSharedPreferences(MyAppSystemTtsModelPaths.PREFERENCES_NAME, MODE_PRIVATE)

voiceSpinner.setOnItemSelectedListener { _, _, position, _ ->
  prefs.edit()
    .putString(
      MyAppSystemTtsModelPaths.DEFAULT_VOICE_KEY,
      MyAppVoices.descriptors[position].voiceName,
    )
    .apply()
}
```

Show model readiness with `MyAppSystemTtsModelPaths.resolve(this) != null` — if `null`, deep-link users to the screen where RN runs the PAD extract from step 1.

---

## After model extract

The TTS service has no React Native context. When PAD extract finishes:

1. Invalidate your cached config (`onConfigReloadRequested()`).
2. Optionally call `reloadConfig()` on the service.

Until then the engine may still think the model is missing.

---

## API reference

Kotlin package `com.sherpaonnx.tts.system`. Android only — no React Native bridge on the synthesis path.

```kotlin
import com.sherpaonnx.tts.system.SherpaOnnxTextToSpeechService
import com.sherpaonnx.tts.system.SherpaOnnxCheckVoiceDataActivity
import com.sherpaonnx.tts.system.SherpaOnnxGetSampleTextActivity
import com.sherpaonnx.tts.system.SystemTtsConfig
import com.sherpaonnx.tts.system.SystemTtsVoiceDescriptor
import com.sherpaonnx.tts.system.SystemTtsLocaleMapping
import com.sherpaonnx.tts.system.TtsModelDetect
```

### `SherpaOnnxTextToSpeechService.loadConfig()`

```kotlin
protected abstract fun loadConfig(): SystemTtsConfig?
```

```kotlin
class MyAppTtsService : SherpaOnnxTextToSpeechService() {
  override fun loadConfig(): SystemTtsConfig? =
    MyAppSystemTtsModelPaths.resolve(applicationContext)
}
```

Called synchronously when the system binds your engine. Return `null` when the on-disk model is missing or detect failed — synthesis will report not installed.

### `SherpaOnnxTextToSpeechService.onConfigReloadRequested()`

```kotlin
protected open fun onConfigReloadRequested(): Unit
```

```kotlin
override fun onConfigReloadRequested() {
  MyAppSystemTtsModelPaths.invalidateCache()
}
```

Hook to drop cached detect/config state. Invoked from `reloadConfig()` before the controller is recreated.

### `SherpaOnnxTextToSpeechService.reloadConfig()`

```kotlin
protected open fun reloadConfig(): Unit
```

```kotlin
// From a BroadcastReceiver after PAD extract, if you hold a service reference:
reloadConfig()
```

Re-runs `onConfigReloadRequested()`, releases the loaded engine, and forces the next callback to call `loadConfig()` again.

### `SherpaOnnxCheckVoiceDataActivity.loadConfig()`

```kotlin
protected abstract fun loadConfig(): SystemTtsConfig?
```

```kotlin
class MyAppCheckVoiceDataActivity : SherpaOnnxCheckVoiceDataActivity() {
  override fun loadConfig() = MyAppSystemTtsModelPaths.resolve(applicationContext)
}
```

Handles `CHECK_TTS_DATA`. Android system TTS settings use this — not `onGetVoices()` — to populate the language dropdown (`deu-DEU`, …).

### `SherpaOnnxGetSampleTextActivity.loadConfig()`

```kotlin
protected abstract fun loadConfig(): SystemTtsConfig?
```

```kotlin
class MyAppGetSampleTextActivity : SherpaOnnxGetSampleTextActivity() {
  override fun loadConfig() = MyAppSystemTtsModelPaths.resolve(applicationContext)
}
```

Handles `GET_SAMPLE_TEXT`. Without it, system settings keep `mSampleText == null` and the preview play button stays silent.

### `TtsModelDetect.detect(modelDir, assetName?, modelType)`

```kotlin
fun detect(
  modelDir: String,
  assetName: String? = null,
  modelType: String = "auto",
): TtsModelDetectResult
```

```kotlin
val detect = TtsModelDetect.detect(
  modelDir = dir.absolutePath,
  assetName = null,
  modelType = "supertonic",
)
// detect.languageRows → [{ iso6391Hint: "de", id: "de" }, …]
// detect.paths        → native file map for OfflineTts init
```

Blocking TTS detect without React Native. Same native path as `detectTtsModel()` in JavaScript. Use inside `loadConfig()` to build `SystemTtsConfig`.

### `SystemTtsConfig`

```kotlin
data class SystemTtsConfig(
  val modelDir: String,
  val modelType: String,
  val paths: Map<String, String>,
  val languageHints: List<String>,
  val localeTagByHint: Map<String, String>,
  val voiceDescriptors: List<SystemTtsVoiceDescriptor>,
  val numThreads: Int = 2,
  val defaultVoiceName: String,
  val synthesisSpeed: Float = 1.0f,
  val preferencesName: String = "sherpa_system_tts",
  val defaultVoicePreferenceKey: String = "default_voice_name",
  val modelMissingMessage: String = "Speech model is not installed.",
  val sampleTextByHint: Map<String, String> = emptyMap(),
  val synthesisExtrasForLangHint: (langHint: String) -> Map<String, String> = { emptyMap() },
)
```

```kotlin
SystemTtsConfig(
  modelDir = dir.absolutePath,
  modelType = "supertonic",
  paths = detect.paths,
  languageHints = hints,
  localeTagByHint = mapOf("de" to "de-DE", "en" to "en-US"),
  voiceDescriptors = MyAppVoices.descriptors,
  defaultVoiceName = "myapp_f1",
  sampleTextByHint = mapOf("de" to "Dies ist ein Beispiel für Sprachsynthese."),
  synthesisExtrasForLangHint = { hint -> mapOf("lang" to hint) },
)
```

Runtime configuration for the system engine. App-owned fields: `localeTagByHint`, voices, preview phrases, synthesis extras, and user-facing `modelMissingMessage`.

### `SystemTtsVoiceDescriptor`

```kotlin
data class SystemTtsVoiceDescriptor(
  val voiceName: String,
  val sid: Int,
  val displayLabel: String,
)
```

```kotlin
SystemTtsVoiceDescriptor("myapp_f1", sid = 0, displayLabel = "F1")
```

Maps a stored voice preference (`voiceName`) to a sherpa-onnx speaker id (`sid`). `displayLabel` is for your settings UI only.

### `SystemTtsLocaleMapping.normalizeHints(hints, localeTagByHint)`

```kotlin
fun normalizeHints(
  hints: List<String>,
  localeTagByHint: Map<String, String>,
): List<String>
```

```kotlin
val hints = SystemTtsLocaleMapping.normalizeHints(
  detect.languageRows.map { it.iso6391Hint },
  localeTagByHint,
)
// → ["de", "en"]  (drops "na"/"auto"; throws if hint missing from localeTagByHint)
```

Filters detect output into `languageHints`. Every surviving hint must have a `localeTagByHint` entry.

### `SystemTtsLocaleMapping.localeForHint(hint, localeTagByHint)`

```kotlin
fun localeForHint(hint: String, localeTagByHint: Map<String, String>): Locale
```

```kotlin
val locale = SystemTtsLocaleMapping.localeForHint("de", mapOf("de" to "de-DE"))
// locale.toLanguageTag() → "de-DE"
```

Resolves an ISO 639-1 hint to a `java.util.Locale` using your BCP-47 map.

### `SystemTtsLocaleMapping.ttsCheckVoiceDataStringForHint(hint, localeTagByHint)`

```kotlin
fun ttsCheckVoiceDataStringForHint(
  hint: String,
  localeTagByHint: Map<String, String>,
): String
```

```kotlin
SystemTtsLocaleMapping.ttsCheckVoiceDataStringForHint("de", localeTagByHint)
// → "deu-DEU"
```

Builds the ISO-3 voice string for `CHECK_TTS_DATA` / `EXTRA_AVAILABLE_VOICES`.

### `SystemTtsLocaleMapping.ttsLanguageTripleForHint(hint, localeTagByHint)`

```kotlin
fun ttsLanguageTripleForHint(
  hint: String,
  localeTagByHint: Map<String, String>,
): Array<String>
```

```kotlin
val triple = SystemTtsLocaleMapping.ttsLanguageTripleForHint("de", localeTagByHint)
// triple → ["deu", "DEU", ""]
```

ISO 639-2/T + ISO 3166 alpha-3 triple for `onGetLanguage`.

### `SystemTtsLocaleMapping.requestMatchesHint(lang, country, hint, …)`

```kotlin
fun requestMatchesHint(
  lang: String?,
  country: String?,
  hint: String,
  localeTagByHint: Map<String, String>,
  iso3CountryToIso2: Map<String, String>,
): Boolean
```

```kotlin
val iso3Countries = SystemTtsLocaleMapping.buildIso3CountryToIso2(localeTagByHint)
SystemTtsLocaleMapping.requestMatchesHint("deu", "DEU", "de", localeTagByHint, iso3Countries)
// → true
```

Tests whether an Android TTS request (`deu` + `DEU`) matches a model hint (`de`). Used internally by the voice registry; call directly only for custom matching logic.

### `SystemTtsLocaleMapping.normalizeTtsLanguageCode(lang)`

```kotlin
fun normalizeTtsLanguageCode(lang: String?): String?
```

```kotlin
SystemTtsLocaleMapping.normalizeTtsLanguageCode("deu")  // → "de"
SystemTtsLocaleMapping.normalizeTtsLanguageCode("de")   // → "de"
```

Converts Android's ISO 639-2/T language code to an ISO 639-1 hint. Pass-through for two-letter codes.

### `SystemTtsLocaleMapping.normalizeTtsCountryCode(country, iso3CountryToIso2)`

```kotlin
fun normalizeTtsCountryCode(
  country: String?,
  iso3CountryToIso2: Map<String, String>,
): String?
```

```kotlin
val iso3 = SystemTtsLocaleMapping.buildIso3CountryToIso2(localeTagByHint)
SystemTtsLocaleMapping.normalizeTtsCountryCode("DEU", iso3)  // → "DE"
```

Converts Android's ISO 3166 alpha-3 country to alpha-2 using a table derived from your BCP-47 tags.

### `SystemTtsLocaleMapping.buildIso3CountryToIso2(localeTagByHint)`

```kotlin
fun buildIso3CountryToIso2(localeTagByHint: Map<String, String>): Map<String, String>
```

```kotlin
val iso3CountryToIso2 = SystemTtsLocaleMapping.buildIso3CountryToIso2(
  mapOf("de" to "de-DE", "en" to "en-US"),
)
// → { "DEU" to "DE", "USA" to "US", … }
```

Derives the ISO-3 country lookup table from your `localeTagByHint` values. You rarely call this directly — the SDK registry builds it once from `SystemTtsConfig`.

### Types

```kotlin
data class PublicLanguageRow(val iso6391Hint: String, val id: String)

data class TtsModelDetectResult(
  val success: Boolean,
  val modelType: String?,
  val paths: Map<String, String>,
  val languageRows: List<PublicLanguageRow>,
  val error: String?,
)
```

`PublicLanguageRow.iso6391Hint` feeds `languageHints`. `paths` feeds `SystemTtsConfig.paths` for engine init.

> Internal (not public contract): `SystemTtsSynthesisController`, `SystemTtsVoiceRegistry`, `SystemTtsLog`.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Engine not in settings | `TTS_SERVICE` intent + `BIND_TEXT_TO_SPEECH_SERVICE`; reinstall APK |
| Empty language list | Register `CHECK_TTS_DATA`; `loadConfig()` must not return `null` |
| Preview silent | Register `GET_SAMPLE_TEXT`; add `sampleTextByHint` entry |
| Model ready in app, engine says missing | Path = `filesDir/models/{modelId}`; invalidate cache after extract |
| Debug | `adb logcat -s SherpaSystemTts` |

---

## See also

- [tts-offline.md](tts-offline.md) — in-app TTS
- [model-delivery-pad-odr.md](model-delivery-pad-odr.md) — PAD / ODR
- [extraction.md](extraction.md) — archive extract
- [model-detect.md](model-detect.md) — `detectTtsModel` (JS, same native detect)
- [model-languages.md](model-languages.md) — language catalog
