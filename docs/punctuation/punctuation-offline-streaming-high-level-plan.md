# Punctuation API High-Level Plan (Offline + Streaming)

## Purpose

Define a standalone punctuation feature with two public engines:

- offline punctuation (`createOfflinePunctuation`)
- streaming punctuation (`createStreamingPunctuation`)

The plan is text-domain first and buffer-first, aligned with existing SDK pipeline patterns.

---

## Scope

In scope:

- new public standalone punctuation API
- offline and streaming variants
- native bridge support for iOS and Android
- text-buffer based pipeline contracts
- docs + example integration + verification matrix

Out of scope:

- segmentation engine implementation itself
- speech-time segmentation (VAD/energy)
- alignment fake streaming implementation details

---

## Domain Model

Punctuation is a text feature, not an audio feature.

- no `AudioBuffer` input/output
- no audio streaming worker
- no `LiveAudioBuffer` usage

Punctuation streaming uses a text pipeline model:

- input text stream via `LiveTextBuffer`
- output text stream via `LiveTextBuffer`
- native worker drains text chunks and appends punctuated chunks

---

## Sherpa-ONNX Capability Mapping

Use sherpa-onnx punctuation backends as follows:

- offline engine -> `OfflinePunctuation` (`ct_transformer`)
- streaming engine -> `OnlinePunctuation` (`cnn_bilstm` + `bpe_vocab`)

Important: streaming punctuation is incremental text processing, not audio waveform streaming.

---

## Public API Contract (Proposed)

## 1) Offline

- `createOfflinePunctuation(options): Promise<OfflinePunctuationEngine>`
- `OfflinePunctuationEngine.punctuate(textIn, textOut): Promise<OfflinePunctuateResult>`
- `OfflinePunctuationEngine.destroy(): Promise<void>`

`textIn` and `textOut` are offline text buffers.

**`OfflinePunctuateResult` (v1):** the only field is `processingTimeMs: number` — wall-clock (or high-resolution) duration in milliseconds of the **native** punctuation work for that call, excluding buffer allocation by the caller. The punctuated string lives only in `textOut`. Additional result fields are reserved for future use.

**Convenience helper (optional; same buffer ownership as `punctuate`):**

- `OfflinePunctuationEngine.punctuateString(plain: string, textOut: OfflineTextBufferRef): Promise<OfflinePunctuateResult>`
- The **output** buffer is **always passed in** by the caller. The user **creates** and **owns** it (e.g. via `createEmptyOfflineTextBuffer()`) and **reuses** it across calls or **destroys** it when done. The engine only **populates** `textOut` with the punctuated result. **It does not** create, cache, or manage an `OfflineTextBuffer` internally for this call.

## 2) Streaming

- `createStreamingPunctuation(options): Promise<StreamingPunctuationEngine>`
- `StreamingPunctuationEngine.punctuate(textIn, textOut): Promise<PunctuationPipelineHandle>`
- `StreamingPunctuationEngine.destroy(): Promise<void>`

`textIn` and `textOut` are live text buffers.

`PunctuationPipelineHandle` supports:

- `flush()`
- `stop()`
- `reset()`
- `getStatus()`

---

## Buffer Contracts

## Offline Contract

- input: caller-owned populated `OfflineTextBuffer`
- output: caller-owned empty `OfflineTextBuffer`
- write mode: one-shot/full text write

## Streaming Contract

- input: caller-owned `LiveTextBuffer` (producer appends raw/unpunctuated text chunks)
- output: caller-owned `LiveTextBuffer` (worker appends punctuated chunks)
- worker: drain/append loop until stop/finalize

## Native bridge: iOS (`TxtOfflineEntry`, decided)

- The punctuation bridge implementation **includes** [`ios/textbuffer/core/SherpaOnnx+TextBufferGlobals.h`](../../ios/textbuffer/core/SherpaOnnx+TextBufferGlobals.h) and uses the **shared** `g_txt_offline` map via the header’s `extern` (same as STT, alignment, TTS batch).
- **Reuse** the existing C++ helpers exposed there, e.g. `txt_read_offline_text` / `txt_populate_offline_if_empty` (or add a narrow `txt_*` if needed), instead of inlining a second copy of the registry logic.
- **Do not** re-declare or duplicate `g_txt_offline` in the punctuation `.mm` file.

---

## Runtime Behavior

## Offline Runtime

1. validate config + buffer ids
2. read full input text from `textIn`
3. run offline punctuation model
4. write punctuated text to `textOut`
5. return `{ processingTimeMs }` as `OfflinePunctuateResult` (punctuated text is only in `textOut`, not in the result object)

## Streaming Runtime

1. create pipeline cursor on input `LiveTextBuffer`
2. drain input chunks
3. run online punctuation per chunk
4. append punctuated chunk to output `LiveTextBuffer`
5. support `flush/stop/reset/status`
6. finalize behavior:
   - if input finalized -> auto-flush and stop

---

## Validation and Guardrails

- offline engine accepts only offline punctuation model config
- streaming engine accepts only online punctuation model config
- reject mixed model type with deterministic argument error
- reject invalid/malformed text buffer ids early
- reject incompatible buffer kinds (offline vs live) early

---

## Error Model (Proposed)

- `PUNCTUATION_ERROR` (generic fallback)
- `PUNCTUATION_INVALID_ARGUMENT` (invalid options, malformed ids, wrong model kind)
- `PUNCTUATION_INVALID_STATE` (engine destroyed, handle already stopped, etc.)
- `PUNCTUATION_MODEL_INIT_ERROR` (native model creation fails)
- `PUNCTUATION_PIPELINE_ERROR` (stream worker run failure)

Native errors should map to stable JS codes with consistent `message/details`.

---

## Observability

For result/status objects include:

- processed unit counts
- chunk counts (streaming)
- dropped/retried chunk counters (if applicable)
- finalization reason (`stopped`, `input_finalized`, `error`)
- optional warning code for recoverable chunk anomalies

---

## Integration with Segmentation Engine (Future)

This standalone API is the reusable text punctuation primitive.

Future segmentation engine usage:

- text mode 2 (punctuation-assisted segmentation) calls punctuation core/provider
- punctuation output feeds sentence/word/max-length segmentation rules
- segmentation boundaries are written to `SegmentBuffer` by segmentation layer, not punctuation API itself

---

## Implementation Phases

1. **Phase A: Type contracts + API surface**
   - add `src/punctuation/*` public types and facades
   - add native module interface for offline + streaming punctuation

2. **Phase B: Native offline implementation**
   - Android/iOS bridge to sherpa offline punctuation
   - offline text buffer read/write integration

3. **Phase C: Native streaming implementation**
   - text streaming worker with live text drain/append
   - pipeline handle lifecycle (`flush/stop/reset/status`)

4. **Phase D: Validation + errors + diagnostics**
   - deterministic cross-platform error mapping
   - guardrail parity tests

5. **Phase E: Docs + example screen**
   - offline quick-start
   - streaming quick-start with `LiveTextBuffer` pipeline
   - behavior matrix (offline vs streaming)

6. **Phase F: Verification gate**
   - TS typecheck + lint
   - Android/iOS behavior parity checks
   - manual matrix for model/config/buffer mismatches

---

## Test Matrix (Minimum)

- offline valid path writes punctuated full output
- streaming valid path emits punctuated chunk sequence
- wrong model kind per engine rejected
- wrong buffer kind per engine rejected
- stop/flush/reset/status semantics stable
- input-finalized auto-stop behavior stable
- destroyed-engine safety behavior stable
- Android/iOS parity for error codes + status fields

---

## Open Decisions

- chunk merge policy in streaming mode (carry-over window, boundary rewrite depth)
- whether streaming output emits only finalized text or allows revisions

**Decided (convenience + buffers):** If a string helper is exposed, the shape is `punctuateString(plain, textOut: OfflineTextBufferRef)` (see **Offline** section above) — not `punctuateString(plain) → buffer`. The caller must supply a buffer; no automatic output-buffer allocation in the engine.

**Decided (offline result type):** `punctuate` and `punctuateString` resolve to `OfflinePunctuateResult` with only `processingTimeMs: number` for v1. Not `void`.

