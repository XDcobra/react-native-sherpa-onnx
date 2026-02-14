# FFmpeg-Integration im SDK

## Ziel

- Verschiedene Audioformate unterstützen (MP3, M4A, OGG, FLAC, …).
- Ausgabe immer **WAV 16 kHz mono 16-bit PCM** für sherpa-onnx (STT/TTS).
- Integration wie sherpa-onnx und libarchive: beim **User-Build** (z. B. `yarn android`) baut/linkt alles ohne manuelle Schritte.

## Warum nicht FFmpeg beim User-Build aus Quellcode bauen?

| Ansatz | Problem |
|--------|--------|
| FFmpeg aus Source im CMake (z. B. `add_subdirectory`) | FFmpeg nutzt **autotools** (configure + make), kein natives CMake. Kein einfaches `add_subdirectory`. |
| `ExternalProject_Add` + configure/make | Möglich, aber: **lange Build-Zeit** (mehrere Minuten pro ABI), NDK-Version/Host-OS abhängig, fehleranfällig für Endnutzer. |
| Build bei `yarn install` | Bei TurboModules baut Native-Code **nicht** bei `yarn install`, sondern beim **Android-Build** der App. Ein FFmpeg-Source-Build würde dort laufen und jeden ersten Build stark verlängern. |

**Empfehlung:** FFmpeg **einmal** mit dem Android-NDK bauen (lokal oder in CI), **Prebuilt-Libs** ins Repo (oder als Release-Artefakt) legen und im SDK nur noch **linken** – analog zu sherpa-onnx (AAR mit .so) und klar getrennt von libarchive (Source im Repo, schnell baufähig).

## Zwei mögliche Wege

### Option A: Prebuilt FFmpeg (empfohlen)

- **Du** (oder CI) baust FFmpeg einmal pro ABI mit dem NDK (minimal: nur Audio-Decode + Resample).
- Ergebnis: `libavcodec.so`, `libavformat.so`, `libavutil.so`, `libswresample.so` (+ Headers) pro ABI.
- Diese Prebuilts kommen ins Repo unter z. B. `third_party/ffmpeg-prebuilt/android/` (siehe Layout unten).
- Beim User: nur **Linking** (wie sherpa-onnx), kein FFmpeg-Build → schneller, stabiler Build.

### Option B: FFmpeg bei jedem User-Build aus Source bauen

- Über CMake `ExternalProject_Add` ein Script aufrufen, das FFmpeg per configure + make mit NDK baut.
- Nachteile: sehr langer erster Build, Abhängigkeit von NDK/Host, schwer wartbar.
- Nur sinnvoll, wenn du keine Prebuilts ausliefern willst (z. B. Lizenz/Verteilung).

Im Folgenden ist **Option A** (Prebuilt) detailliert beschrieben; Option B nur kurz skizziert.

---

## Option A: Prebuilt FFmpeg – konkrete Umsetzung

### 1. Verzeichnisstruktur (im Repo)

```
third_party/
  ffmpeg-prebuilt/
    android/
      include/           # FFmpeg-Headers (libavcodec, libavformat, libavutil, libswresample)
        libavcodec/
        libavformat/
        libavutil/
        libswresample/
      arm64-v8a/
        libavcodec.so
        libavformat.so
        libavutil.so
        libswresample.so
      armeabi-v7a/
        ...
      x86/
        ...
      x86_64/
        ...
    README.md           # Hinweis: Prebuilts mit scripts/build-ffmpeg-android.sh erzeugen
scripts/
  build-ffmpeg-android.sh   # Nur für dich/CI: baut FFmpeg mit NDK, installiert nach third_party/ffmpeg-prebuilt/android/
```

Alternativ können die Prebuilts auch in `android/src/main/cpp/ffmpeg-prebuilt/` liegen (alles unter `android/`), dann ist die Pfadlogik in CMake/Gradle rein android-spezifisch.

### 2. FFmpeg minimal bauen (nur Audio)

- Nur Decoder/Formate aktivieren, die du brauchst (z. B. MP3, M4A/AAC, OGG/Vorbis, FLAC, WAV).
- Encoding und Video deaktivieren → kleinere Libs und weniger Build-Zeit.
- Beispiel-Configure-Flags (zum Anpassen in deinem Build-Script):

```bash
./configure \
  --target-os=android \
  --arch=arm64 \
  --cpu=armv8-a \
  --enable-cross-compile \
  --cross-prefix=$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24- \
  --sysroot=$NDK/toolchains/llvm/sysroot \
  --enable-shared \
  --disable-static \
  --disable-programs \
  --disable-doc \
  --disable-debug \
  --disable-avdevice \
  --disable-postproc \
  --disable-everything \
  --enable-decoder=mp3,m4a,aac,vorbis,flac,pcm_s16le,pcm_f32le \
  --enable-demuxer=mp3,mov,ogg,flac,wav \
  --enable-parser=mpegaudio,aac,vorbis,flac \
  --enable-swresample
```

- Build-Script-Ideen: [ffmpeg-android-maker](https://github.com/Javernaut/ffmpeg-android-maker), [ffmpeg-android-binary](https://github.com/husen-hn/ffmpeg-android-binary), oder eigenes Script mit NDK-Toolchain.

### 3. CMake-Einbindung (wie sherpa-onnx: nur Link)

In `android/src/main/cpp/CMakeLists.txt`:

- Prebuilt-Pfad pro ABI setzen (z. B. `third_party/ffmpeg-prebuilt/android/${ANDROID_ABI}` oder `ffmpeg-prebuilt/${ANDROID_ABI}`).
- `include_directories` auf `third_party/ffmpeg-prebuilt/android/include` (oder äquivalent).
- `target_link_libraries(sherpaonnx ... avcodec avformat avutil swresample)` und `link_directories(...)` auf das Prebuilt-Verzeichnis der aktuellen ABI.

Wichtig: Nur **linken**, kein `add_subdirectory` für FFmpeg-Source. Optional: FFmpeg nur linken, wenn das Prebuilt-Verzeichnis existiert (optionales Feature), sonst keine Audio-Konvertierung anbieten.

### 4. Gradle

- Kein Extra-Schritt nötig, wenn die .so unter einem von CMake gelesenen Pfad liegen (z. B. unter `third_party/ffmpeg-prebuilt/android/`).
- Die bestehende native Build-Pipeline (Gradle → CMake) baut nur deine Bibliothek `sherpaonnx` und linkt die FFmpeg-.so dazu. Die .so müssen ins APK; das passiert automatisch, wenn sie über `target_link_libraries` gebunden werden und CMake sie unter dem angegebenen Verzeichnis findet (oder du sie in `jniLibs` kopierst – dann musst du sie explizit ins Ziel kopieren).

Kurz: Entweder CMake findet die .so im Prebuilt-Ordner und linkt sie (dann werden sie in der Regel über die bestehende shared library ins APK übernommen), oder du führst ein kleines Gradle-Copy für `third_party/ffmpeg-prebuilt/android/**/*.so` nach `jniLibs` ein. Das hängt davon ab, wie euer CMake die Libs einbindet (als IMPORTED oder direkt Pfad).

### 5. Native API (C++ / JNI)

- Neues kleines Modul, z. B. **AudioConverter** (oder in bestehendes „utils“ integrieren):
  - Eine Funktion: `convertToWav16kMono(const char* inputPath, const char* outputPath)`.
  - Implementierung: FFmpeg nutzen (avformat_open_input, avcodec_find_decoder, avcodec_open2, av_read_frame, Decode, swr_convert auf 16 kHz mono, dann WAV schreiben).
- Eigenes JNI-File, z. B. `sherpa-onnx-audio-convert-jni.cpp`, das von Kotlin aus aufgerufen wird (z. B. `SherpaOnnxModule` oder eigener Helper wie `SherpaOnnxArchiveHelper`).
- STT/TTS: Vor Transcoding bzw. vor Nutzung einer Datei optional `convertToWav16kMono` aufrufen, wenn die Datei nicht schon WAV 16 kHz ist (oder API so dokumentieren: „Input sollte WAV 16 kHz sein, oder nutze convertToWav16k“).

### 6. TurboModule / JS-API

- Neue Methode z. B. `convertAudioToWav16k(inputPath: string, outputPath: string): Promise<void>` (oder mit Optionen wie `{ inputPath, outputPath }`).
- Auf Android: Kotlin ruft die JNI-Funktion auf; wenn FFmpeg nicht eingebunden ist, Promise reject mit Hinweis „FFmpeg not available“.

So bleibt das Verhalten für User wie gewohnt: **yarn install** → App bauen → alles in einem Schritt; FFmpeg wird nicht bei jedem User gebaut, sondern nur gelinkt.

---

## Option B: FFmpeg aus Source beim User-Build (kurz)

- In CMake: `ExternalProject_Add(ffmpeg ...)` mit einem Build-Script, das FFmpeg per configure + make mit NDK baut und in ein Install-Prefix schreibt; danach `IMPORTED`-Libraries für avcodec, avformat, avutil, swresample anlegen und linken.
- Nachteile: Build-Zeit (mehrere Minuten), NDK-Pfad/Host-Umgebung, Wartung. Nur empfehlenswert, wenn Prebuilts aus rechtlichen/vertrieblichen Gründen nicht möglich sind.

---

## Zusammenfassung

- **Output-Format:** Immer WAV 16 kHz mono 16-bit PCM; Umsetzung in einem zentralen Converter (C++/JNI + optional STT/TTS vorverarbeiten).
- **Einbau ins SDK:** FFmpeg wie sherpa-onnx als **Prebuilt** einbinden (Option A): Du baust mit NDK einmal (oder in CI), legst die .so + Headers unter `third_party/ffmpeg-prebuilt/android/`, CMake nur Link, neues kleines Native-Modul „Audio → WAV 16k“, eine TurboModule-Methode `convertAudioToWav16k`.
- **TurboModule / yarn install:** Unverändert – Native-Code wird beim **Android-Build** der App gebaut; durch Prebuilts bleibt der Build schnell und stabil.

Wenn du möchtest, kann als nächster Schritt ein konkreter Patch skizziert werden:  
1) Verzeichnis `third_party/ffmpeg-prebuilt/android` + Platzhalter-README,  
2) CMake-Erweiterung (inkl. optionaler FFmpeg-Flag),  
3) Stub für `sherpa-onnx-audio-convert-jni.cpp` und Kotlin/TS-API.
