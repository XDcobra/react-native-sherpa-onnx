# Streaming pipelines — shared lifecycle

This page describes what is **common** to native **streaming pipeline** workers (STT, enhancement, separation live overload, VAD, TTS live overload, punctuation, …). Feature-specific buffer rules and ordering (e.g. when to finalize which buffer) stay on each feature’s streaming doc.

## Mental model

1. You create an **engine** (or reuse one) and allocate **pipeline buffers** (live audio, live text, …) as described in [audiobuffer-streaming.md](audiobuffer-streaming.md), [textbuffer-streaming.md](textbuffer-streaming.md), [segmentbuffer-streaming.md](segmentbuffer-streaming.md).
2. You call **`engine.<startMethod>(…)`** (e.g. `transcribe`, `enhance`, `process`, `punctuate`, `synthesize`). Native registers a **worker** in the streaming pipeline registry and returns a **pipeline handle** (`*PipelineHandle`).
3. Producers **append** to live buffers (mic, file ingest, another worker). The worker **drains** inputs and **writes** outputs — steady-state data stays in **native** memory; JS mostly drives lifecycle and reads slices/events.
4. You end the session with a small **control sequence** (see table below), then **`destroy()`** the engine (where applicable) and **`releasePipeline*Buffer`** on buffers.

## Pipeline handle — control surface

Note: offline alignment progress is exposed on `alignTextToAudio(..., { onProgress })` as `OrchestrationProgress`; alignment has no streaming pipeline handle progress contract.

Handles are typed per feature (`SttPipelineHandle`, `EnhancementPipelineHandle`, …) but share the same **verbs** (see `StreamingPipelineHandle` in `react-native-sherpa-onnx/audiobuffer`). They are thin JS facades over native `pipelineId` control (`stopStreamingPipeline`, `flushStreamingPipeline`, …).

| Method / field | Role | Typical interplay |
| --- | --- | --- |
| **`completed`** | `Promise` that settles when the native worker is **done** (normal completion, `stop()`, or error). | Subscribe or `await` after you have issued **`flush()`** / **`stop()`** as required by the feature. Emits `streamingPipelineCompleted` on the native side. |
| **`stop()`** | **Hard cancel**: tear down the worker, unblock waits. | Use for user cancel or when you will release buffers immediately. After stop, the handle is **terminal** — further control calls may fail with “pipeline not found”. |
| **`flush()`** | **Soft barrier**: “drain remaining work now” — exact semantics **differ by feature** (tail audio, tail text segments, segmentation `flushFinal`, …). | Call when inputs are **logically complete** (e.g. mic stopped, live text **finalized**) so the worker can emit **final** partials/segments/chunks. **Not** a substitute for buffer `finalize*` if the feature still expects more commits. |
| **`reset()`** | Clear **internal stream state** of the model/worker where supported; may **not** stop the pipeline. | Use for “new utterance / same session” patterns when the feature documents it. |
| **`getStatus()`** | Snapshot: `isRunning`, chunk counts, `unitsRead` / `unitsWritten`, `error`. | Polling, debug UI, tests. |

**`completed` typing:** Pipeline handles expose **`Promise<StreamingPipelineCompletion>`** (see `StreamingPipelineHandle` in `react-native-sherpa-onnx/audiobuffer`).

**Ordering (rule of thumb):** finish feeding **buffers** (stop mic, **`finalizeLive*Buffer`** on inputs that define end-of-stream — for live audio, `finalizeLiveAudioBuffer` returns **`LiveAudioBufferFinishedRef`** with fresh `info`), then call **`pipeline.flush()`** so workers can process **tails**, then **`pipeline.stop()`** if you still need an explicit cancel, then **`await pipeline.completed`** when you care about the completion payload. **VAD** and **streaming enhancement** document **exceptions** (e.g. finalize already triggers terminal drain — do not double-flush blindly).

**Punctuation streaming** documents a **stricter** post-finalize `flush()` barrier on the punctuation worker; read [punctuation-streaming.md](punctuation-streaming.md).

## Where to read next

| Topic | Doc |
| --- | --- |
| STT streaming + `SttPipelineHandle` | [stt-streaming.md](stt-streaming.md) |
| TTS live overload + `TtsPipelineHandle` | [tts-offline.md#live-overload-on-offline-tts-offline-weights-live-consumption](tts-offline.md#live-overload-on-offline-tts-offline-weights-live-consumption) and [tts-streaming.md](tts-streaming.md) |
| Enhancement streaming + `EnhancementPipelineHandle` | [enhancement-streaming.md](enhancement-streaming.md) |
| Separation live overload + `SeparationPipelineHandle` | [separation-streaming.md](separation-streaming.md) · [separation-offline.md#live-overload-on-offline-separation-offline-weights-live-consumption](separation-offline.md#live-overload-on-offline-separation-offline-weights-live-consumption) |
| VAD streaming + `VADPipelineHandle` | [vad-streaming.md](vad-streaming.md) |
| Punctuation streaming + `PunctuationPipelineHandle` | [punctuation-streaming.md](punctuation-streaming.md) |
| Live audio as pipeline operand | [audiobuffer-streaming.md](audiobuffer-streaming.md) |
| Live text as pipeline operand | [textbuffer-streaming.md](textbuffer-streaming.md) |
| Live segments as pipeline operand | [segmentbuffer-streaming.md](segmentbuffer-streaming.md) |

Internal design notes (overload, registry): [internal/live-overload.md](internal/live-overload.md).

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.

