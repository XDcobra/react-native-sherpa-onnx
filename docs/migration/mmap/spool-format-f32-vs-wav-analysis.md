# Live-Buffer Spool: .f32 (Raw PCM) vs .wav — Trade-off-Analyse

> **Status:** Implemented — Option B+C chosen. See [spool-format-migration-spec.md](./spool-format-migration-spec.md).

**Datum:** 2026-04-16  
**Kontext:** Nach der Implementierung des mmap-backed OfflineEntry (`.f32` temp files) und dem Streaming-WAV→F32-Konverter für `createOfflineFromLive()` stellt sich die Frage, ob der Live-Buffer Spool ebenfalls als Raw-F32 statt WAV geschrieben werden sollte.

---

## 1. Status Quo: Zwei verschiedene Formate im System

| Komponente | Format | Begründung |
|---|---|---|
| **OfflineEntry temp files** | `.f32` (raw float32 LE, headerless) | Internes Format, nie von externen Tools gelesen. Trivial zu mmapen. |
| **LiveEntry spool files** | `.wav` (RIFF/WAV, S16LE oder F32 PCM) | Historisch bedingt. Standardformat mit Header-Metadaten (sampleRate, channels, format). |

Die Asymmetrie erzeugt Komplexität: `createOfflineFromLive()` muss WAV → F32 streaming-konvertieren (Header parsen, S16→F32 konvertieren, in neue `.f32` Datei schreiben, dann mmapen).

---

## 2. Alle Konsumenten der Spool-Datei

Die Spool-Datei wird an **genau zwei Stellen** konsumiert:

### 2.1 `createOfflineFromLive(mode: "fullIfSpooled")`

**Aktueller Flow:**
```
WAV spool → parseWavHeader() → stream WAV chunks → S16→F32 convert → write .f32 → mmap
```

**Bei .f32 Spool wäre der Flow:**
```
.f32 spool → mmap direkt (oder Datei kopieren + mmap)
```

→ **Massiver Gewinn.** Die gesamte Streaming-Konvertierung entfällt. Die Spool-Datei *ist* bereits das Format, das der OfflineEntry braucht.

### 2.2 `saveAudioAsFile()` (Live-Buffer → MP3/FLAC/WAV etc.)

**Aktueller Flow:**
```
WAV spool path → sherpa::decodeFile(path) → WAV Fast Path → float32 samples → AudioEncodeSession → output
```

`sherpa::decodeFile()` erkennt WAV automatisch über den RIFF-Header und nutzt einen optimierten Fast Path (kein FFmpeg nötig). Bei S16-WAV werden die Samples inline zu Float32 konvertiert; bei F32-WAV werden sie direkt gelesen.

**Bei .f32 Spool:**
```
.f32 spool path → sherpa::decodeFile(path) → ❌ RIFF-Header fehlt → FFmpeg Fallback → ❌ FFmpeg kann headerless raw PCM nicht auto-detecten → FEHLER
```

→ **Kritischer Blocker.** `AudioDecodeSession` hat keinen Support für headerlose Raw-PCM-Dateien. Weder der WAV Fast Path noch der FFmpeg-Pfad können `.f32` ohne explizite Format-Hints (sampleRate, channels, sampleFormat) lesen.

---

## 3. Optionen

### Option A: Spool auf .f32 umstellen + Raw-PCM-Support in AudioDecodeSession

| Aspekt | Bewertung |
|---|---|
| `createOfflineFromLive()` | ✅ Trivial: direkt mmap oder copy+mmap |
| `saveAudioAsFile()` | ⚠️ Erfordert Änderungen an `AudioDecodeConfig` + Fast Path |
| SpoolWriter-Komplexität | ✅ Massiv vereinfacht: kein WAV-Header, kein finalize-Patching |
| Aufwand | 🔴 Hoch: AudioDecodeSession ist shared C++ code (Android + iOS), Änderung betrifft alle Decode-Pfade |
| Risiko | 🔴 Regressionsgefahr in bestehendem Decode-Code |

**Nötige Änderungen an AudioDecodeSession:**
```cpp
struct AudioDecodeConfig {
  int targetSampleRate = 0;
  bool forceMono = true;
  int chunkSize = 8192;
  // NEU: Raw PCM hints (wenn inputPath headerless ist)
  int rawPcmSampleRate = 0;       // 0 = auto-detect via header
  int rawPcmBitsPerSample = 0;    // 32 für f32le
  int rawPcmChannelCount = 0;     // 1 für mono
  bool rawPcmIsFloat = false;     // true für float32
};
```

Plus ein neuer Fast Path in `decodeFile()` der diese Hints nutzt wenn der RIFF-Header fehlt.

### Option B: Spool auf WAV_PCM_FLOAT fest setzen (S16 abschaffen)

| Aspekt | Bewertung |
|---|---|
| `createOfflineFromLive()` | ✅ F32 WAV → F32 Raw = reine Byte-Kopie (kein S16→F32 nötig) |
| `saveAudioAsFile()` | ✅ Funktioniert unverändert (WAV F32 ist Standard) |
| SpoolWriter-Komplexität | ✅ Einfacher: kein S16-Branch, nur ein Format |
| Aufwand | 🟢 Niedrig: nur SpoolWriter/PaLiveEntry ändern |
| Risiko | 🟢 Minimal: WAV F32 wird bereits unterstützt |
| Disk-Overhead | ⚠️ 2× vs S16 (4 Bytes/Sample statt 2) |

**Nötige Änderungen:**
- `SpoolFormat` Enum entfernen, immer F32 WAV schreiben
- S16-Konvertierung aus append-Pfad entfernen
- `persistenceFormat` TypeScript-Option entfernen oder ignorieren
- Streaming-Konverter in `createOfflineFromLive()` vereinfachen (F32→F32 pass-through)

### Option C: WAV F32 Spool + Direkt-Mmap der WAV Data Section

| Aspekt | Bewertung |
|---|---|
| `createOfflineFromLive()` | ✅✅ Zero-Copy: mmap der WAV-Datei ab `dataOffset` (Byte 44) |
| `saveAudioAsFile()` | ✅ Funktioniert unverändert |
| SpoolWriter-Komplexität | ✅ Einfacher: nur F32, kein S16 |
| Aufwand | 🟡 Mittel: mmap mit Offset + PaMmapRegion anpassen |
| Risiko | 🟡 mmap-Offset muss page-aligned sein (44 ist es nicht) |
| Disk-Overhead | ⚠️ 2× vs S16 (gleich wie Option B) |

**Das page-alignment Problem:**
POSIX `mmap()` verlangt, dass der `offset`-Parameter ein Vielfaches der Page-Size (4096) ist. Der WAV Data-Offset bei 44 Bytes ist *nicht* page-aligned.

**Lösung:** Gesamte Datei mmapen (ab Offset 0) und `floatPtr()` um 44 Bytes offsetten:
```cpp
const float *floatPtr() const {
  return reinterpret_cast<const float *>(
    static_cast<const uint8_t *>(addr) + dataOffset
  );
}
int numSamples() const {
  return (length - dataOffset) / sizeof(float);
}
```

Das ist sauber, erfordert aber ein `dataOffset` Feld in `PaMmapRegion` / `OfflineEntry.MmapBacked`. Alternativ: Die Spool-Datei zur createOfflineFromLive-Zeit einfach ab Byte 44 in eine neue `.f32` kopieren (→ dann Option B).

### Option D: Status Quo beibehalten

| Aspekt | Bewertung |
|---|---|
| `createOfflineFromLive()` | ✅ Funktioniert (mit Streaming-Konverter) |
| `saveAudioAsFile()` | ✅ Funktioniert |
| SpoolWriter-Komplexität | ⚠️ Höher als nötig (WAV-Header, finalize-Patching, S16/F32 Branches) |
| Aufwand | 🟢 Null |
| Risiko | 🟢 Null |

---

## 4. Disk-Overhead: Wie relevant ist S16 vs F32?

| Aufnahmedauer | @ 16 kHz | S16 (2 B/s) | F32 (4 B/s) | Delta |
|---|---|---|---|---|
| 1 Minute | 960.000 Samples | 1,8 MB | 3,7 MB | +1,8 MB |
| 10 Minuten | 9.600.000 Samples | 18,3 MB | 36,6 MB | +18,3 MB |
| 30 Minuten | 28.800.000 Samples | 55,0 MB | 110 MB | +55 MB |
| 1 Stunde | 57.600.000 Samples | 110 MB | 220 MB | +110 MB |

Bei typischen Aufnahmen (≤ 10 Min @ 16 kHz) ist der Unterschied verkraftbar. Bei langen Aufnahmen (1 Stunde) wird er spürbar — aber die Spool-Datei ist temporär und wird nach `release()` gelöscht.

**Für VoiceLab typische Nutzung** (Offline-Toolbox, kurze bis mittlere Aufnahmen): Der 2× Overhead ist **akzeptabel**, weil:
1. Spool-Dateien sind temporär (gelöscht nach release/cleanup)
2. iOS gibt großzügig temporären Speicher
3. Android cacheDir wird vom OS bei Speicherdruck bereinigt

---

## 5. Empfehlung

### → **Option B: WAV F32 fest setzen** (kurzfristig, niedrigster Aufwand + höchster ROI)

**Begründung:**

1. **saveAudioAsFile() bleibt funktional** — kein Eingriff in den shared AudioDecodeSession C++-Code nötig
2. **createOfflineFromLive() wird erheblich einfacher** — Streaming-Konvertierung reduziert sich auf F32→F32 Byte-Kopie (kein S16→F32)
3. **SpoolWriter wird einfacher** — ein Format, keine Branches, kein `persistenceFormat`-Enum
4. **Keine Präzisionsverluste** — F32 Round-Trip ist verlustfrei (aktuell verliert S16 Spool Präzision)
5. **Minimales Risiko** — WAV F32 wird bereits vollständig unterstützt (Fast Path in AudioDecodeSession)
6. **Disk-Overhead ist akzeptabel** für die typische Nutzung

### → **Option C als Follow-Up** (mittelfristig, Zero-Copy)

Wenn Option B stabil läuft, kann `createOfflineFromLive()` weiter optimiert werden:
- Statt F32 WAV → Copy → .f32 → mmap: direkt die WAV-Datei ab Offset 44 mmapen
- Eliminiert die letzte Kopie komplett
- Erfordert `dataOffset`-Support in PaMmapRegion/OfflineEntry.MmapBacked

### → **Option A nur wenn Raw-PCM-Decode aus anderen Gründen gebraucht wird**

Den AudioDecodeSession-Code für headerlose Dateien zu erweitern lohnt sich nur, wenn es weitere Use Cases dafür gibt (z.B. externe Raw-PCM-Quellen). Für den Spool-internen Gebrauch ist der Aufwand unverhältnismäßig.

---

## 6. Konkrete Änderungen für Option B

### Android

**`LiveEntry.kt`** — `SpoolWriter`:
- `isFloat`-Flag und `bytesPerSample`-Variable entfernen
- `writeWavHeader()`: Immer `audioFormat=3`, `bitsPerSample=32`
- `append()`: Immer `buf.putFloat(s)`, kein S16-Branch
- `finalize_()`: Header-Patching bleibt (WAV-Compliance für saveAudioAsFile)

**`PipelineAudioRegistry.kt`** — `createOfflineFromWavSpoolFile()`:
- `FileBackedReader` mit F32-WAV ist reiner pass-through (`bb.float` statt `bb.short / 32768`)
- Alternativ: Direkt `InputStream.skip(44)` + raw copy (da immer F32)

**`FileBackedWav.kt`** — `FileBackedReader`:
- S16-Branch in `readSamples()` kann entfernt werden (nur F32 bleibt)

**`PersistenceConfig`** / **`SpoolFormat`**:
- `SpoolFormat` Enum auf nur `WAV_PCM_FLOAT` reduzieren oder ganz entfernen
- `PersistenceConfig.format` Feld entfernen

**`SherpaOnnxModule.kt`** — Bridge:
- `persistenceFormat` Parsing vereinfachen (immer F32)
- Auto-Spool in `startFileIngestToLiveBuffer()`: `.wav` Extension beibehalten (ist valide WAV F32)

### iOS

**`PaLiveEntry.h`**:
- `spoolIsFloat` Flag entfernen (immer true)
- Constructor/`enableSpool()`: Immer `audioFormat=3`, `bitsPerSample=32`
- `appendSamples()`: Immer `spoolFile.write(toAppend, appendCount * 4)`, kein S16-Branch
- `finalize_()`: Header-Patching bleibt

**`SherpaOnnx+PipelineAudio.mm`** — `pa_createOfflineFromWavSpoolFileStreaming()`:
- S16-Branch entfernen (nur F32→F32 pass-through bleibt)
- Oder: Vereinfachte Version die WAV-Header skippt und direkt Bytes kopiert

### TypeScript

**`types.ts`**:
- `persistenceFormat` Option als deprecated markieren oder entfernen
- `'wav_pcm_s16le' | 'wav_pcm_float'` → nur `'wav_pcm_float'` oder Option komplett entfernen

---

## 7. Zusammenfassung

| Kriterium | Status Quo (WAV S16/F32) | Option B (WAV F32 only) | Option A (.f32 raw) |
|---|---|---|---|
| saveAudioAsFile | ✅ | ✅ | 🔴 Bricht |
| createOfflineFromLive | ⚠️ S16→F32 Konvertierung | ✅ F32→F32 pass-through | ✅✅ Direct mmap |
| Spool-Schreibperformance | ⚠️ S16 Konvertierung im Default | ✅ Direkte F32 writes | ✅ Direkte F32 writes |
| Code-Komplexität | ⚠️ Zwei Format-Branches | ✅ Ein Format | ✅✅ Kein Header |
| Disk-Overhead (vs S16) | Baseline | 2× | 2× |
| Implementierungsaufwand | — | 🟢 Niedrig | 🔴 Hoch |
| Regressionrisiko | — | 🟢 Minimal | 🔴 AudioDecodeSession |

**Empfehlung: Option B (WAV F32 only) als nächster Schritt.**  
Die S16-Option hat in der Praxis keinen echten Nutzen — die Spool-Datei ist temporär und der Präzisionsverlust von F32→S16→F32 ist unnötig. WAV F32 gibt uns die Vereinfachung des internen Codes ohne den riskanten Eingriff in die Audio-Decode-Infrastruktur.
