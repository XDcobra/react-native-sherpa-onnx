# Memory and models

> For a short summary see the [Memory and models](#memory-and-models) section in the root README.

This guide helps you plan model selection, estimate peak RAM, and avoid OOM crashes before you ship.

---

## Contents

- [Why memory matters for on-device speech](#why-memory-matters-for-on-device-speech)
- [How much RAM does a model need?](#how-much-ram-does-a-model-need)
- [Offline vs streaming: memory profile differences](#offline-vs-streaming-memory-profile-differences)
- [Running multiple engines concurrently](#running-multiple-engines-concurrently)
- [Buffer memory](#buffer-memory)
- [Segmentation engine, offline-only models, and OOM mitigation](#segmentation-engine-offline-only-models-and-oom-mitigation)
- [Segment links metadata](#segment-links-metadata)
- [Platform limits and OOM signals](#platform-limits-and-oom-signals)
- [Practical checklist](#practical-checklist)

---

## Why memory matters for on-device speech

ONNX models are loaded fully into native (C++) memory and held resident for the lifetime of the engine handle. Unlike a web API call, **every active engine costs RAM all the time**—not only during inference. On constrained mobile hardware (2–4 GB total, often 1–1.5 GB available to an RN app), a single large model can represent 20–50 % of your budget.

Key consequences:

- Loading a second or third engine (e.g. STT + TTS + enhancement) multiplies the base cost.
- Streaming engines are resident for longer than offline engines (they are long-lived handles vs. one-shot jobs).
- Large model families (Whisper large, Kokoro) cost more than compact alternatives (Zipformer small, VITS).

---

## How much RAM does a model need?

There is no single answer—it depends on the model family, quantization, and how the native runtime maps weights. Use the table below as **rough** planning figures based on typical sherpa-onnx ONNX model sizes:

| Feature | Small / quantized (int8) | Medium | Large |
|---------|--------------------------|--------|-------|
| STT – Zipformer transducer | ~60–120 MB | ~150–250 MB | — |
| STT – Paraformer | ~100 MB | ~200 MB | — |
| STT – Whisper | ~200 MB (tiny) | ~400 MB (base) | ~1.5 GB (large) |
| STT – SenseVoice | ~130 MB | — | — |
| TTS – VITS | ~40–80 MB | ~120 MB | — |
| TTS – Matcha | ~80–160 MB | — | — |
| TTS – Kokoro | ~300 MB | — | — |
| TTS – Zipvoice | ~200 MB | — | — |
| VAD (Silero) | ~5 MB | — | — |
| Speech enhancement (GTCRN) | ~5 MB | — | — |
| Alignment (wav2vec2) | ~350 MB | — | — |
| Punctuation | ~50–100 MB | — | — |

> **Important:** these are weight-file sizes. Peak RSS during inference may be 1.2–1.5× higher due to activation tensors, especially for encoder-decoder models (Whisper, Matcha, Kokoro). Int8/quantized models reduce weight size by ~50–70 % and the SDK prefers them when `preferInt8: true` (the default for `auto`).

**Recommendation:** prefer quantized (int8) models. Enable this globally via `modelType: 'auto'` with the default `preferInt8` flag, or set `preferInt8: true` explicitly in `STTInitializeOptions` / `TTSInitializeOptions`.

---

## Offline vs streaming: memory profile differences

| Aspect | Offline (batch) | Streaming (live) |
|--------|----------------|-----------------|
| Engine lifetime | Short — created, used, released | Long — held open for session |
| Audio buffer in RAM | One full buffer before processing | Chunked; only current window |
| Text buffer in RAM | Entire output until released | Appended segments; ring-evictable |
| Peak RAM | Spike during inference, zero after release | Constant base cost while active |
| Multiple concurrent | Rare (sequential jobs typical) | Common (STT → TTS pipeline) |

**Offline engines** should be released promptly with `engine.release()` after the job completes. Keep the handle in React state only as long as the UI needs the engine; release in a `useEffect` cleanup.

**Streaming engines** are designed to stay open (e.g., for a microphone session). Budget their RAM as a fixed cost for the feature lifetime.

---

## Running multiple engines concurrently

Each active engine holds its model weights in native memory independently. Running STT + TTS + enhancement simultaneously:

```
~120 MB  (Zipformer STT, int8)
+ ~80 MB  (VITS TTS, int8)
+  ~5 MB  (GTCRN enhancement)
= ~205 MB base model cost (+ inference activation overhead)
```

**Guidelines:**
- Do not load more engines than your UX needs simultaneously. Lazy-load and release eagerly.
- If pipeline stages are sequential (e.g., transcribe file → generate speech), release the first engine before creating the second whenever latency allows.
- Use `detectSttModel()` / `detectTtsModel()` (or unified [`detectModel`](model-detect.md) for category-unknown folders) before `createSTT()` / `createTTS()` — detection is stateless and does not load model weights. See [model-detect.md](model-detect.md).
- On low-memory devices (< 3 GB) avoid Whisper base/large, Kokoro, and Zipvoice simultaneously with other engines.

---

## Buffer memory

Buffers accumulate audio or text data in native memory.

| Buffer type | Memory grows when | Release trigger |
|------------|-------------------|-----------------|
| `OfflineAudioBuffer` | PCM samples are appended | `releaseOfflineAudioBuffer()` |
| `OfflineTextBuffer` | Text segments are written | `releasePipelineTextBuffer()` |
| `LiveAudioBuffer` (streaming) | Upstream writes faster than downstream reads | Bounded by ring capacity |
| `LiveTextBuffer` (streaming) | Upstream writes faster than downstream reads | Bounded by ring capacity |
| `OfflineSegmentBuffer` | Segments are linked | `releaseOfflineSegmentBuffer()` |
| `LiveSegmentBuffer` (streaming) | Segments are linked | Evicted per ring policy |

For large audio files (> 10 minutes, > 50 MB PCM), use `createOfflineAudioBufferFromFile()` with a `FileSource` instead of appending chunks — the native layer can avoid a full in-memory copy when the source is a file path.

See also: [audiobuffer-offline.md](./audiobuffer-offline.md), [audiobuffer-streaming.md](./audiobuffer-streaming.md), [textbuffer-offline.md](./textbuffer-offline.md), [textbuffer-streaming.md](./textbuffer-streaming.md).

---

## Segmentation engine, offline-only models, and OOM mitigation

Many sherpa-onnx model bundles are **offline-only**: there is often **no streaming** variant with comparable quality, so apps naturally gravitate toward **offline engines** (`createSTT`, `createTTS`, batch enhancement, etc.). Offline inference usually works on **larger windows** of audio or text at once. Holding long recordings or big buffers in memory while the engine runs can push **peak RSS** high—especially on **low-memory devices**—and leads to **OOM** crashes that streaming-only mitigation cannot solve (because the model simply does not support online inference).

The SDK **segmentation engine** is introduced partly to **counter that OOM pressure**. Instead of one monolithic offline pass over an entire file or session, you **split** the workload into **smaller segments** (time- or policy-driven chunks) and run the **same offline model** on each chunk sequentially or as orchestrated by the pipeline. Peak memory then tracks **segment size** and active buffers much more than **total duration**, which makes **offline models practical on constrained hardware**.

**Tradeoff:** segment boundaries can **slightly reduce quality** versus a single full-buffer offline run (less global context, effects at cuts). For many products this is preferable to **crashes** or **refusing** long inputs.

Full API and modes: [segmentation-engine.md](./segmentation-engine.md). Feature-specific integration (STT, TTS, enhancement, punctuation, separation, …) is documented in each feature’s **`## Segmentation`** section.

---

## Segment links metadata

`SegmentLink` and `SegmentLinkMap` are lightweight metadata structures (a few kilobytes even for long sessions). They do not duplicate audio or text payload bytes. For pure RAM accounting, link overhead is negligible compared with models and PCM/text buffers.

---

## Platform limits and OOM signals

### iOS

- The OS sends memory-pressure notifications; the app is killed if it exceeds a per-device threshold (no fixed number, varies from ~1 GB on older devices to > 2 GB on newer ones).
- Catchable C++ allocation failures (`std::bad_alloc`) on some offline paths (e.g. STT, alignment, separation) reject with **`OFFLINE_OOM`**. OS process kills and hard native aborts still terminate without a JS error — watch for silent crashes in logs.
- Recommendation: test on the lowest-tier device you intend to support.

### Android

- The JVM + native heap share a per-process limit. Large models loaded via JNI count against native heap.
- JVM `OutOfMemoryError` and catchable native `std::bad_alloc` on some offline paths (e.g. STT, alignment, separation) surface as **`OFFLINE_OOM`**. That does not cover the OS low-memory killer or hard aborts inside ONNX Runtime / sherpa-onnx.
- Use `adb shell dumpsys meminfo <package>` during testing to monitor native heap usage.
- Devices with ≤ 2 GB RAM should use only small/int8 models and a single engine at a time.

### General signals

| Signal | Likely cause |
|--------|-------------|
| Silent app crash on model load / long offline job | Model or activation tensors too large for available native heap (OS kill; not always `OFFLINE_OOM`) |
| Promise reject `OFFLINE_OOM` | Catchable JVM/native allocation failure on a guarded offline path |
| `Error: cannot allocate buffer` from native | Audio buffer size exceeds OS limit |
| JS bridge timeout during inference | Long ONNX inference blocking native thread (consider streaming) |
| Partial results missing | LiveBuffer eviction racing with consumer |

---

## Practical checklist

Before releasing your app with on-device speech:

- [ ] **Measure on device** — use Xcode Instruments (iOS) or Android Studio Memory Profiler with your actual model set.
- [ ] **Test the smallest device** you intend to ship on; OOM only shows up under real constraints.
- [ ] **Release engines promptly** — call `engine.release()` as soon as a session or job is done.
- [ ] **Release buffers promptly** — call the corresponding `release*` function after reading results.
- [ ] **Prefer int8 quantized models** — always set `preferInt8: true` or use `modelType: 'auto'` (default).
- [ ] **Avoid simultaneous large models** — Whisper large + Kokoro + alignment on an older device will OOM.
- [ ] **Use file-based input** for large audio files — avoids double-buffering PCM in RAM.
- [ ] **Stream when possible** for long sessions — streaming audio/text buffers are ring-bounded; offline buffers are unbounded.
- [ ] **If you must use offline-only models on low RAM**, plan **segmentation** (smaller chunks + offline engine per chunk) — see [Segmentation engine, offline-only models, and OOM mitigation](#segmentation-engine-offline-only-models-and-oom-mitigation) and [segmentation-engine.md](./segmentation-engine.md).

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.

