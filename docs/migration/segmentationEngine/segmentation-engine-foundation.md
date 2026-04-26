# Segmentation Engine Foundation (Draft)

## Purpose

Define a shared Segmentation Engine that can be reused by multiple features (TTS incremental, Alignment fake streaming, and future orchestrators) without coupling feature-specific logic into segmentation itself.

Core idea:

- Segmentation is split into two domains:
  - text segmentation
  - speech segmentation
- Feature pipelines consume segmentation output instead of implementing custom chunking logic per feature.

---

## Domain Split

## 1) Text Segmentation

Text segmentation defines boundaries in text space (sentence/word/token/length), not audio-time boundaries.

### Mode 1: synthetic auto-segmentation

- no sherpa-onnx punctuation model required
- uses deterministic rules:
  - sentence/word/token rules
  - punctuation heuristics
  - language-aware rules
  - max-length policy
- fallback path when user does not provide a punctuation model

### Mode 2: punctuation-model-assisted segmentation

- uses sherpa-onnx punctuation model output as boundary signal
- then applies Mode 1 rules as normalization/post-processing
- useful when incoming text lacks reliable punctuation (for example raw STT output), and downstream features need stable segment boundaries

---

## 2) Speech Segmentation

Speech segmentation defines boundaries in audio/speech time.

### Mode 1: energy/silence-based segmentation

- no sherpa-onnx VAD model required
- uses deterministic audio heuristics:
  - energy thresholding
  - silence/pause detection
  - min/max duration policies
  - hangover/smoothing rules
- fallback path when user does not provide a VAD model

### Mode 2: VAD-based segmentation

- uses sherpa-onnx VAD model
- emits speech-boundary segments
- corresponds to the current VAD segmentation strategy already used in pipeline integrations

---

## Integration Model

Segmentation Engine output should be consumable by feature orchestrators in a uniform way.

- Internal output:
  - `SegmentPlan` (engine-native representation for orchestration)
- Transport/persistence output:
  - `SegmentBuffer` (buffer-first contract artifact)

Feature flows:

- TTS incremental consumes segmentation output for fake-streaming chunk orchestration
- Alignment fake streaming consumes segmentation output to run per-segment offline alignment and merge results into one output timeline
- future features can reuse the same segmentation contracts

---

## API Capability Boundary

Keep runtime capability claims explicit and honest:

- Streaming APIs only where sherpa-onnx supports native streaming (for example STT, VAD)
- Offline APIs where models are offline-only
- Offline APIs with optional segmentation:
  - segmentation is used to orchestrate fake streaming
  - segment-wise offline processing remains offline underneath
  - final output remains buffer-first (`SegmentBuffer`)

---

## Design Notes

- Text segmentation and speech segmentation must stay distinct in contracts and implementations.
- VAD is a speech segmentation signal only; it is not a text segmentation strategy.
- Punctuation models are text segmentation signals; they do not provide speech-time boundaries by themselves.
- A join/mapping layer may be required for features that need both domains simultaneously (for example alignment workflows combining text chunks with speech anchors).

---

## Suggested Implementation Order

1. Segmentation Engine minimal foundation
   - domain split
   - mode contracts
   - shared output contract (`SegmentPlan` + `SegmentBuffer`)
2. Adapt TTS incremental to consume Segmentation Engine
3. Build Alignment fake streaming orchestration on Segmentation Engine
4. Extend docs/examples and add parity/behavior matrix tests

