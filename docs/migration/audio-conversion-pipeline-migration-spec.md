# Spec: Audio Conversion API — Pipeline-Buffer-basiert

**Status:** Specification — alle Design-Entscheidungen resolved; bereit für Implementierung.
**Scope:** `convertAudioToFormat` und `convertAudioToWav16k` werden auf ausschließlich Pipeline-Audio-Buffer-Input umgestellt. Dateibasierte Conversion, `saveOfflineAudioBufferToWav`, `saveLiveAudioBufferToWav`, `decodeAudioFileToFloatSamples` und alle zugehörigen nativen Endpunkte werden komplett entfernt. Kein Deprecation-Pfad — breaking change.

---

## 1. Ist-Zustand (Zusammenfassung)

### 1.1 Conversion API (`react-native-sherpa-onnx/audio`)

| Funktion | Input | Output | Native |
|----------|-------|--------|--------|
| `convertAudioToFormat(inputPath, outputPath, format, sampleRate?)` | Dateipfad / `content://` | Datei (WAV/MP3/FLAC/AAC/Opus/…) | FFmpeg-Pipeline (C++) |
| `convertAudioToWav16k(inputPath, outputPath)` | Dateipfad / `content://` | WAV 16 kHz mono | FFmpeg-Pipeline (C++) |
| `decodeAudioFileToFloatSamples(inputPath, rate?)` | Dateipfad / `content://` | `{samples, sampleRate}` | FFmpeg decode |

### 1.2 Buffer-Save API (`react-native-sherpa-onnx/audiobuffer`)

| Funktion | Input | Output | Native |
|----------|-------|--------|--------|
| `saveOfflineAudioBufferToWav(buffer, outputPath)` | Buffer-ID | WAV 16-bit PCM | Legacy WAV-only path |
| `saveLiveAudioBufferToWav(buffer, outputPath)` | Buffer-ID | WAV 16-bit PCM | Legacy WAV-only path (ring/spool) |

### 1.3 Probleme

- **Zwei getrennte Codepfade** für "Buffer → Datei" vs. "Datei → Datei" Konvertierung.
- Buffer-Save kann **nur WAV**; für MP3/FLAC muss der User erst WAV schreiben, dann `convertAudioToFormat` aufrufen → doppelter I/O, temp-Datei-Management auf JS-Ebene.
- `convertAudioToFormat` akzeptiert nur Dateipfade — kein nativer Zugriff auf Pipeline-Buffer möglich, obwohl die Samples bereits im Speicher (oder Spool) liegen.
- `decodeAudioFileToFloatSamples` transferiert große Float-Arrays über die JS-Bridge; `createOfflineAudioBufferFromFile` macht dasselbe rein nativ und erstellt direkt einen Buffer.
- `saveAudioFromGeneration` (TTS-Persistenz) in Docs referenziert, aber nie implementiert — wird durch generische Conversion-API ersetzt.

---

## 2. Ziel-API (TypeScript)

### 2.1 Public Types

```ts
// src/audio/types.ts (NEU)

/**
 * Supported output formats for audio conversion.
 * WAV is always 16-bit signed PCM.
 * Non-WAV formats require FFmpeg (see disable-ffmpeg.md).
 */
export type AudioOutputFormat =
  | 'wav'
  | 'mp3'
  | 'flac'
  | 'aac'
  | 'm4a'
  | 'opus'
  | 'webm'
  | 'mkv'
  | 'ogg';

/**
 * Error codes for audio conversion operations.
 * Rejection codes on the promise returned by convertAudioToFormat / convertAudioToWav16k.
 */
export const ConversionErrorCode = {
  /** Buffer ID does not match expected pattern (off_UUID / live_UUID). */
  INVALID_ARGUMENT: 'CONVERSION_INVALID_ARGUMENT',
  /** Buffer not found in native registry. */
  BUFFER_NOT_FOUND: 'CONVERSION_BUFFER_NOT_FOUND',
  /** Live buffer is still in recording state — must be finalized first. */
  BUFFER_NOT_FINALIZED: 'CONVERSION_BUFFER_NOT_FINALIZED',
  /** Buffer contains zero samples. */
  BUFFER_EMPTY: 'CONVERSION_BUFFER_EMPTY',
  /** Unsupported format or format unavailable (e.g. MP3 when FFmpeg is disabled). */
  UNSUPPORTED_FORMAT: 'CONVERSION_UNSUPPORTED_FORMAT',
  /** Invalid outputSampleRateHz for the requested format. */
  INVALID_SAMPLE_RATE: 'CONVERSION_INVALID_SAMPLE_RATE',
  /** FFmpeg encoding/conversion error. */
  CONVERT_ERROR: 'CONVERSION_CONVERT_ERROR',
  /** Output file could not be written. */
  FILE_WRITE_ERROR: 'CONVERSION_FILE_WRITE_ERROR',
} as const;

export type ConversionErrorCodeValue =
  (typeof ConversionErrorCode)[keyof typeof ConversionErrorCode];
```

### 2.2 `convertAudioToFormat`

```ts
// src/audio/index.ts

import type { PipelineAudioBufferIdSource } from '../audiobuffer/types';
import type { AudioOutputFormat } from './types';
import { resolvePipelineAudioBufferId } from '../audiobuffer';

/**
 * Convert a pipeline audio buffer to an encoded audio file.
 *
 * Accepts any offline or finalized live buffer. Live buffers in `recording` state
 * are rejected with BUFFER_NOT_FINALIZED.
 *
 * @param input       - Offline or finalized live audio buffer (ref, handle, or raw ID string).
 * @param outputPath  - Absolute local file path for the output. Parent directory must exist.
 *                      No content:// URIs — use copyFileToContentUri from react-native-sherpa-onnx/files for SAF.
 * @param format      - Target audio format.
 * @param outputSampleRateHz - Target sample rate. Semantics depend on format:
 *   - WAV:  0 or omitted = buffer's native sample rate. Explicit value = resample to that rate.
 *   - MP3:  0 = 44100 (default). Allowed: 32000, 44100, 48000.
 *   - Opus/WEBM/MKV/OGG: 0 = 48000 (default). Allowed: 8000, 12000, 16000, 24000, 48000.
 *   - FLAC/AAC/M4A: 0 = buffer's native rate. Explicit value = resample.
 *
 * Resolves when the output file has been written successfully.
 * Rejects with a ConversionErrorCode on failure.
 */
export function convertAudioToFormat(
  input: PipelineAudioBufferIdSource,
  outputPath: string,
  format: AudioOutputFormat,
  outputSampleRateHz?: number,
): Promise<void> {
  return getNative().convertPipelineAudioBufferToFormat(
    resolvePipelineAudioBufferId(input),
    outputPath,
    format,
    outputSampleRateHz ?? 0,
  );
}
```

### 2.3 `convertAudioToWav16k`

```ts
/**
 * Convert a pipeline audio buffer to WAV 16 kHz mono 16-bit PCM.
 * Shortcut for convertAudioToFormat(input, outputPath, 'wav', 16000).
 * Useful for preparing STT input from buffers with non-16 kHz sample rates.
 *
 * Conversion uses FFmpeg for all formats, including WAV.
 */
export function convertAudioToWav16k(
  input: PipelineAudioBufferIdSource,
  outputPath: string,
): Promise<void> {
  return convertAudioToFormat(input, outputPath, 'wav', 16000);
}
```

### 2.4 Module Exports (`react-native-sherpa-onnx/audio`)

```ts
// src/audio/index.ts — vollständige Exports nach Migration

export { convertAudioToFormat } from './index';
export { convertAudioToWav16k } from './index';

export type { AudioOutputFormat } from './types';
export { ConversionErrorCode } from './types';
export type { ConversionErrorCodeValue } from './types';
```

**Entfernt (kein Re-Export, kein Deprecation-Wrapper):**
- `decodeAudioFileToFloatSamples`
- `DecodedAudioFloatSamples` type

---

## 3. TurboModule Spec

### 3.1 Neue Methode

```ts
// src/NativeSherpaOnnx.ts — Spec interface

/**
 * Convert any pipeline audio buffer (offline or finalized live) to an encoded audio file.
 *
 * Native routing:
 * - WAV → FFmpeg encode pipeline
 * - Non-WAV → FFmpeg encode pipeline
 *   (Custom AVIOContext for in-memory, file path for file-backed/spool)
 *
 * @param bufferId           - off_UUID or live_UUID
 * @param outputPath         - Absolute local file path
 * @param format             - "wav", "mp3", "flac", "aac", "m4a", "opus", "webm", "mkv", "ogg"
 * @param outputSampleRateHz - 0 = format-dependent default; see ConvertAudioToFormat docs
 */
convertPipelineAudioBufferToFormat(
  bufferId: string,
  outputPath: string,
  format: string,
  outputSampleRateHz?: number,
): Promise<void>;
```

### 3.2 Entfernte Methoden

Die folgenden Methoden werden **komplett** aus dem `Spec` interface entfernt:

```ts
// ENTFERNT — Buffer-Save (ersetzt durch convertPipelineAudioBufferToFormat mit format='wav')
saveOfflineAudioBufferToWav(bufferId: string, outputPath: string): Promise<void>;
saveLiveAudioBufferToWav(liveBufferId: string, outputPath: string): Promise<void>;

// ENTFERNT — Dateibasierte Conversion (Input ist jetzt immer ein Buffer)
convertAudioToFormat(inputPath: string, outputPath: string, format: string, outputSampleRateHz?: number): Promise<void>;
convertAudioToWav16k(inputPath: string, outputPath: string): Promise<void>;

// ENTFERNT — Float-Samples-Decode (ersetzt durch createOfflineAudioBufferFromFile)
decodeAudioFileToFloatSamples(inputPath: string, targetSampleRateHz?: number): Promise<{ samples: number[]; sampleRate: number }>;
```

---

## 4. Native Implementierung

### 4.1 Routing-Entscheidungsbaum

```
convertPipelineAudioBufferToFormat(bufferId, outputPath, format, outputSampleRateHz)
│
├── Prefix-Parsing: off_ → Offline-Lookup, live_ → Live-Lookup
│   └── Nicht gefunden → reject BUFFER_NOT_FOUND
│
├── Live-Buffer? → state muss FINISHED sein
│   └── state == RECORDING → reject BUFFER_NOT_FINALIZED
│
├── Buffer leer (numSamples == 0)? → reject BUFFER_EMPTY
│
├── Format-Validierung (siehe §7.4)
│   └── Ungültig → reject UNSUPPORTED_FORMAT oder INVALID_SAMPLE_RATE
│
└── FFmpeg ENCODE PIPELINE (für alle Formate inkl. WAV):
    ├── Offline FileBacked → nativeConvertAudioToFormat(entry.filePath, outputPath, fmt, rate)
    ├── Live + Spool       → nativeConvertAudioToFormat(entry.spoolPath, outputPath, fmt, rate)
    ├── Offline InMemory   → nativeConvertPcmToFormat(samples, sr, ch, outputPath, fmt, rate)
    └── Live ohne Spool    → snapshotRing() → nativeConvertPcmToFormat(snapshot, sr, ch, outputPath, fmt, rate)
```

### 4.2 Single conversion path: FFmpeg only (including WAV)

Alle Ausgabformate (inklusive `wav`) laufen über FFmpeg. Es gibt keinen separaten WAV-Sonderpfad.

**Vorteile:**
- ein einheitlicher Konvertierungs-Codepfad
- konsistentes Verhalten für Batch und spätere Streaming-Export-Session
- weniger Code-Duplizierung und Testmatrix

### 4.3 FFmpeg: File-Backed / Spool-Pfad

Wenn ein Buffer bereits als Datei vorliegt (Offline `FileBacked` oder Live mit finalisiertem Spool), wird die **bestehende** `nativeConvertAudioToFormat(inputPath, outputPath, format, rate)` C++-Funktion intern wiederverwendet. Der Dateipfad kommt aus dem Registry-Entry — kein JS-Involvement.

### 4.4 FFmpeg: Custom AVIOContext für In-Memory PCM

Für InMemory-Buffer (Offline `InMemory` und Live-Ring-Snapshot) werden die Float-Samples **direkt** an FFmpeg übergeben — ohne Umweg über eine Temp-Datei.

#### 4.4.1 Neue C++-Funktion

```cpp
// Shared C++ (android/src/main/cpp + ios/audio/)
// Neuer Einstiegspunkt neben dem bestehenden sherpa_audio_convert_to_format()

/**
 * Encode raw float32 PCM samples to an output file in the requested format.
 * Bypasses FFmpeg's input demuxer/decoder entirely — samples are fed directly
 * to SwrContext (resampling) → encoder → output muxer.
 *
 * @param samples            Pointer to mono float32 PCM in [-1, 1]
 * @param numSamples         Number of samples
 * @param sampleRate         Sample rate of the input PCM
 * @param channelCount       Number of channels (1 for mono)
 * @param outputPath         Output file path (local filesystem)
 * @param formatHint         Target format: "wav", "mp3", "flac", etc.
 * @param outputSampleRateHz Target sample rate (0 = format-dependent default)
 * @return                   Empty string on success, error message on failure
 */
std::string sherpa_audio_convert_pcm_to_format(
    const float *samples,
    int numSamples,
    int sampleRate,
    int channelCount,
    const char *outputPath,
    const char *formatHint,
    int outputSampleRateHz);
```

#### 4.4.2 Interne FFmpeg-Pipeline (kein Demuxer/Decoder)

Die Funktion umgeht `avformat_open_input` und den Decoder komplett:

1. **Output-Context:** `avformat_alloc_output_context2(&outCtx, NULL, formatHint, outputPath)`
2. **Encoder finden:** Format → Codec-ID → `avcodec_find_encoder(codecId)` → Encoder-Capabilities abfragen (sample formats, sample rates, channel layouts)
3. **SwrContext:** Float32 Planar @ `sampleRate` → Encoder-natives Sample-Format @ `effectiveOutputRate`
4. **Encoding-Loop:** Float-Samples in `AVFrame`-Chunks (z.B. 1152 für MP3, 1024 für AAC) aufteilen, durch `swr_convert` → `avcodec_send_frame` → `avcodec_receive_packet` → `av_interleaved_write_frame`
5. **Flush:** Encoder drain, Trailer schreiben

**Kein Temp-File, kein Disk-I/O auf der Input-Seite.** Die Float-Samples werden direkt aus dem nativen Speicher gelesen.

#### 4.4.3 JNI-Wrapper (Android)

```kotlin
// SherpaOnnxModule.kt — companion object
private external fun nativeConvertPcmToFormat(
    samples: FloatArray,
    sampleRate: Int,
    channelCount: Int,
    outputPath: String,
    format: String,
    outputSampleRateHz: Int,
): String  // Leerer String = Erfolg, sonst Fehlermeldung
```

```cpp
// sherpa-onnx-audio-convert-jni.cpp

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeConvertPcmToFormat(
    JNIEnv *env, jobject,
    jfloatArray samples, jint sampleRate, jint channelCount,
    jstring outputPath, jstring format, jint outputSampleRateHz) {
  jfloat *samplesPtr = env->GetFloatArrayElements(samples, nullptr);
  jint numSamples = env->GetArrayLength(samples);
  const char *outPath = env->GetStringUTFChars(outputPath, nullptr);
  const char *fmt = env->GetStringUTFChars(format, nullptr);

  std::string err = sherpa_audio_convert_pcm_to_format(
      samplesPtr, numSamples, sampleRate, channelCount, outPath, fmt, outputSampleRateHz);

  env->ReleaseFloatArrayElements(samples, samplesPtr, JNI_ABORT);
  env->ReleaseStringUTFChars(outputPath, outPath);
  env->ReleaseStringUTFChars(format, fmt);
  return env->NewStringUTF(err.c_str());
}
```

**Hinweis:** Für Offline `InMemory`-Buffer existiert `entry.samples` (Kotlin `FloatArray` / C++ `std::vector<float>`) bereits im nativen Heap. Der JNI-Aufruf übergibt dieses Array **ohne Kopie** (`GetFloatArrayElements` mit critical region). Für Live-Ring-Snapshot wird `snapshotRing()` einmal aufgerufen und das Ergebnis übergeben.

#### 4.4.4 iOS-Wrapper (Obj-C++)

```objc
// SherpaOnnx+PipelineAudio.mm

// Direkt C++ aufrufen — kein JNI-Overhead
std::string err = sherpa_audio_convert_pcm_to_format(
    entry->samples.data(),
    (int)entry->samples.size(),
    entry->sampleRate,
    entry->channelCount,
    [outputPath UTF8String],
    [format UTF8String],
    (int)outputSampleRateHz);
```

### 4.5 Kotlin-Implementierung: `convertPipelineAudioBufferToFormat`

```kotlin
// SherpaOnnxModule.kt

override fun convertPipelineAudioBufferToFormat(
    bufferId: String,
    outputPath: String,
    format: String,
    outputSampleRateHz: Double?,
    promise: Promise,
) {
    val rate = outputSampleRateHz?.toInt() ?: 0

    // 1. Format + Sample-Rate-Validierung (vorab, bevor Registry-Lookup)
    if (!SUPPORTED_FORMATS.contains(format.lowercase())) {
        promise.reject(ConversionErrorCodes.UNSUPPORTED_FORMAT,
            "Unsupported format: $format")
        return
    }
    validateSampleRateForFormat(format, rate)?.let { err ->
        promise.reject(ConversionErrorCodes.INVALID_SAMPLE_RATE, err)
        return
    }

    try {
        if (bufferId.startsWith("off_")) {
            convertOfflineBuffer(bufferId, outputPath, format, rate)
        } else if (bufferId.startsWith("live_")) {
            convertLiveBuffer(bufferId, outputPath, format, rate)
        } else {
            promise.reject(ConversionErrorCodes.INVALID_ARGUMENT,
                "Invalid buffer ID prefix: expected off_ or live_")
            return
        }
        promise.resolve(null)
    } catch (e: IllegalArgumentException) {
        promise.reject(ConversionErrorCodes.BUFFER_NOT_FOUND, e.message, e)
    } catch (e: IllegalStateException) {
        promise.reject(ConversionErrorCodes.BUFFER_NOT_FINALIZED, e.message, e)
    } catch (e: Exception) {
        promise.reject(ConversionErrorCodes.CONVERT_ERROR, e.message, e)
    }
}

private fun convertOfflineBuffer(bufferId: String, outputPath: String, format: String, rate: Int) {
    val entry = PipelineAudioRegistry.getOffline(bufferId)
        ?: throw IllegalArgumentException("Offline buffer not found: $bufferId")
    if (entry.numSamples == 0) throw IllegalArgumentException("Buffer is empty")

    when (entry) {
        // File-backed: pass file path to FFmpeg
        is OfflineEntry.FileBacked -> {
            val err = nativeConvertAudioToFormat(entry.filePath, outputPath, format, rate)
            if (err.isNotEmpty()) throw RuntimeException(err)
        }

        // InMemory: direct PCM → FFmpeg via Custom AVIOContext
        is OfflineEntry.InMemory -> {
            val err = nativeConvertPcmToFormat(
                entry.samples, entry.sampleRate, entry.channelCount, outputPath, format, rate)
            if (err.isNotEmpty()) throw RuntimeException(err)
        }
    }
}

private fun convertLiveBuffer(bufferId: String, outputPath: String, format: String, rate: Int) {
    val entry = PipelineAudioRegistry.getLive(bufferId)
        ?: throw IllegalArgumentException("Live buffer not found: $bufferId")
    if (entry.state != LiveEntry.State.FINISHED)
        throw IllegalStateException("Live buffer must be finalized before conversion")
    if (entry.numSamples == 0) throw IllegalArgumentException("Buffer is empty")

    when {
        // Spool file available: pass file path to FFmpeg
        entry.hasActiveSpool -> {
            val err = nativeConvertAudioToFormat(entry.spoolPath, outputPath, format, rate)
            if (err.isNotEmpty()) throw RuntimeException(err)
        }

        // Ring snapshot: direct PCM → FFmpeg
        else -> {
            val snapshot = entry.snapshotRing()
            val err = nativeConvertPcmToFormat(
                snapshot, entry.sampleRate, 1, outputPath, format, rate)
            if (err.isNotEmpty()) throw RuntimeException(err)
        }
    }
}
```

### 4.6 iOS-Implementierung: `convertPipelineAudioBufferToFormat`

Analoge Logik in `SherpaOnnx+PipelineAudio.mm`:

```objc
- (void)convertPipelineAudioBufferToFormat:(NSString *)bufferId
                                outputPath:(NSString *)outputPath
                                    format:(NSString *)format
                        outputSampleRateHz:(NSNumber *)outputSampleRateHz
                                   resolve:(RCTPromiseResolveBlock)resolve
                                    reject:(RCTPromiseRejectBlock)reject
{
    int rate = outputSampleRateHz ? [outputSampleRateHz intValue] : 0;
    std::string bid = [bufferId UTF8String];
    std::string out = [outputPath UTF8String];
    std::string fmt = [format UTF8String];

    // Format + Rate Validierung
    // ...

    std::lock_guard<std::mutex> lock(g_pa_mutex);

    // Offline-Buffer?
    if (bid.rfind("off_", 0) == 0) {
        auto it = g_pa_offline.find(bid);
        if (it == g_pa_offline.end()) {
            reject(@"CONVERSION_BUFFER_NOT_FOUND", @"Offline buffer not found", nil);
            return;
        }
        auto &entry = it->second;
        if (entry->isFileBacked) {
            std::string err = sherpa_audio_convert_to_format(
                entry->filePath.c_str(), out.c_str(), fmt.c_str(), rate);
            // ...
        } else {
            std::string err = sherpa_audio_convert_pcm_to_format(
                entry->samples.data(), (int)entry->samples.size(),
                entry->sampleRate, entry->channelCount,
                out.c_str(), fmt.c_str(), rate);
            // ...
        }
    }
    // Live-Buffer?
    else if (bid.rfind("live_", 0) == 0) {
        auto it = g_pa_live.find(bid);
        if (it == g_pa_live.end()) {
            reject(@"CONVERSION_BUFFER_NOT_FOUND", @"Live buffer not found", nil);
            return;
        }
        auto &entry = it->second;
        if (entry->state != PaLiveEntry::FINISHED) {
            reject(@"CONVERSION_BUFFER_NOT_FINALIZED",
                   @"Live buffer must be finalized before conversion", nil);
            return;
        }
        // Analoge Routing-Logik wie Android (FFmpeg-only: spool / snapshot)
        // ...
    }
}
```

---

## 5. Vollständige Removal-Liste

### 5.1 JS-Ebene

| Datei | Entfernt |
|-------|----------|
| `src/audiobuffer/index.ts` | `saveOfflineAudioBufferToWav()`, `saveLiveAudioBufferToWav()` + Exports |
| `src/audio/index.ts` | `convertAudioToFormat()` (alte Signatur), `convertAudioToWav16k()` (alte Signatur), `decodeAudioFileToFloatSamples()`, `DecodedAudioFloatSamples` type |
| Package-Exports (`package.json` exports map) | Kein Re-Export der entfernten Funktionen |

### 5.2 TurboModule Spec (`src/NativeSherpaOnnx.ts`)

| Entfernt |
|----------|
| `saveOfflineAudioBufferToWav(bufferId, outputPath)` |
| `saveLiveAudioBufferToWav(liveBufferId, outputPath)` |
| `convertAudioToFormat(inputPath, outputPath, format, outputSampleRateHz?)` |
| `convertAudioToWav16k(inputPath, outputPath)` |
| `decodeAudioFileToFloatSamples(inputPath, targetSampleRateHz?)` |

### 5.3 Android Native

| Datei | Entfernt |
|-------|----------|
| `SherpaOnnxModule.kt` | `saveOfflineAudioBufferToWav()`, `saveLiveAudioBufferToWav()`, `convertAudioToFormat()` (file-basiert), `convertAudioToWav16k()`, `decodeAudioFileToFloatSamples()`, `resolveInputForConvert()` (Content-URI-Handling) |
| `PipelineAudioRegistry.kt` | `saveOfflineToWav()` (public), `saveLiveToWav()` (public) |
| `sherpa-onnx-audio-convert-jni.cpp` | `nativeConvertAudioToWav16k` JNI-Binding, `nativeDecodeAudioFileToFloatSamples` JNI-Binding |

**Beibehalten (intern):**
- `nativeConvertAudioToFormat` (jetzt intern von `convertPipelineAudioBufferToFormat` für alle Formate inkl. WAV genutzt)

### 5.4 iOS Native

| Datei | Entfernt |
|-------|----------|
| `SherpaOnnx+PipelineAudio.mm` | `saveOfflineAudioBufferToWav:` Bridge-Methode, `saveLiveAudioBufferToWav:` Bridge-Methode |
| `SherpaOnnx.mm` (oder Audio-Convert-Bridge) | `convertAudioToFormat:` (file-basiert), `convertAudioToWav16k:`, `decodeAudioFileToFloatSamples:` Bridge-Methoden |

**Beibehalten (intern):**
- `sherpa_audio_convert_to_format()` C++-Funktion (intern für alle Formate inkl. WAV)

### 5.5 Dokumentation

| Datei | Änderung |
|-------|----------|
| `docs/audio-conversion.md` | Komplett neuschreiben: Buffer-Input, kein decodeAudioFileToFloatSamples, kein Content-URI-Input, keine saveAudioFromGeneration-Referenzen |
| `docs/audiobuffer-offline.md` | `saveOfflineAudioBufferToWav`-Sektion entfernen; Verweis auf `convertAudioToFormat(buf, path, 'wav')` |
| `docs/audiobuffer-streaming.md` | `saveLiveAudioBufferToWav`-Sektion entfernen; Verweis auf `convertAudioToFormat(buf, path, 'wav')` |
| `docs/tts-offline.md` | `saveAudioFromGeneration`-Referenzen ersetzen durch `convertAudioToFormat` |
| `docs/files.md` | `saveAudioFromGeneration` / `saveAudioFromPCM`-Referenzen entfernen |
| `docs/disable-ffmpeg.md` | `saveAudioFromGeneration`-Referenzen ersetzen; decodeAudioFileToFloatSamples-Zeilen entfernen |

---

## 6. Implementierungs-Reihenfolge

### Phase 1: Neue C++-Funktion `sherpa_audio_convert_pcm_to_format`

1. Implementierung der Custom-AVIOContext-freien FFmpeg-Encode-Pipeline in shared C++ (§4.4.1–4.4.2).
2. JNI-Binding `nativeConvertPcmToFormat` (Android, §4.4.3).
3. Direkter Aufruf aus Obj-C++ (iOS, §4.4.4).
4. Manuelle Tests: Float-Array → MP3, FLAC, AAC, Opus, WAV-mit-Resample.

### Phase 2: Neuer nativer Endpunkt `convertPipelineAudioBufferToFormat`

1. TurboModule Spec: `convertPipelineAudioBufferToFormat` hinzufügen (§3.1).
2. Android `SherpaOnnxModule.kt`: Kotlin-Implementierung mit Routing-Logik (§4.5).
3. iOS `SherpaOnnx+PipelineAudio.mm`: Obj-C++-Implementierung (§4.6).
4. Tests: Offline InMemory → MP3, Offline FileBacked → FLAC, Live+Spool → Opus, Live Ring → WAV.

### Phase 3: JS-API umstellen

1. `src/audio/types.ts` neu anlegen (§2.1).
2. `src/audio/index.ts` umschreiben: neue `convertAudioToFormat` + `convertAudioToWav16k` (§2.2–2.3).
3. `src/audiobuffer/index.ts`: `saveOfflineAudioBufferToWav` und `saveLiveAudioBufferToWav` entfernen.
4. TypeScript typecheck + lint.

### Phase 4: Legacy-Endpunkte entfernen

1. TurboModule Spec: alle 5 alten Methoden entfernen (§3.2).
2. Android `SherpaOnnxModule.kt`: alte Kotlin-Methoden + `resolveInputForConvert` + Content-URI-Handling entfernen.
3. iOS: alte Bridge-Methoden entfernen.
4. JNI: `nativeConvertAudioToWav16k`, `nativeDecodeAudioFileToFloatSamples` Bindings entfernen.
5. Build-Verifikation (Android + iOS).

### Phase 5: Dokumentation

1. `docs/audio-conversion.md` komplett neuschreiben.
2. Alle anderen Docs aktualisieren (§5.5).
3. Changelog-Eintrag (Breaking Changes).

---

## 7. Behavioral Contracts

### 7.1 Live-Buffer: Finalization erforderlich

`convertAudioToFormat` **rejected** mit `BUFFER_NOT_FINALIZED` wenn ein Live-Buffer im `recording`-State übergeben wird. Der User muss zuerst `finalizeLiveAudioBuffer()` aufrufen. Das vermeidet Race-Conditions durch parallele Append-Operationen während der Konvertierung.

```ts
// Korrekt:
await stopMicToLiveAudioBuffer();
await finalizeLiveAudioBuffer(liveBuffer);
await convertAudioToFormat(liveBuffer, '/path/to/output.mp3', 'mp3');

// Rejected (BUFFER_NOT_FINALIZED):
await convertAudioToFormat(liveBuffer, '/path/to/output.mp3', 'mp3');
// → liveBuffer ist noch im recording-State
```

### 7.2 FFmpeg-only path (including WAV)

Alle Konvertierungen laufen über FFmpeg, inklusive `wav`.

Wenn FFmpeg deaktiviert oder nicht verfügbar ist, wird die Konvertierung für **alle** Zielformate rejected (inkl. WAV) mit einem dedizierten Conversion-Error.

### 7.3 Sample-Rate-Semantik

| Format | `outputSampleRateHz = 0` (oder omitted) | Expliziter Wert |
|--------|-----------------------------------------|-----------------|
| WAV | Buffer's native Rate (via FFmpeg) | Resample zu Zielrate (FFmpeg) |
| MP3 | 44100 Hz (libshine Default) | Nur 32000, 44100, 48000 erlaubt |
| Opus / WEBM / MKV / OGG | 48000 Hz (libopus Default) | Nur 8000, 12000, 16000, 24000, 48000 erlaubt |
| FLAC | Buffer's native Rate | Resample zu Zielrate |
| AAC / M4A | Buffer's native Rate | Resample zu Zielrate |

Format-spezifische Validierung findet **nativ** statt, bevor die FFmpeg-Pipeline startet. Ungültige Werte werden mit `INVALID_SAMPLE_RATE` rejected.

### 7.4 Output-Pfad

- Muss ein absoluter lokaler Dateipfad sein.
- Parent-Verzeichnis muss existieren (kein auto-mkdir).
- Keine `content://`-URIs. Für Android SAF: `convertAudioToFormat` → lokale Datei → `copyFileToContentUri`.
- Bestehende Datei wird überschrieben.

### 7.5 Buffer-Lifecycle unverändert

`convertAudioToFormat` **verändert den Buffer nicht** — er bleibt nach der Konvertierung im Registry und kann weiter verwendet werden (weitere Konvertierungen, STT, etc.). Release erfolgt weiterhin explizit über `releasePipelineAudioBuffer`.

### 7.6 Thread-Safety

- Offline `InMemory`: Samples sind immutable nach Erstellung → kein Lock nötig.
- Offline `FileBacked`: Datei ist immutable → kein Lock nötig.
- Live (finalized) + Spool: Spool-Datei ist nach Finalisierung geschlossen und immutable → kein Lock nötig.
- Live (finalized) ohne Spool: `snapshotRing()` nutzt bestehende Read-Locks → thread-safe.

### 7.7 Plattform-Support-Matrix nach Migration

| Feature | Android | iOS | FFmpeg erforderlich? |
|---------|---------|-----|---------------------|
| Buffer → WAV (native Rate) | ✅ | ✅ | Ja |
| Buffer → WAV (Resampling) | ✅ | ✅ | Ja |
| Buffer → MP3 | ✅ | ✅ | Ja |
| Buffer → FLAC | ✅ | ✅ | Ja |
| Buffer → AAC / M4A | ✅ | ✅ | Ja |
| Buffer → Opus / WEBM / MKV / OGG | ✅ | ✅ | Ja |

---

## 8. Usage Examples

### 8.1 TTS → MP3 speichern

```ts
import { createTTS } from 'react-native-sherpa-onnx/tts';
import { convertAudioToFormat } from 'react-native-sherpa-onnx/audio';
import { releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';
import { CachesDirectoryPath } from '@dr.pogodin/react-native-fs';

const engine = await createTTS({ modelPath: { modelDir: '/models/vits' } });
const result = await engine.synthesize('Hallo Welt', textBuffer, audioBuffer);

// Direkt Buffer → MP3 — ein nativer Call, kein Temp-File
await convertAudioToFormat(
  audioBuffer,
  `${CachesDirectoryPath}/output.mp3`,
  'mp3',
  44100,
);

// Optional: SAF-Export für Android
// await copyFileToContentUri(`${CachesDirectoryPath}/output.mp3`, safDirectoryUri, 'output.mp3');

await releasePipelineAudioBuffer(audioBuffer);
```

### 8.2 Externe Datei → STT-kompatibles WAV

```ts
import { createOfflineAudioBufferFromFile } from 'react-native-sherpa-onnx/audiobuffer';
import { convertAudioToWav16k } from 'react-native-sherpa-onnx/audio';

// Datei in Buffer laden (native Dekodierung, kein JS-Bridge-Overhead)
const buf = await createOfflineAudioBufferFromFile('/path/to/recording.m4a');

// Buffer → 16 kHz WAV (Resampling via FFmpeg falls nötig)
await convertAudioToWav16k(buf, '/path/to/stt_input.wav');

// Oder direkt für STT nutzen — kein WAV-Zwischenschritt nötig:
// const result = await engine.transcribe(buf, textBuffer);
```

### 8.3 Live-Aufnahme → FLAC

```ts
import {
  createLiveAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  finalizeLiveAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import { convertAudioToFormat } from 'react-native-sherpa-onnx/audio';

const mic = await createLiveAudioBuffer({ sampleRate: 44100 });
await startMicToLiveAudioBuffer(mic.bufferId);

// ... Aufnahme läuft ...

await stopMicToLiveAudioBuffer();
await finalizeLiveAudioBuffer(mic);  // PFLICHT vor Konvertierung

// Buffer → FLAC — ein nativer Call
await convertAudioToFormat(mic, '/path/to/recording.flac', 'flac');

await releasePipelineAudioBuffer(mic);
```

### 8.4 Enhancement → Opus für Sharing

```ts
import { createStreamingEnhancement } from 'react-native-sherpa-onnx/enhancement';
import { convertAudioToFormat } from 'react-native-sherpa-onnx/audio';

// ... Enhancement-Pipeline gelaufen, enhancedBuffer ist finalized ...

await convertAudioToFormat(enhancedBuffer, '/path/to/clean.opus', 'opus', 16000);

// Teilen via Share-Sheet:
// await Share.open({ url: 'file:///path/to/clean.opus' });
```

---

## 9. Risiken / Edge Cases

1. **FFmpeg nicht verfügbar:** Alle Konvertierungen schlagen fehl (inkl. WAV), da der Konvertierungspfad vollständig FFmpeg-basiert ist.

2. **Spool-Format-Varianz:** Live-Buffer-Spool-Files können als `wav_pcm_s16le` oder `wav_pcm_float` vorliegen. Die bestehende `nativeConvertAudioToFormat(filePath, ...)` FFmpeg-Pipeline handhabt beide WAV-Varianten korrekt über automatische Input-Format-Erkennung.

3. **Große FileBacked-Buffer:** Bei Spool-/FileBacked-Pfaden arbeitet FFmpeg streaming (chunk-basiert) — kein vollständiges Laden in RAM. Für Offline `InMemory` liegt der gesamte Float-Array im Heap; bei typischen Größen (<100 MB) ist das unproblematisch.

4. **Leere Buffer:** `numSamples == 0` wird frühzeitig mit `BUFFER_EMPTY` rejected. Kein Versuch, eine leere Datei zu encodieren.

5. **Parallele Konvertierungen:** Mehrere `convertAudioToFormat`-Aufrufe auf denselben Buffer sind sicher (Buffer ist immutable bzw. finalized). Parallele Schreiboperationen auf denselben `outputPath` liegen in der Verantwortung des Users.
