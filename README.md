# react-native-sherpa-onnx

React Native SDK for sherpa-onnx – offline and streaming speech processing

<div align="center">
  <img src="./docs/images/banner.png" alt="Banner" width="560" />
</div>

<div align="center">

[![npm version](https://img.shields.io/npm/v/react-native-sherpa-onnx.svg)](https://www.npmjs.com/package/react-native-sherpa-onnx)
[![npm downloads](https://img.shields.io/npm/dm/react-native-sherpa-onnx.svg)](https://www.npmjs.com/package/react-native-sherpa-onnx)
[![npm license](https://img.shields.io/npm/l/react-native-sherpa-onnx.svg)](https://www.npmjs.com/package/react-native-sherpa-onnx)
[![Android](https://img.shields.io/badge/Android-Supported-green)](https://www.android.com/)
[![iOS](https://img.shields.io/badge/iOS-Supported-blue)](https://www.apple.com/ios/)

<a href="https://www.buymeacoffee.com/xdcobra" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" width="150" /></a>

</div>

> **⚠️ SDK 1.0.0 – Breaking changes from 0.4.0**  
> This project started as a side hobby project. After seeing the value it provides and that many people already use it, I decided to rebuild it with a more professional foundation. Because of that, I had to redesign the SDK structure and internal architecture from the ground up, which caused a large breaking change. The result is a more stable SDK with significantly better performance and speed, plus a cleaner, more consistent, and easier public API.

A React Native TurboModule that provides offline and streaming speech processing capabilities using [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). The SDK aims to support all functionalities that sherpa-onnx offers, including offline and **online (streaming)** speech-to-text, text-to-speech (batch and streaming), speaker diarization, speech enhancement, source separation, and VAD (Voice Activity Detection).

## Installation

```sh
npm install react-native-sherpa-onnx
```

## Feature Support

### Speech & media features

- ✅ Speech-to-Text (STT): [Offline](./docs/stt-offline.md) · [Streaming](./docs/stt-streaming.md)
- ✅ Text-to-Speech (TTS): [Offline](./docs/tts-offline.md) · [Streaming](./docs/tts-streaming.md)
- ✅ Android system TTS engine: [Register as device-wide engine](./docs/android-system-tts.md) *(Android only, Kotlin, opt-in)*
- ✅ Speech Enhancement: [Offline](./docs/enhancement-offline.md) · [Streaming](./docs/enhancement-streaming.md)
- ✅ Source separation: [Offline](./docs/separation-offline.md) · [Live overload](./docs/separation-streaming.md)
- ✅ Punctuation: [Offline](./docs/punctuation-offline.md) · [Streaming](./docs/punctuation-streaming.md)
- ✅ VAD: [Streaming](./docs/vad-streaming.md)
- ✅ Alignment / timestamps: [Offline](./docs/alignment-offline.md)
- ✅ Speaker identification: [Offline](./docs/speaker-identification-offline.md) · [Live overload](./docs/speaker-identification-live.md)
- ✅ Speaker diarization: [Offline](./docs/diarization-offline.md)

### Pipeline & buffers

- ✅ Audio buffers: [Offline](./docs/audiobuffer-offline.md) · [Live / streaming](./docs/audiobuffer-streaming.md)
- ✅ Text buffers: [Offline](./docs/textbuffer-offline.md) · [Live / streaming](./docs/textbuffer-streaming.md)
- ✅ Segment buffers: [Offline](./docs/segmentbuffer-offline.md) · [Live / streaming](./docs/segmentbuffer-streaming.md)
- ✅ Audio session and routing: [Pipeline Audio Session](./docs/audio-session.md)
- ✅ File and conversion I/O: [File I/O](./docs/fileio.md) · [Audio save / conversion](./docs/audio-conversion.md)

### Playback & utilities

- ✅ Playback: [PCM Player](./docs/pcm-player.md)
- ✅ Audio visualization: [Spectrum profiles (`levels` + timeline `frames`)](./docs/audio-visualization.md)
- ✅ Runtime acceleration: [Execution providers](./docs/execution-providers.md)
- ✅ Model configuration and detection: [Model setup](./docs/model-setup.md) · [Model detection & init](./docs/model-detect.md) · [Model languages](./docs/model-languages.md)
- ✅ Runtime model delivery: [Download manager](./docs/download-manager.md) · [Extraction API](./docs/extraction.md) · [PAD (Android) & ODR (iOS)](./docs/model-delivery-pad-odr.md) — install-time, fast-follow, on-demand

## How to start

Every feature needs **model files on disk** and a way to point the SDK at them. Read these guides **in order** before diving into STT, TTS, VAD, or any other feature doc:

| Step | Doc | You learn |
| --- | --- | --- |
| **1** | [Model setup](./docs/model-setup.md) | Where models live (bundled app assets, downloads, PAD/ODR), how **`FileSource`** works, expected folder layouts |
| **2** | [Model detection & init](./docs/model-detect.md) | Cheap preflight with `detect*Model`, **`auto` vs `custom`** init, required-file validation |
| **3** | [Feature pipelines](./docs/feature-pipelines.md) | End-to-end recipes and how features chain (buffers, segmentation, live overload) |
| **4** | Your **feature doc** | Quick start + API for the engine you need — see below |

**Optional, depending on your app:**

| Need | Read |
| --- | --- |
| Large models shipped outside the main APK/IPA | [PAD & ODR delivery](./docs/model-delivery-pad-odr.md) (after step 1) |
| Download models at runtime | [Download manager](./docs/download-manager.md) |
| Long audio or offline-only models on low-end devices (OOM risk) | [Segmentation engine](./docs/segmentation-engine.md) — process bounded chunks instead of one monolithic pass; essential on modest RAM when a full-file load would exhaust memory |
| RAM planning for large files or chained engines | [Memory and models](./docs/memory-and-models.md) |
| Other apps should use your TTS voices (Maps, accessibility, system settings) | [Android system TTS](./docs/android-system-tts.md) — Kotlin `TextToSpeechService`; deliver model via PAD/extract in RN |

Full doc index: [docs/README.md](./docs/README.md).


## Built for on-device memory

*Sherpa-onnx loads weights natively - this wrapper minimizes how much you need in RAM at once.*

**This SDK is built around that constraint.** Pipelines, buffers, and orchestration aim for a **low peak-RAM profile** so you can:

- run **one feature** (STT, TTS, enhancement, punctuation, …) performantly on phones that are not flagships, and  
- **chain features**—offline batch or live streaming—with **shared buffer contracts** and less duplicate loading than one-off native glue.

**How the wrapper helps (without changing sherpa-onnx physics):**

| Approach | What it buys you |
| --- | --- |
| **mmap & file-backed buffers** | Long offline audio stays on disk; native code reads slices instead of copying whole files into RAM. [Offline audio buffer](./docs/audiobuffer-offline.md) |
| **Live ring + optional spool** | Streaming sessions keep a bounded window in memory; optional spool persists growth without a single giant buffer. [Live audio buffer](./docs/audiobuffer-streaming.md) |
| **Pipeline & feature recipes** | Explicit stage lifetimes, live overloads, and composite flows (e.g. enhancement → STT → punctuation) with native workers on **bounded** units. [SDK pipeline logic](#sdk-pipeline-logic) · [Feature pipelines](./docs/feature-pipelines.md) |
| **Segmentation engine** | Offline-only models run segment-by-segment so peak RAM stays predictable; multi-hour files become practical on modest devices (small quality trade-off vs. one monolithic pass). [Segmentation engine](./docs/segmentation-engine.md) |

**Still plan like a mobile app:** many top-tier bundles are offline-first or offline-only; several engines at once multiply memory cost. See [Memory and models](./docs/memory-and-models.md). When limits are hit, native `OFFLINE_OOM` points to streaming alternatives (where they exist) and the segmentation docs.

**Default mindset:** use buffers, segmentation, and pipeline APIs for large or chained work—treat “load everything into memory, run once” as the exception.

## Installation

```sh
npm install react-native-sherpa-onnx
```

### Android

No additional setup required.

Optional: if you want Qualcomm acceleration, see QNN setup in [Execution provider support](./docs/execution-providers.md).

### iOS

```sh
cd your-app/ios
bundle install
bundle exec pod install
```

#### Model download (optional)

If you use the [download manager](docs/download-manager.md) to fetch models at runtime, install the peer dependency:

```sh
npm install @dr.pogodin/react-native-fs
```

Downloads run **in the foreground** while your app process is active. If the user leaves the app or the OS stops the process, the transfer pauses; partial files and `.download-state-*.json` on disk allow **resume with HTTP Range** when the user returns and starts the download again.

Setup, resume behavior, and optional `configureDownloadManager`: [Download manager – Setup (iOS & Android)](docs/download-manager.md#setup-ios--android).

## SDK pipeline logic

The SDK is built around TurboModule entry points and native pipeline buffers. In practice there are two execution styles:

- **Offline (batch):** complete inputs are processed to completion, then consumed downstream.
- **Streaming (live):** workers run continuously while producers and consumers exchange data through live buffers.

For named end-to-end recipes across features, see [Feature pipelines](./docs/feature-pipelines.md).

### Offline pipeline (batch)

Best when you already have complete input (file or full in-memory data) and want deterministic, one-shot output.

```mermaid
flowchart LR
  A[Large input file or OfflineAudioBuffer] --> B{Segment before run?}
  B -- Yes --> C[Segmentation engine\nchunk boundaries]
  C --> D[Offline engine per segment]
  B -- No --> E[Single offline engine run]
  D --> F[Merge or consume segment outputs]
  E --> F
  F --> G[Read slices or save file]
```

For offline-only model families and large inputs, segmenting first is often the safer default on phones: it bounds peak native RAM by running the same offline engine repeatedly on smaller chunks. That is how **hour-long** files and jobs on **less powerful** handsets stay within reach without loading the whole recording at once. See [Segmentation engine](./docs/segmentation-engine.md) and [Memory and models](./docs/memory-and-models.md#segmentation-engine-offline-only-models-and-oom-mitigation).

**Characteristics**
- Simple lifecycle (`create` -> `run` -> `read` -> `release`)
- Predictable completion semantics (`Promise<void>` when job is done)
- Good for file transcription, subtitle generation, and export jobs

### Streaming pipeline (live)

Best when data arrives over time (mic/live feed) or when low-latency chaining is needed.

```mermaid
flowchart LR
  A[Live source\nmic or append] --> B[LiveAudioBuffer]
  B --> C[Streaming engine\nSTT or enhancement]
  C --> D[LiveTextBuffer or LiveAudioBuffer]
  D --> E[Downstream consumer\nTTS player app logic]
  C --> F[Engine segmentation boundaries\nwhen enabled]
```

In streaming mode, multiple pipeline parts can run **at the same time**:
- upstream appends to live buffers
- current worker drains and processes
- downstream worker or consumer reads new units immediately

Where segmentation is enabled in streaming-capable APIs, boundary metadata is emitted by the engine and can be forwarded to downstream stages without duplicating large payloads. See [Segmentation engine](./docs/segmentation-engine.md).

**Advantages**
- Lower end-to-end latency (first results before full input is finished)
- Native-native chaining with less JS bridge traffic for steady-state data flow
- Better fit for real-time UX (partial STT, incremental TTS, live enhancement)

**Trade-offs**
- More lifecycle orchestration (`start/flush/reset/stop`, finalization order)
- Buffer/sample-rate compatibility must be managed carefully across stages
- Debugging timing/state issues can be more complex than batch mode

### Decision guide: offline vs streaming

Prefer **offline** when:
- input is already complete (audio file, full text)
- you need simple control flow and deterministic completion
- latency is less important than straightforward processing
- you can segment large offline jobs to keep native peak RAM bounded

Prefer **streaming** when:
- input arrives continuously (microphone/live feed)
- you need low time-to-first-result / low perceived latency
- you want concurrent stage execution (e.g. STT -> text buffer -> TTS -> audio buffer)
- the model family supports streaming and real-time output is required

## Supported Model Types

<details>
<summary>Speech-to-Text (STT) models</summary>

| Model Type               | `modelType` Value | Description                                                                              | Download Links                                                                                   |
| ------------------------ | ----------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Auto Detect**          | `'auto'`          | Automatically detects model layout/type from files in the model folder and picks the best supported STT type. | n/a |
| **Zipformer/Transducer** | `'transducer'`    | Encoder–decoder–joiner (e.g. icefall). Good balance of speed and accuracy. Folder name should contain **zipformer** or **transducer** for auto-detection. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/index.html) |
| **LSTM Transducer**      | `'transducer'`    | Same layout as Zipformer (encoder–decoder–joiner). LSTM-based streaming ASR; detected as transducer. Folder name may contain **lstm**. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/lstm-transducer-models.html) |
| **Paraformer**           | `'paraformer'`    | Single-model non-autoregressive ASR; fast and accurate. Detected by `model.onnx`; no folder token required. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-paraformer/index.html) |
| **NeMo CTC**             | `'nemo_ctc'`      | NeMo CTC; good for English and streaming. Folder name should contain **nemo** or **parakeet**. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-ctc/nemo/index.html)   |
| **Whisper**              | `'whisper'`       | Multilingual, encoder–decoder; strong zero-shot. Detected by encoder+decoder (no joiner); folder token optional. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/whisper/index.html)            |
| **WeNet CTC**            | `'wenet_ctc'`     | CTC from WeNet; compact. Folder name should contain **wenet**. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-ctc/wenet/index.html)  |
| **SenseVoice**           | `'sense_voice'`   | Multilingual with emotion/punctuation. Folder name should contain **sense** or **sensevoice**. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/sense-voice/index.html)        |
| **FunASR Nano**          | `'funasr_nano'`   | Lightweight LLM-based ASR. Folder name should contain **funasr** or **funasr-nano**. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/funasr-nano/index.html)        |
| **Qwen3 ASR**            | `'qwen3_asr'`     | Encoder–decoder ASR (Qwen3-ASR ONNX: conv frontend, encoder, decoder, tokenizer). Folder name should contain **qwen3**. Optional `modelOptions.qwen3Asr` (e.g. comma-separated hotwords). | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models) |
| **Cohere Transcribe**    | `'cohere_transcribe'` | Cohere Transcribe ONNX (encoder, decoder, `tokens.txt`). Folder name should contain **cohere**. Optional `modelOptions.cohereTranscribe` (language, punctuation, ITN). | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models) |
| **Moonshine (v1)**        | `'moonshine'`     | Four-part streaming-capable ASR (preprocess, encode, uncached/cached decode). Folder name should contain **moonshine**. | [Download](https://k2-fsa.github.io/sherpa/onnx/moonshine/index.html) |
| **Moonshine (v2)**        | `'moonshine_v2'`   | Two-part Moonshine (encoder + merged decoder); `.onnx` or `.ort`. Folder name should contain **moonshine** (v2 preferred if both layouts present). | [Download](https://k2-fsa.github.io/sherpa/onnx/moonshine/index.html) |
| **Fire Red ASR**         | `'fire_red_asr'`  | Fire Red encoder–decoder ASR. Folder name should contain **fire_red** or **fire-red**. | [Download](https://k2-fsa.github.io/sherpa/onnx/FireRedAsr/index.html) |
| **Dolphin**              | `'dolphin'`       | Single-model CTC. Folder name should contain **dolphin**. | [Download](https://k2-fsa.github.io/sherpa/onnx/Dolphin/index.html) |
| **Canary**               | `'canary'`        | NeMo Canary multilingual. Folder name should contain **canary**. | [Download](https://k2-fsa.github.io/sherpa/onnx/nemo/canary.html) |
| **Omnilingual**          | `'omnilingual'`   | Omnilingual CTC. Folder name should contain **omnilingual**. | [Download](https://k2-fsa.github.io/sherpa/onnx/omnilingual-asr/index.html) |
| **MedASR**               | `'medasr'`        | Medical ASR CTC. Folder name should contain **medasr**. | [Download](https://github.com/k2-fsa/sherpa-onnx) |
| **Telespeech CTC**       | `'telespeech_ctc'`| Telespeech CTC. Folder name should contain **telespeech**. | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/telespeech/index.html) |
| **Tone CTC (t-one)**     | `'tone_ctc'`      | Lightweight streaming CTC (e.g. t-one). Folder name should contain **t-one**, **t_one**, or **tone** (as word). | [Download](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-ctc/index.html) |

For **real-time (streaming) recognition** from a microphone or audio stream, use streaming-capable model types: `transducer`, `paraformer`, `zipformer2_ctc`, `nemo_ctc`, or `tone_ctc`. See [Streaming (Online) Speech-to-Text](./docs/stt-streaming.md).

</details>

<details>
<summary>Text-to-Speech (TTS) models</summary>

| Model Type       | `modelType` Value | Description                                                                                          | Download Links                                                                      |
| ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Auto Detect**   | `'auto'`              | Automatically detects the TTS model layout from files in the model folder and selects the matching supported type. | n/a |
| **VITS**         | `'vits'`          | Fast, high-quality TTS (Piper, Coqui, MeloTTS, MMS). Folder name should contain **vits** if used with other voice models. | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)          |
| **Matcha**       | `'matcha'`        | High-quality acoustic model + vocoder. Detected by acoustic_model + vocoder; no folder token required. | [Download](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/matcha.html) |
| **Kokoro**       | `'kokoro'`        | Multi-speaker, multi-language. Folder name should contain **kokoro** (not kitten) for auto-detection. | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)          |
| **KittenTTS**    | `'kitten'`        | Lightweight, multi-speaker. Folder name should contain **kitten** (not kokoro) for auto-detection. | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)          |
| **Zipvoice**     | `'zipvoice'`      | Standard TTS with **`sid`**. **Voice cloning** (reference audio + `referenceText`): batch via **`generateSpeech`** only—streaming TTS does not support reference audio for Zipvoice. Default **`numSteps`** when omitted is **5** on **Android and iOS** (matches sherpa-onnx `GenerationConfig` / Kotlin helper). Cloning is **supported on Android & iOS**. Encoder + decoder + vocoder. | [Download](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/zipvoice.html) |
| **Pocket**       | `'pocket'`        | Flow-matching TTS. **Voice cloning** on **Android:** batch and streaming TTS. **iOS:** cloning is experimental. Detected by lm_flow, lm_main, text_conditioner, vocab/token_scores. | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models) |
| **Supertonic**    | `'supertonic'`        | Lightning-fast, on-device text-to-speech system designed for extreme performance with minimal computational overhead. | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models) |

For **live TTS pipelines** (segment-driven synthesis from live text), use `createTTS().synthesize(LiveTextBuffer, LiveAudioBuffer, { segmentation })`. See [Offline Text-to-Speech](./docs/tts-offline.md) ("Live overload on offline TTS").

To expose on-device voices as a **device-wide Android TTS engine** (system settings, other apps), see [Android system TTS](./docs/android-system-tts.md). Kotlin integration, opt-in — not enabled by installing the SDK alone.

</details>

<details>
<summary>Punctuation models</summary>

Punctuation supports an offline CT-Transformer path and a streaming CNN-BiLSTM path.

| Model Type | `modelType` Value | Runtime path | Description | Download Links |
| --- | --- | --- | --- | --- |
| **Auto Detect** | `'auto'` | Detection only | Detects punctuation layout and resolves whether the model is offline CT-Transformer or streaming CNN-BiLSTM. | n/a |
| **CT-Transformer** | `'ct_transformer'` | Offline | Batch punctuation over offline text buffers. | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/punctuation-models) |
| **CNN-BiLSTM** | `'cnn_bilstm'` | Streaming | Online punctuation over live text buffers. | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/punctuation-models) |

APIs and initialization: [offline batch](./docs/punctuation-offline.md), [streaming (live text)](./docs/punctuation-streaming.md).

</details>

<details>
<summary>Speech Enhancement models</summary>

Speech enhancement improves noisy or degraded speech using ONNX models from the sherpa-onnx **speech-enhancement-models** release. Detection looks for **`.onnx`** filenames containing **`gtcrn`** or **`dpdfnet`** (case-insensitive). With **`'auto'`**, **GTCRN** is preferred when both are present in the same folder.

| Model Type   | `modelType` Value | Description                                                                 | Download Links                                                                 |
| ------------ | ----------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Auto Detect** | `'auto'`       | Picks **GTCRN** if a matching `.onnx` exists, otherwise **DPDFNet** if found. | n/a                                                                              |
| **GTCRN**    | `'gtcrn'`         | Lightweight speech enhancement (e.g. `gtcrn_simple.onnx`).                  | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speech-enhancement-models) |
| **DPDFNet**  | `'dpdfnet'`       | Deep speech enhancement variants (e.g. `dpdfnet2.onnx`, `dpdfnet4.onnx`, `dpdfnet8.onnx`, `dpdfnet_baseline.onnx`, `dpdfnet2_48khz_hr.onnx`). | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speech-enhancement-models) |

APIs and initialization: [offline batch](./docs/enhancement-offline.md), [streaming (live buffers)](./docs/enhancement-streaming.md).

</details>

<details>
<summary>Alignment models</summary>

Alignment uses timing modes with different model requirements:

| Mode | Needs model download? | Model requirements | Download |
| --- | --- | --- | --- |
| `proportional` | No | No alignment model; uses text and full audio duration | n/a |
| `estimated` | No | No alignment model; uses text + `segmentSampleCounts` timeline | n/a |
| `accurate` | Yes | wav2vec2 forced-alignment ONNX | [Download](https://github.com/XDcobra/react-native-sherpa-onnx/releases/tag/alignment-models) |
| `accurate_auto_asr` | Yes | wav2vec2 alignment model + speech anchors + ASR hypothesis timestamps | [Download](https://github.com/XDcobra/react-native-sherpa-onnx/releases/tag/alignment-models) |
| `accurate_auto_forced` | Yes | wav2vec2 alignment model + speech anchors (no ASR hypothesis dependency) | [Download](https://github.com/XDcobra/react-native-sherpa-onnx/releases/tag/alignment-models) |
| `vad` | No (alignment model) | VAD speech anchors from `seg_off_*` (requires a VAD model) | [VAD models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/vad-models) |

For mode behavior, setup, and constraints, see [Alignment (offline)](./docs/alignment-offline.md) and [Model setup](./docs/model-setup.md).

</details>

<details>
<summary>Voice Activity Detection (VAD) models</summary>

VAD detects speech boundaries on live or offline audio. Detection resolves **Silero** vs **Ten VAD** from the model pack layout.

| Model Type | `modelType` Value | Description | Download Links |
| --- | --- | --- | --- |
| **Auto Detect** | `'auto'` | Picks Silero or Ten VAD from files in the model folder. | n/a |
| **Silero VAD** | `'silero_vad'` | Widely used speech activity detector (`silero_vad.onnx`). | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/vad-models) |
| **Ten VAD** | `'ten_vad'` | Alternative VAD pack (`ten_vad.onnx`). | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/vad-models) |

APIs and initialization: [VAD (streaming)](./docs/vad-streaming.md).

</details>

<details>
<summary>Source Separation models</summary>

Source separation splits mixed audio into stems (e.g. vocals / accompaniment).

| Model Type | `modelType` Value | Description | Download Links |
| --- | --- | --- | --- |
| **Auto Detect** | `'auto'` | Detects Spleeter vs UVR layout from files in the model folder. | n/a |
| **Spleeter** | `'spleeter'` | Two-stem pack (`vocals` + `accompaniment` ONNX). | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/source-separation-models) |
| **UVR** | `'uvr'` | Single-model UVR-style separator. | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/source-separation-models) |

APIs and initialization: [offline batch](./docs/separation-offline.md), [live overload](./docs/separation-streaming.md).

</details>

<details>
<summary>Speaker Embedding / Identification models</summary>

Speaker identification uses **speaker-embedding** ONNX packs (WeSpeaker, 3D-Speaker, NeMo). Detect via `detectSpeakerEmbeddingModel`; public enroll/identify API is `createSpeakerIdentification`.

| Model Type | `modelType` Value | Description | Download Links |
| --- | --- | --- | --- |
| **Auto Detect** | `'auto'` | Detects embedding family from files in the model folder. | n/a |
| **WeSpeaker** | `'wespeaker'` | WeSpeaker embedding extractor. | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models) |
| **3D-Speaker** | `'3d-speaker'` | 3D-Speaker embedding extractor. | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models) |
| **NeMo** | `'nemo'` | NeMo speaker embedding extractor. | [Download](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models) |

APIs: [Speaker identification (offline)](./docs/speaker-identification-offline.md) · [Live overload](./docs/speaker-identification-live.md). Speaker **diarization** (anonymous clusters): [Offline](./docs/diarization-offline.md).

</details>

## Memory and models

Every active engine keeps its model weights resident in native memory for its entire lifetime. Plan ahead to avoid OOM crashes:

- ONNX weights are mapped into native (C++) heap — they count against your process limit, not the JS heap.
- Peak RAM during inference is typically **1.2–1.5× the model weight size** due to activation tensors.
- **Prefer int8/quantized models** — the SDK selects them automatically when `modelType: 'auto'` (default).
- Multiple concurrent engines (e.g. STT + TTS + enhancement) multiply the base memory cost.
- **Release engines and buffers promptly** — call `engine.release()` after each job or session.
- On devices with ≤ 2 GB RAM: avoid Whisper large, Kokoro, and alignment simultaneously.
- **Offline-only models:** many high-quality sherpa-onnx bundles have **no streaming** counterpart. Large offline jobs (long audio, big buffers) spike peak memory → **OOM** on phones. The SDK **segmentation engine** lets you run the **same offline model** on **smaller chunks** so peak RAM stays bounded; quality may **trade off slightly** versus one giant offline pass. Details: [Memory and models — Segmentation & OOM](./docs/memory-and-models.md#segmentation-engine-offline-only-models-and-oom-mitigation), [Segmentation engine](./docs/segmentation-engine.md).

→ Full planning guide: [docs/memory-and-models.md](./docs/memory-and-models.md)

## Audio visualization

The SDK exposes a public API for native spectrum profiles (`react-native-sherpa-onnx/visualization`) — static `levels` and optional timeline `frames` for previews and animation, without sending PCM through JS. You render the UI in your app; the [example app](./example/README.md#audio-visualization-showcase) shows Static, Heatmap, and pseudo-3D patterns.

<table>
<tr>
<td align="center"><img src="./docs/images/example/vis_static_cut.png" alt="Static spectrum bars" width="180" /></td>
<td align="center"><img src="./docs/images/example/vis_heatmap_cut.png" alt="Timeline heatmap" width="180" /></td>
<td align="center"><img src="./docs/images/example/vis_3d_cut.png" alt="Pseudo-3D spectrum (example UI)" width="180" /></td>
</tr>
<tr>
<td align="center"><sub>Static · <code>levels</code></sub></td>
<td align="center"><sub>Heatmap · <code>frames</code></sub></td>
<td align="center"><sub>3D demo · app Skia UI</sub></td>
</tr>
</table>

Full guide: [Audio visualization](./docs/audio-visualization.md).

## Documentation

Full index: [docs/README.md](./docs/README.md). New to models? See [How to start](#how-to-start).

### Getting started & planning

- [How to start](#how-to-start) – model setup → detection → feature pipelines → feature doc
- [Feature pipelines](./docs/feature-pipelines.md) – end-to-end recipes, chaining features
- [Memory and models](./docs/memory-and-models.md) – OOM awareness, model sizing, concurrent engines, buffer planning
- [Streaming pipelines overview](./docs/streaming-pipelines-overview.md) – shared live pipeline lifecycle (`stop` / `flush` / `completed`)
- [Native diagnostics](./docs/native-diagnostics.md) – crash ring buffer, `SherpaNativeDiag`

### Models & delivery

- [Model setup](./docs/model-setup.md) – `FileSource`, bundled/PAD/downloaded paths, discovery APIs
- [Model detection & init](./docs/model-detect.md) – preflight, `auto` vs `custom` init, validation
- [Model languages](./docs/model-languages.md) – language pickers and `modelOptions` hints
- [Ship model delivery (PAD & ODR)](./docs/model-delivery-pad-odr.md) – install-time, fast-follow, on-demand
- [Download manager](./docs/download-manager.md) – runtime model downloads
- [Extraction API](./docs/extraction.md) – `.tar.zst` / `.tar.bz2` ship archives
- [File I/O](./docs/fileio.md) – `copyFile`, `saveText`, `shareFile`
- [Hotwords](./docs/hotwords.md) – boosted phrases for supported STT models

> For `listAssetModels()` vs `listModelsAtPath()` and combining bundled with PAD/file-based models, see [Model setup](./docs/model-setup.md).

### Speech & media features

- **Speech-to-Text (STT):** [Offline](./docs/stt-offline.md) · [Streaming](./docs/stt-streaming.md)
- **Text-to-Speech (TTS):** [Offline](./docs/tts-offline.md) · [Streaming](./docs/tts-streaming.md) · [Android system engine](./docs/android-system-tts.md) *(Kotlin, opt-in)*
- **Speech Enhancement:** [Offline](./docs/enhancement-offline.md) · [Streaming](./docs/enhancement-streaming.md)
- **Source separation:** [Offline](./docs/separation-offline.md) · [Live overload](./docs/separation-streaming.md)
- **Punctuation:** [Offline](./docs/punctuation-offline.md) · [Streaming](./docs/punctuation-streaming.md)
- **VAD:** [Streaming](./docs/vad-streaming.md)
- **Alignment / timestamps:** [Offline](./docs/alignment-offline.md) – `createAlignment`, `proportional` / `estimated` / `accurate`
- **Speaker identification:** [Offline](./docs/speaker-identification-offline.md) · [Live overload](./docs/speaker-identification-live.md) – enroll / identify / verify / label; live `labelLiveSegments`
- **Speaker diarization:** [Offline](./docs/diarization-offline.md) · [Overview](./docs/diarization.md) – anonymous clusters; pyannote + embedding

### Segmentation

- [Segmentation engine](./docs/segmentation-engine.md) – policies, `SegmentLink`, live overload; **OOM mitigation** on low-end devices when offline models cannot load full audio at once

### Pipeline buffers

- **Audio:** [Offline](./docs/audiobuffer-offline.md) · [Live / streaming](./docs/audiobuffer-streaming.md)
- **Text:** [Offline](./docs/textbuffer-offline.md) · [Live / streaming](./docs/textbuffer-streaming.md)
- **Segment:** [Offline](./docs/segmentbuffer-offline.md) · [Live / streaming](./docs/segmentbuffer-streaming.md)

### Audio I/O & playback

- [Pipeline audio session](./docs/audio-session.md) – mic + PCM route policy
- [PCM player](./docs/pcm-player.md) – play pipeline buffer output
- [Audio conversion](./docs/audio-conversion.md) – save / encode, duration probe
- [Audio visualization](./docs/audio-visualization.md) – spectrum `levels` and timeline `frames`

### Platform & build

- [Execution providers](./docs/execution-providers.md) – CPU, NNAPI, XNNPACK, Core ML, QNN
- [Disable FFmpeg](./docs/disable-ffmpeg.md) · [Disable libarchive](./docs/disable-libarchive.md)
- [Known issues](./docs/KNOWN_ISSUES.md) – SDK-facing notes (e.g. Pocket TTS cross-platform drift)

## Requirements

- React Native >= 0.70
- Android API 24+ (Android 7.0+)
- iOS 13.0+

## Bundled sherpa-onnx version

| Platform | Version |
|----------|---------|
| Android | 1.13.7 |
| iOS | 1.13.7 |

## Known issues

- **[Pocket TTS (voice cloning)](docs/KNOWN_ISSUES.md#pocket-tts-voice-cloning-fragile-eos-and-cross-platform-drift)** — voice cloning: **Android** supported; **iOS** experimental. Heuristic EOS and **iOS vs Android drift** (length/quality); not a React Native–only issue.

## Example Apps

We provide example applications to help you get started with `react-native-sherpa-onnx`:

### Example App (Monorepo SDK Showcase)

The `example/` app in this monorepo is the SDK integration and feature showcase for `react-native-sherpa-onnx`. It is designed for validating end-to-end pipelines, model setup flows, runtime behavior, and platform-specific integration details.

It includes:

- Multiple model type support (Zipformer, Paraformer, NeMo CTC, Whisper, WeNet CTC, SenseVoice, FunASR Nano, Qwen3 ASR, Cohere Transcribe, Moonshine, and more)
- Model selection and configuration
- **Speech & media features**: STT (offline/streaming), TTS (offline/streaming), enhancement (offline/streaming), separation (offline/live overload), punctuation (offline/streaming), VAD, alignment/timestamps, speaker identification (offline + live overload), and speaker diarization (offline)
- **Pipeline showcase**: native buffer chaining and live/offline composition patterns used across SDK docs
- **Model lifecycle workflows**: download manager, extraction/model setup, model detection, and provider checks
- **Settings and diagnostics**: execution provider support and runtime environment checks
- Test audio files for different languages

For detailed screen-by-screen documentation, see [example/README.md](./example/README.md).

**Getting started:**

```sh
cd example
yarn install
yarn android  # or yarn ios
```

<div align="center">
<table>
<tr>
<td><img src="./docs/images/example/home_1.png" alt="Model selection home screen" width="240" /></td>
<td><img src="./docs/images/example/home_2.png" alt="Transcribe english audio" width="240" /></td>
<td><img src="./docs/images/example/home_3.png" alt="Transcribe cantonese audio" width="240" /></td>
</tr>
<tr>
<td><img src="./docs/images/example/stt_3.png" alt="Text to speech generation" width="240" /></td>
<td><img src="./docs/images/example/tts_3.png" alt="Text to speech generation" width="240" /></td>
<td><img src="./docs/images/example/segmentation_text_2.png" alt="Text to speech generation" width="240" /></td>
</tr>
</table>
</div>

### Community Example Apps

Built something with `react-native-sherpa-onnx`? We'd love to showcase it here.

Real-world apps help others see what the SDK can do beyond the monorepo integration demo — production UX, model delivery choices, and feature combinations we don't cover in `example/`. If you ship (or are building) a React Native app that uses this SDK, consider adding a short entry below.

**What to include:** app name, one-line description, link (App Store / Play Store / website / public repo if applicable), and which SDK features you use (e.g. offline STT, streaming TTS, PAD, separation).

**How to get listed:** open a pull request that adds your app to this section, or [open an issue](https://github.com/XDcobra/react-native-sherpa-onnx/issues/new) if you prefer maintainers to add it for you.

*No community entries yet — yours could be the first.*

## Contributing

- [Development workflow](CONTRIBUTING.md#development-workflow)
- [Sending a pull request](CONTRIBUTING.md#sending-a-pull-request)
- [Code of conduct](CODE_OF_CONDUCT.md)

## License

MIT

## Third-Party Libraries

This SDK includes the following open source components:

- [sherpa-onnx (Apache License 2.0)](/THIRD_PARTY_LICENSES/sherpa-onnx.txt): https://github.com/k2-fsa/sherpa-onnx

- [ONNX Runtime (MIT License)](/THIRD_PARTY_LICENSES/onnxruntime.txt): https://github.com/microsoft/onnxruntime

- [FFmpeg (LGPL v2.1)](/THIRD_PARTY_LICENSES/ffmpeg.txt): https://ffmpeg.org

- [Shine MP3 Encoder (LGPL)](/THIRD_PARTY_LICENSES/shine.txt): https://github.com/toots/shine

- [Opus Codec (BSD License)](/THIRD_PARTY_LICENSES/opus.txt): https://opus-codec.org

- [Zstandard (zstd) (BSD License)](/THIRD_PARTY_LICENSES/zstd.txt): https://github.com/facebook/zstd

- [libarchive (BSD License)](/THIRD_PARTY_LICENSES/libarchive.txt): https://github.com/libarchive/libarchive

Full license texts are available in the [THIRD_PARTY_LICENSES](/THIRD_PARTY_LICENSES/) directory.

### LGPL Notice

This SDK includes LGPL-licensed components such as FFmpeg and Shine.  
Applications using this SDK must ensure compliance with LGPL requirements when distributing binaries.

FFmpeg source code can be obtained at: https://ffmpeg.org

### Qualcomm QNN Support

This SDK supports optional integration with Qualcomm AI Runtime (QNN).

QNN is proprietary software provided by Qualcomm and is not included in this SDK.  
To use QNN acceleration, users must obtain and include the required QNN libraries separately and comply with Qualcomm's license terms:

https://softwarecenter.qualcomm.com/

### Responsibility

By using this SDK, you are responsible for complying with all third-party licenses included in this project.

---

Made with [create-react-native-library](https://github.com/callstack/react-native-builder-bob)

