# ASR-mediated accurate alignment — codebase findings & target TypeScript example

## 1. Codebase verification (today)

### Reference transcript **R** (forced-alignment script)

- Use an **`OfflineTextBuffer`** populated with the **reference** text (not ASR output), e.g. `createOfflineTextBufferFromText()` from `react-native-sherpa-onnx/textbuffer`.
- This buffer is what callers pass as **`textIn`** to `alignTextToAudio()` today.

### ASR hypothesis **H** with timings (after `transcribe`)

- **`SttEngine.transcribe(audioIn, textOut)`** writes recognition results into a **caller-provided `OfflineTextBuffer`** (`textOut`). See `src/stt/index.ts` (`transcribe` → `SherpaOnnx.transcribe`).
- The same offline text buffer can expose **token-level** data for alignment / linker use:
  - `getPipelineTextBufferInfo(bufferId)` → `tokenCount`, `timestampCount`, `durationCount` (see `src/NativeSherpaOnnx.ts`).
  - `getOfflineTextBufferTokensSlice(bufferId, start, maxCount)` → `string[]`
  - `getOfflineTextBufferTimestampsSlice(bufferId, start, maxCount)` → `number[]` (times in **seconds** per sherpa-onnx convention — confirm in implementation spec)
  - `getOfflineTextBufferDurationsSlice` for optional duration per token

So the **concrete “ASR output”** for the linker is **not a separate new buffer type**: it is the **hypothesis `OfflineTextBuffer`** filled by STT, plus the **discrete token/timestamp slices** (native-backed, large arrays not copied until read).

**Not all STT models fill `timestamps`:** sherpa-onnx `OfflineRecognizerResult` passes through whatever the loaded model provides; `timestampCount` may be **zero**. That is model- and config-dependent (e.g. Whisper `enableTokenTimestamps` in `SttWhisperModelOptions`).

### ASR-mediated: mandatory token timestamps & deterministic errors

Strategy **`mappingStrategy: 'asr_mediated'`** is **only defined** when the hypothesis buffer **H** carries a usable **time axis** for the linker (typically **`timestampCount > 0`** and timestamps aligned with tokens for DTW/reference alignment). Without that, R↔H↔audio mapping is undefined.

**Contract (target implementation):**

- After `transcribe` (or equivalent), if **`getPipelineTextBufferInfo(hypothesisBufferId).timestampCount === 0`** (or timestamps unusable for pairing with hypothesis tokens), the SDK **must fail** with an explicit error — **no silent fallback** to proportional mapping, `chunkedForcedCtc`, or another heuristic.

**Suggested error identifier (implement verbatim across JS/native):**

- **`ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS`**  
  Message should state that **ASR-mediated accurate alignment** requires an STT model/configuration that emits **token-level timestamps** into the hypothesis `OfflineTextBuffer`, and point callers to **`mappingStrategy: 'chunked_forced_ctc'`**, **`accurate` without segmentation**, or other modes otherwise.

Callers retain full choice of **other** alignment strategies; only this mode is gated on timestamp-capable ASR output.

### Speech **anchors** (VAD / SegmentationEngine)

- `segmentOfflineBuffer(offlineAudioBuffer, policy)` with `policy.evaluator: 'speech_vad_model'` (and `policy.modelPath` as **`FileSource`**, plus thresholds as needed) returns a **`SegmentBufferRef`** whose `segmentBufferId` is a `seg_off_*` buffer with **`speech`** segments and sample ranges. See `src/segment/index.ts` (`segmentOfflineBuffer`). JS runs **`detectVadModel`** on `modelPath` (same pipeline as **`createStreamingVAD`**) before the native bridge.

### Alignment entry point (target public SDK)

- **`createAlignment(options?)` → `AlignmentEngine`** with **`engine.alignTextToAudio(textIn, audioIn, segmentOut, options)`** and **`engine.destroy()`** — see [alignment-public-modes-plan.md](alignment-public-modes-plan.md#public-api-alignmentengine). The freestanding **`alignTextToAudio` export is removed** (cold cut).
- **Target state** adds `mappingStrategy: 'asr_mediated'` and a structured `segmentation` block (names below are **illustrative** until types land in `src/alignment/types.ts`).

---

## 2. Target TypeScript example (after implementation)

### Public contract: caller-provided hypothesis buffer only

**ASR-mediated** alignment accepts **only** a **pre-filled hypothesis `OfflineTextBuffer`** (`hypothesisTextBuffer`): the **caller** runs **`SttEngine.transcribe(audioIn, textOut, …)`** (or an equivalent path that populates the same buffer metadata) **before** **`engine.alignTextToAudio`**.

**Rationale:** the caller keeps full control over **which STT instance**, **`modelOptions`** (e.g. Whisper `enableTokenTimestamps`), **`SttTranscribeOptions`** (`segmentation`, recovery, progress), and **when** transcription runs. **`AlignmentEngine#alignTextToAudio` does not invoke STT internally** for this strategy.

The example below shows the **intended public shape**: **`accurate` + ASR-mediated** consumes **R**, **H**, and anchors; the **linker** runs inside alignment on those inputs. Field names are **proposed**; adjust to the final `AlignTextToAudioOptions` discriminated union.

**Prerequisites:** STT and alignment CTC models on disk; VAD bundle locatable from a **`FileSource`** for `speech_vad_model` (same **`detectVadModel`** rules as streaming VAD).

```typescript
import { createAlignment } from 'react-native-sherpa-onnx/alignment';
import { createSTT } from 'react-native-sherpa-onnx/stt';
import { segmentOfflineBuffer } from 'react-native-sherpa-onnx/segment';
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyOfflineTextBuffer,
  createOfflineTextBufferFromText,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import {
  createEmptyOfflineSegmentBuffer,
  releasePipelineSegmentBuffer,
} from 'react-native-sherpa-onnx/segmentbuffer';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';

// --- App constants: alignment + STT use FileSource; speech_vad segmentation uses FileSource ---

const ALIGNMENT_MODEL: FileSource = {
  kind: 'fs',
  path: '/var/mobile/.../wav2vec2-alignment-dir-or-onnx',
};
const STT_MODEL: FileSource = {
  kind: 'fs',
  path: '/var/mobile/.../sherpa-stt',
};
const VAD_MODEL: FileSource = {
  kind: 'fs',
  path: '/var/mobile/.../silero-vad', // model dir or .onnx — detectVadModel finds the bundle
};

async function runAccurateAsrMediatedExample() {
  const alignment = await createAlignment({
    // optional defaults, e.g. modelPath — or omit and pass per call
  });

  // Reference script R (ground truth) — NOT the ASR output
  const referenceTextBuf = await createOfflineTextBufferFromText(
    'The full reference transcript. Same language as the audio. ...'
  );

  const audioBuf = await createOfflineAudioBufferFromFile({
    kind: 'fs',
    path: '/path/to/long-recording.wav',
  });

  // Output: alignment segments written here
  const segmentOut = await createEmptyOfflineSegmentBuffer({
    sourceAudioBufferId: audioBuf,
  });

  // 1) Speech anchors: SegmentationEngine offline pass (reusable across features)
  const anchorRef = await segmentOfflineBuffer(audioBuf, {
    evaluator: 'speech_vad_model',
    modelSource: VAD_MODEL,
    vadMinSpeechMs: 200,
    vadMinSilenceMs: 500,
  });
  // anchorRef.segmentBufferId → seg_off_* with kind "speech" segments

  // 2) Hypothesis H: caller runs transcribe — model options, timestamps, segmented STT, etc. stay under caller control
  const stt = await createSTT({
    modelSource: STT_MODEL,
    modelType: 'auto',
    // e.g. modelOptions: { whisper: { enableTokenTimestamps: true, ... } } when required for timestampCount > 0
  });
  const asrHypothesisOut = await createEmptyOfflineTextBuffer();
  await stt.transcribe(audioBuf, asrHypothesisOut, { segmentation: { mode: 'off' } });

  // 3) Accurate alignment + ASR-mediated linker (reads R from textIn, H from hypothesisTextBuffer, anchors from segmentation)
  //    AlignmentEngine does NOT run STT here — only the pre-filled buffer is accepted.
  let write;
  try {
    write = await alignment.alignTextToAudio(
      referenceTextBuf,
      audioBuf,
      segmentOut,
      {
        mode: 'accurate',
        modelSource: ALIGNMENT_MODEL,
        granularity: 'word',
        language: 'en',
        segmentation: {
          mode: 'auto',
          anchorSegmentBuffer: anchorRef, // or { segmentBufferId: '...' }
          mappingStrategy: 'asr_mediated',
          asr: {
            hypothesisTextBuffer: asrHypothesisOut,
          },
        },
      } as any // remove when AlignTextToAudioOptionsAccurate is extended
    );
  } finally {
    await alignment.destroy();
  }

  console.log('segmentsWritten', write.segmentsWritten, write.outputSegmentBufferId);

  await stt.destroy();
  await releasePipelineTextBuffer(referenceTextBuf.bufferId);
  await releasePipelineTextBuffer(asrHypothesisOut.bufferId);
  await releasePipelineSegmentBuffer(anchorRef.segmentBufferId);
  await releasePipelineSegmentBuffer(segmentOut.bufferId);
  await releasePipelineAudioBuffer(audioBuf.bufferId);
}
```

### Design notes encoded in the example

| Input | Role | API surface today / target |
|--------|------|----------------------------|
| `referenceTextBuf` | **R** — reference transcript | `OfflineTextBuffer` |
| Filled `asrHypothesisOut` | **H** — ASR text + per-token times | Same buffer after `stt.transcribe`; linker reads **tokens/timestamps** via native getters |
| `anchorRef.segmentBufferId` | Speech time regions | From `segmentOfflineBuffer` + `speech_vad_model` |
| **`alignment.alignTextToAudio`** + `mappingStrategy: 'asr_mediated'` | Orchestrates **linker** + per-anchor **CTC**; **only** `hypothesisTextBuffer` (no internal `transcribe`) | **Target** — extends current `segmentation` union |

### Alternative: two-step public API (if you expose the linker)

If the linker is **also** a first-class export (subtitles / karaoke), callers might call it explicitly and then pass **pre-assigned spans** into alignment. That shape is **not** finalized here; the example above matches `alignment-public-modes-plan.md` (Path 3 **inside** the SDK, **`AlignmentEngine#alignTextToAudio`** for app developers who only need subtitles via alignment).

---

## Document history

| Date | Change |
|------|--------|
| 2026-04-30 | Initial; timestamps + `ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS`; **caller-only** `hypothesisTextBuffer` (no internal STT in alignment) |
| 2026-04-30 | Example uses **`createAlignment` + `alignment.alignTextToAudio` + `destroy`** per `alignment-public-modes-plan.md` |
| 2026-04-30 | **`modelSource: FileSource`** for accurate alignment + **`SegmentationPolicy.modelPath`** for `speech_vad_model` (STT/VAD naming) |
| 2026-05-01 | **`SegmentationPolicy.modelPath`** for `speech_vad_model` is **`FileSource`**; JS **`detectVadModel`** before native (accurate alignment `modelPath` unchanged: **`FileSource`**) |
