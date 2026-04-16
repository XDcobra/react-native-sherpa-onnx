# Spool-Format-Migration: Always-F32-WAV + Simplified Live→Offline — Implementation Spec

**Status:** Ready for implementation  
**Depends on:** [perf-offline-audio-buffer-mmap-impl-spec.md](./perf-offline-audio-buffer-mmap-impl-spec.md) (mmap infrastructure, already implemented)  
**Analysis:** [spool-format-f32-vs-wav-analysis.md](./spool-format-f32-vs-wav-analysis.md) (trade-off analysis, Option B+C chosen)  
**Breaking changes:** Yes — `persistenceFormat` option removed from public API. SDK is pre-release.

---

## 0. Decision Summary

| Decision | Choice | Rationale |
|---|---|---|
| Spool sample format | **Always Float32 WAV** (audioFormat=3, 32-bit) | Eliminates S16 branch, prevents F32→S16→F32 precision loss |
| `persistenceFormat` API | **Remove entirely** | Single format internally, no user choice needed |
| `SpoolFormat` enum | **Remove entirely** | Dead code after forced F32 |
| `createOfflineFromLive` optimization | **Skip 44 bytes + raw copy to .f32 → mmap** | Simpler than adding `dataOffset` to mmap infrastructure; keeps PaMmapRegion/MmapBacked uniform |

### Why raw byte copy (skip 44) over `dataOffset` in mmap structs?

Adding a `dataOffset` field to `PaMmapRegion` (iOS) and `OfflineEntry.MmapBacked` (Android) would distribute offset awareness to every consumer: `floatPtr()`, `numSamples()`, `readSlice()`, `readAllSamples()`, JSI access, and any future reader. One missed consumer = silent data corruption (reading WAV header bytes as float samples).

The copy approach localizes complexity to **one function** (`createOfflineFromLive`). All downstream mmap consumers see a clean headerless `.f32` file — identical to what `decodeFileToOfflineBuffer` already produces. The copy cost is negligible: sequential I/O at memory-bandwidth speed, one-time at conversion.

---

## 1. Scope

### In scope
- Hardcode spool format to Float32 WAV (audioFormat=3) on both platforms
- Remove `SpoolFormat` enum, `persistenceFormat` option, `spoolIsFloat`/`isFloat` branching
- Simplify `createOfflineFromLive()`: WAV F32 spool → skip 44 bytes → raw copy → .f32 → mmap
- Remove S16 branches from SpoolWriter (Android) and PaLiveEntry (iOS)
- Remove `persistenceFormat` from TypeScript types, native bridge, and codegen spec
- Update documentation that references `persistenceFormat`
- Clean up `FileBackedReader` S16 branch (Android) since spool is the only WAV source for live→offline

### Out of scope
- Changes to `AudioDecodeSession` / `AudioEncodeSession` C++ code
- Changes to `saveAudioAsFile()` flow (still passes WAV spool path to `decodeFile()` — works unchanged)
- Changes to offline buffer mmap infrastructure (PaMmapRegion, OfflineEntry.MmapBacked)

---

## 2. File-by-File Changes

### 2.1 TypeScript — API Surface

#### `src/audiobuffer/types.ts`
- **Remove** `persistenceFormat` from `CreateLiveAudioBufferOptions` interface
- Remove associated JSDoc

#### `src/audiobuffer/index.ts`
- **Remove** `persistenceFormat` pass-through in `createEmptyLiveAudioBuffer()`

#### `src/NativeSherpaOnnx.ts`
- **Remove** `persistenceFormat` from `SpecCreateEmptyLiveAudioBufferOptions` type
- Remove associated JSDoc `@param` entry

After these changes, codegen will regenerate `SherpaOnnxSpec.h` without the `persistenceFormat()` accessor. The iOS bridge code that reads `options.persistenceFormat()` must be updated simultaneously.

---

### 2.2 Android — Kotlin

#### `android/src/main/java/com/sherpaonnx/audio/pipeline/LiveEntry.kt`

**Remove `SpoolFormat` enum:**
```kotlin
// DELETE entirely:
enum class SpoolFormat {
  WAV_PCM_S16LE,
  WAV_PCM_FLOAT
}
```

**Simplify `PersistenceConfig`:**
```kotlin
// BEFORE:
data class PersistenceConfig(
  val filePath: String,
  val format: SpoolFormat = SpoolFormat.WAV_PCM_S16LE
)

// AFTER:
data class PersistenceConfig(
  val filePath: String,
)
```

**Simplify `SpoolWriter`:**

Remove fields: `isFloat`, `bytesPerSample` (now constants: always 4, always float).

```kotlin
// BEFORE writeWavHeader():
header.putShort(if (isFloat) 3 else 1) // audioFormat
// ...
header.putInt(sampleRate * channelCount * bytesPerSample)
header.putShort((channelCount * bytesPerSample).toShort())
header.putShort((bytesPerSample * 8).toShort())

// AFTER writeWavHeader() — hardcoded F32:
header.putShort(3) // audioFormat = IEEE Float
// ...
header.putInt(sampleRate * channelCount * 4) // byteRate
header.putShort((channelCount * 4).toShort()) // blockAlign
header.putShort(32) // bitsPerSample
```

```kotlin
// BEFORE append():
val buf = ByteBuffer.allocate(samples.size * bytesPerSample).order(ByteOrder.LITTLE_ENDIAN)
if (isFloat) {
  for (s in samples) buf.putFloat(s)
} else {
  for (s in samples) {
    val clamped = s.coerceIn(-1.0f, 1.0f)
    buf.putShort((clamped * 32767.0f).toInt().coerceIn(-32768, 32767).toShort())
  }
}

// AFTER append():
val buf = ByteBuffer.allocate(samples.size * 4).order(ByteOrder.LITTLE_ENDIAN)
for (s in samples) buf.putFloat(s)
```

```kotlin
// BEFORE finalize_():
val dataSize = totalSamplesWritten * bytesPerSample

// AFTER finalize_():
val dataSize = totalSamplesWritten * 4
```

#### `android/src/main/java/com/sherpaonnx/SherpaOnnxModule.kt`

**`createEmptyLiveAudioBuffer()`** — Remove format parsing:
```kotlin
// BEFORE:
val persistence = if (options.hasKey("persistencePath")) {
  val path = options.getString("persistencePath") ?: throw ...
  val formatStr = if (options.hasKey("persistenceFormat")) options.getString("persistenceFormat") else "wav_pcm_s16le"
  val format = when (formatStr) {
    "wav_pcm_float" -> SpoolFormat.WAV_PCM_FLOAT
    else -> SpoolFormat.WAV_PCM_S16LE
  }
  PersistenceConfig(path, format)
} else null

// AFTER:
val persistence = if (options.hasKey("persistencePath")) {
  val path = options.getString("persistencePath") ?: throw ...
  PersistenceConfig(path)
} else null
```

**`startFileIngestToLiveBuffer()`** — Remove format from auto-spool:
```kotlin
// BEFORE:
liveEntry.enableSpool(
  PersistenceConfig(tmpSpoolPath, SpoolFormat.WAV_PCM_S16LE),
  temporary = true
)

// AFTER:
liveEntry.enableSpool(
  PersistenceConfig(tmpSpoolPath),
  temporary = true
)
```

#### `android/src/main/java/com/sherpaonnx/audio/pipeline/PipelineAudioRegistry.kt`

**Simplify `createOfflineFromWavSpoolFile()`:**

The current implementation streams WAV via `FileBackedReader` (which handles S16→F32 conversion). Since spool is now always F32 WAV, this becomes a trivial byte copy:

```kotlin
// AFTER — simplified createOfflineFromF32WavSpoolFile():
private fun createOfflineFromF32WavSpoolFile(
  bufferId: String,
  spoolPath: String,
  sampleRate: Int,
  channelCount: Int,
): OfflineEntry? {
  val dir = cacheDir ?: return null
  val f32File = File(dir, "pa_off_${bufferId}.f32")
  val spoolFile = File(spoolPath)

  return try {
    // Skip 44-byte WAV header, copy raw F32 bytes directly
    spoolFile.inputStream().use { input ->
      val skipped = input.skip(44)
      if (skipped != 44L) throw RuntimeException("Failed to skip WAV header")
      f32File.outputStream().use { output ->
        input.copyTo(output, bufferSize = 32768)
      }
    }

    val numSamples = (f32File.length() / 4).toInt()
    if (numSamples <= 0) {
      f32File.delete()
      return null
    }

    OfflineEntry.createMmapFromFile(
      bufferId, sampleRate, channelCount, numSamples,
      f32File.absolutePath
    ) ?: run {
      f32File.delete()
      null
    }
  } catch (e: Exception) {
    Log.w(TAG, "createOfflineFromF32WavSpoolFile failed: ${e.message}")
    f32File.delete()
    null
  }
}
```

**Update `createOfflineFromLive()`:**
```kotlin
// BEFORE:
val metadata = parseWavHeader(spoolPath)
if (metadata != null) {
  createOfflineFromWavSpoolFile(bufferId, spoolPath, metadata)
    ?: createFromRingSnapshot(bufferId, live)
}

// AFTER:
createOfflineFromF32WavSpoolFile(bufferId, spoolPath, live.sampleRate, live.channelCount)
  ?: createFromRingSnapshot(bufferId, live)
```

No WAV header parsing needed — we know the format (always F32, metadata from the LiveEntry itself).

#### `android/src/main/java/com/sherpaonnx/audio/pipeline/FileBackedWav.kt`

**Remove S16 branch from `FileBackedReader.readSamples()`:**

```kotlin
// BEFORE:
when {
  metadata.audioFormat == 1 && metadata.bitsPerSample == 16 -> {
    val bytes = ByteArray(toRead * 2)
    raf.readFully(bytes)
    val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    for (i in 0 until toRead) {
      out[outOffset + i] = bb.short.toFloat() / 32768.0f
    }
  }
  metadata.audioFormat == 3 && metadata.bitsPerSample == 32 -> {
    val bytes = ByteArray(toRead * 4)
    raf.readFully(bytes)
    val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    for (i in 0 until toRead) {
      out[outOffset + i] = bb.float
    }
  }
}

// AFTER:
val bytes = ByteArray(toRead * 4)
raf.readFully(bytes)
val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
for (i in 0 until toRead) {
  out[outOffset + i] = bb.float
}
```

Note: `FileBackedReader` is still used by `appendOfflineToLive()` for streaming offline→live reads, and `parseWavHeader()` is still used by the WAV fast-path in `decodeFileToOfflineBuffer`. These functions remain but only encounter F32 WAV from spool files. External WAV files (user-provided) still go through `AudioDecodeSession` C++ code which handles all formats independently.

**Decision:** Keep `FileBackedWav.kt` with S16 support intact. It may be used to read external WAV files in future, and removing it now saves almost nothing. The only change is that `createOfflineFromLive` no longer calls it (uses raw byte copy instead).

---

### 2.3 iOS — Objective-C++ / C++

#### `ios/audio/pipeline/PaLiveEntry.h`

**Remove `spoolIsFloat` field:**
```cpp
// DELETE:
bool spoolIsFloat = false;
```

**Simplify constructor spool init:**
```cpp
// BEFORE:
if (!spoolPathArg.empty()) {
  spoolPath = spoolPathArg;
  spoolIsFloat = spoolFloat;
  spoolFile.open(spoolPath, std::ios::binary | std::ios::trunc);
  if (spoolFile) {
    int bytesPerSample = spoolFloat ? 4 : 2;
    int audioFormat = spoolFloat ? 3 : 1;
    pa_writeWavHeaderToStream(spoolFile, sr, bytesPerSample * 8, audioFormat, 0);
    hasActiveSpool = true;
  }
}

// AFTER:
if (!spoolPathArg.empty()) {
  spoolPath = spoolPathArg;
  spoolFile.open(spoolPath, std::ios::binary | std::ios::trunc);
  if (spoolFile) {
    pa_writeWavHeaderToStream(spoolFile, sr, 32, 3, 0); // always F32: audioFormat=3, 32-bit
    hasActiveSpool = true;
  }
}
```

**Remove `spoolFloat` parameter from constructor:**
```cpp
// BEFORE:
PaLiveEntry(const std::string &bid, int sr, int ch, double windowSec,
            const std::string &spoolPathArg, bool spoolFloat, ...)

// AFTER:
PaLiveEntry(const std::string &bid, int sr, int ch, double windowSec,
            const std::string &spoolPathArg, ...)
```

**Simplify `enableSpool()`:**
```cpp
// BEFORE:
void enableSpool(const std::string &path, bool isFloat, bool temporary = false) {
  // ...
  spoolIsFloat = isFloat;
  int bytesPerSample = isFloat ? 4 : 2;
  int audioFormat = isFloat ? 3 : 1;
  pa_writeWavHeaderToStream(spoolFile, sampleRate, bytesPerSample * 8, audioFormat, 0);
}

// AFTER:
void enableSpool(const std::string &path, bool temporary = false) {
  // ...
  pa_writeWavHeaderToStream(spoolFile, sampleRate, 32, 3, 0); // always F32
}
```

**Simplify `appendSamples()` spool write:**
```cpp
// BEFORE:
if (hasActiveSpool && spoolFile.is_open()) {
  if (spoolIsFloat) {
    spoolFile.write(reinterpret_cast<const char*>(toAppend), appendCount * 4);
  } else {
    for (size_t i = 0; i < appendCount; i++) {
      float c = std::max(-1.0f, std::min(1.0f, toAppend[i]));
      int16_t s = (int16_t)std::max(-32768, std::min(32767, (int)(c * 32767.0f)));
      spoolFile.write(reinterpret_cast<char*>(&s), 2);
    }
  }
  spoolSamplesWritten += appendCount;
}

// AFTER:
if (hasActiveSpool && spoolFile.is_open()) {
  spoolFile.write(reinterpret_cast<const char*>(toAppend), appendCount * 4);
  spoolSamplesWritten += appendCount;
}
```

**Simplify `finalize_()`:**
```cpp
// BEFORE:
int bytesPerSample = spoolIsFloat ? 4 : 2;
int64_t dataSize = spoolSamplesWritten * bytesPerSample;

// AFTER:
int64_t dataSize = spoolSamplesWritten * 4;
```

#### `ios/audio/bridge/SherpaOnnx+PipelineAudio.mm`

**`createEmptyLiveAudioBuffer()`** — Remove `persistenceFormat` reading:
```cpp
// BEFORE:
std::string spoolPath;
bool spoolFloat = false;
if (options.persistencePath()) {
  spoolPath = [options.persistencePath() UTF8String];
  if (options.persistenceFormat()) {
    NSString *fmt = options.persistenceFormat();
    spoolFloat = [fmt isEqualToString:@"wav_pcm_float"];
  }
}
// ...
auto entry = std::make_shared<PaLiveEntry>(bufferId, sr, ch, windowSec, spoolPath, spoolFloat, ...);

// AFTER:
std::string spoolPath;
if (options.persistencePath()) {
  spoolPath = [options.persistencePath() UTF8String];
}
// ...
auto entry = std::make_shared<PaLiveEntry>(bufferId, sr, ch, windowSec, spoolPath, ...);
```

**`startFileIngestToLiveBuffer()`** — Remove `isFloat` parameter:
```cpp
// BEFORE:
liveEntry->enableSpool([tmpSpoolPath UTF8String], false, true);

// AFTER:
liveEntry->enableSpool([tmpSpoolPath UTF8String], true);
```

**Replace `pa_createOfflineFromWavSpoolFileStreaming()`:**

The current function streams WAV, handles S16/F32 format detection, and converts to .f32. Since spool is now always F32 WAV, replace with a simpler version:

```cpp
/**
 * Copy raw F32 bytes from a WAV F32 spool file (skip 44-byte header) to a .f32 temp file, then mmap.
 * Returns the entry on success, or nullptr on failure (caller falls back to ring snapshot).
 */
static std::shared_ptr<PaOfflineEntry> pa_createOfflineFromF32WavSpool(
  const std::string &bufferId,
  const std::string &spoolPath,
  int sampleRate,
  int channelCount
) {
  std::string tempDir = pa_tempDir();
  std::string f32Path = tempDir + "/pa_off_" + bufferId + ".f32";

  try {
    std::ifstream wavFile(spoolPath, std::ios::binary);
    if (!wavFile) return nullptr;

    // Skip 44-byte WAV header
    wavFile.seekg(44);
    if (!wavFile) return nullptr;

    std::ofstream f32File(f32Path, std::ios::binary);
    if (!f32File) return nullptr;

    // Raw byte copy (F32→F32, no conversion)
    char buf[32768];
    while (wavFile.read(buf, sizeof(buf)) || wavFile.gcount() > 0) {
      f32File.write(buf, wavFile.gcount());
    }

    f32File.close();
    wavFile.close();

    // Mmap the .f32 file
    auto region = PaMmapRegion::mapFile(f32Path);
    if (!region) {
      unlink(f32Path.c_str());
      return nullptr;
    }

    auto entry = std::make_shared<PaOfflineEntry>();
    entry->bufferId = bufferId;
    entry->sampleRate = sampleRate;
    entry->channelCount = channelCount;
    entry->mmapRegion = std::move(region);
    return entry;

  } catch (...) {
    unlink(f32Path.c_str());
    return nullptr;
  }
}
```

**Update `createOfflineAudioBufferFromLive()` call site:**
```cpp
// BEFORE:
if (modeStr == "fullIfSpooled" && live->hasActiveSpool && live->state == PaLiveEntry::FINISHED && !live->spoolPath.empty()) {
  PaWavHeader hdr;
  if (pa_parseWavHeader(live->spoolPath, hdr)) {
    entry = pa_createOfflineFromWavSpoolFileStreaming(bufferId, live->spoolPath, hdr);
    // ... fallback ...
  }
}

// AFTER:
if (modeStr == "fullIfSpooled" && live->hasActiveSpool && live->state == PaLiveEntry::FINISHED && !live->spoolPath.empty()) {
  entry = pa_createOfflineFromF32WavSpool(bufferId, live->spoolPath, live->sampleRate, live->channelCount);
  if (!entry) {
    auto snapshot = live->snapshotRing();
    entry = pa_createEntryWithThreshold(bufferId, live->sampleRate, live->channelCount, snapshot);
  }
}
```

No WAV header parsing needed — we know the format. Metadata comes from the LiveEntry.

---

### 2.4 Documentation

#### `docs/migration/audiobuffer/audiobuffer-jsi-arraybuffer-implementation-spec.md`
- Remove `persistenceFormat` from the `SpecCreateEmptyLiveAudioBufferOptions` type definitions (lines ~1105, 1119, 1157, 1168)

#### `docs/migration/mmap/spool-format-f32-vs-wav-analysis.md`
- Add status note at top: "Implemented — see spool-format-migration-spec.md"

---

## 3. What Does NOT Change

| Component | Why unchanged |
|---|---|
| `AudioDecodeSession.cpp/.h` | `saveAudioAsFile` still passes WAV spool to `decodeFile()` — WAV F32 is already a supported fast path |
| `AudioEncodeSession.cpp/.h` | Encode pipeline is format-agnostic (receives float32 PCM) |
| `PaMmapRegion` (iOS) | No `dataOffset` needed — .f32 files remain headerless, uniform |
| `OfflineEntry.MmapBacked` (Android) | Same — no offset field needed |
| `pa_writeWavHeaderToStream()` | Still needed (just with hardcoded F32 args). Kept for WAV-compliance. |
| `pa_parseWavHeader()` / `parseWavHeader()` | Kept — used by `decodeFileToOfflineBuffer()` for user-provided WAV files. Not called in `createOfflineFromLive` anymore. |
| `FileBackedWav.kt` | Kept with both S16/F32 support — may be used for external WAV files in future |
| `saveAudioAsFile()` (both platforms) | Passes spool path to `decodeFile()` unchanged. WAV F32 is recognized by the WAV fast path. |
| `pa_encodeViaDecodeFile()` / `encodeViaDecodeFile()` | Unchanged — consumes WAV spool path, works with F32 WAV natively |

---

## 4. Migration Checklist

### Phase 1: TypeScript API (breaking change)
- [ ] Remove `persistenceFormat` from `CreateLiveAudioBufferOptions` in `src/audiobuffer/types.ts`
- [ ] Remove `persistenceFormat` pass-through in `src/audiobuffer/index.ts`
- [ ] Remove `persistenceFormat` from spec in `src/NativeSherpaOnnx.ts`

### Phase 2: Android native
- [ ] Remove `SpoolFormat` enum from `LiveEntry.kt`
- [ ] Simplify `PersistenceConfig` (remove `format` field) in `LiveEntry.kt`
- [ ] Hardcode F32 in `SpoolWriter` (remove `isFloat`/`bytesPerSample` fields, S16 branches) in `LiveEntry.kt`
- [ ] Remove `persistenceFormat` parsing in `SherpaOnnxModule.kt` (`createEmptyLiveAudioBuffer`)
- [ ] Remove `SpoolFormat` reference in auto-spool (`startFileIngestToLiveBuffer`) in `SherpaOnnxModule.kt`
- [ ] Replace `createOfflineFromWavSpoolFile()` with `createOfflineFromF32WavSpoolFile()` in `PipelineAudioRegistry.kt`
- [ ] Update `createOfflineFromLive()` call site to skip WAV parsing in `PipelineAudioRegistry.kt`
- [ ] Verify Android build: `./gradlew :react-native-sherpa-onnx:compileDebugKotlin`

### Phase 3: iOS native
- [ ] Remove `spoolIsFloat` field from `PaLiveEntry.h`
- [ ] Remove `spoolFloat`/`isFloat` parameter from constructor and `enableSpool()` in `PaLiveEntry.h`
- [ ] Hardcode F32 in spool init, `enableSpool()`, `appendSamples()`, `finalize_()` in `PaLiveEntry.h`
- [ ] Remove `persistenceFormat` reading in `createEmptyLiveAudioBuffer()` in `SherpaOnnx+PipelineAudio.mm`
- [ ] Update `enableSpool()` call in `startFileIngestToLiveBuffer()` in `SherpaOnnx+PipelineAudio.mm`
- [ ] Replace `pa_createOfflineFromWavSpoolFileStreaming()` with `pa_createOfflineFromF32WavSpool()` in `SherpaOnnx+PipelineAudio.mm`
- [ ] Update `createOfflineAudioBufferFromLive()` call site in `SherpaOnnx+PipelineAudio.mm`
- [ ] Verify iOS build: `xcodebuild -workspace ... -scheme ... -sdk iphonesimulator build`

### Phase 4: Documentation & cleanup
- [ ] Update `docs/migration/audiobuffer/audiobuffer-jsi-arraybuffer-implementation-spec.md`
- [ ] Update example app `PipelineShowcaseScreen.tsx` (remove `persistenceFormat: 'wav_pcm_float'`)
- [ ] Run codegen to regenerate `SherpaOnnxSpec.h` (happens automatically on build)

### Phase 5: Verification
- [ ] End-to-end test: create live buffer → append samples → finalize → createOfflineFromLive → verify samples
- [ ] End-to-end test: create live buffer → append samples → finalize → saveAudioAsFile → verify output
- [ ] End-to-end test: file ingest to live (auto-spool) → createOfflineFromLive → verify samples
- [ ] Verify spool files on disk are valid WAV F32 (open with sox/ffprobe)
- [ ] Verify mmap .f32 temp files are cleaned up on release

---

## 5. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `saveAudioAsFile` breaks with F32 WAV | Very Low | High | WAV F32 fast path already tested (existing `persistenceFormat: 'wav_pcm_float'` users) |
| Codegen mismatch after removing `persistenceFormat` | Low | Medium | Build both platforms after TypeScript change to trigger codegen |
| Auto-spool in file ingest creates wrong format | Low | Medium | Verify `enableSpool()` signature change propagated to all call sites |
| Disk space regression (2× spool size) | Low | Low | Spool is temporary, deleted on release. Typical recordings ≤ 10 min |
| Skip(44) reads wrong offset if WAV header is non-standard | Very Low | Medium | We control the writer — header is always exactly 44 bytes (no extra chunks) |

The last point is key: since we write the WAV header ourselves (no LIST, PEAK, or other optional chunks), the data section always starts at byte 44. This is guaranteed by `pa_writeWavHeaderToStream()` and `SpoolWriter.writeWavHeader()`.
