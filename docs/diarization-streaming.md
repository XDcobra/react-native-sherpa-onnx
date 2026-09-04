# Speaker diarization (streaming)

**Status:** Not shipped. Planned path: **true streaming** (e.g. NeMo Sortformer via
ONNX Runtime), not live overload on the offline pyannote + clustering stack.

Offline batch: [diarization-offline.md](./diarization-offline.md).

## Live overload — intentionally out of scope

Diarization will **not** get a live-overload API (offline weights on live buffers
via the shared segmentation engine), and that is **not** planned later either.

**Why**

- Offline diarization already runs **pyannote sliding windows** inside one
  `diarize` call. The segmentation engine is not needed to keep model inputs
  window-sized.
- Live overload commits slices and runs the **offline** feature per commit (as
  with SID). Per-slice `diarize` yields **local** cluster IDs without stable
  speaker identity across the session — poor “who spoke when” live.
- Fixing that would mean session-wide re-clustering or custom state across
  commits — a different design than live overload, closer to true streaming.

**What to use instead**

| Need | Path |
| --- | --- |
| Batch who-spoke-when | Offline `createDiarization` / `diarize` |
| Live / low-latency diarization | Future **streaming** model (Sortformer / ORT), not live overload |
| Named speakers on an offline timeline | [diarization-named-timeline.md](./diarization-named-timeline.md) |

Contrast: SID **does** ship live overload (`labelLiveSegments`) because each
utterance is independently matched to a fixed enrollment gallery — that
composition does not apply to anonymous clustering diarization.
