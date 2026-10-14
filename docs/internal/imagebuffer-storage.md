# ImageBuffer storage (internal)

Offline ImageBuffer mirrors OfflineAudioBuffer mmap policy in C++ (`android/src/main/cpp/image/`).

| Item | Value |
| --- | --- |
| Id prefix | `img_off_<uuid>` |
| Temp files | `img_off_<uuid>_f<N>.rgb8` under cache/tmp (`sherpa-image`) |
| Payload | Raw RGB8, no header; meta only in `ImageRegistry` |
| Threshold | `ImageMmapThreshold` — same numbers as audio (`MmapThresholdPolicy` / `pa_computeThresholdBytes`) |
| Decision input | `totalBytes` of the buffer; re-evaluated after append / create |
| Orphan sweep | Prefix `img_off_`, suffix `.rgb8`, maxAge 1h at init |
| Engine ptr | `ImageRegistry::GetFrameRgbPtr` |

Public docs: [`docs/imagebuffer-offline.md`](../imagebuffer-offline.md).
