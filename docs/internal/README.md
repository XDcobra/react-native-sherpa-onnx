# Internal docs

Maintainer notes, plans, and evidence. Public API guides live one level up (`docs/*.md`). Grouped by feature, matching `src/<feature>/`. Cross-cutting files stay in this folder.

## Buffers

| Folder | Notes |
| --- | --- |
| [audiobuffer/](./audiobuffer/) | Offline + live PCM internals |
| [textbuffer/](./textbuffer/) | Offline + live text internals, spool v2 |
| [segmentbuffer/](./segmentbuffer/) | Offline + live segment internals, spool v2 |
| [imagebuffer/](./imagebuffer/) | Storage / mmap |
| [videobuffer/](./videobuffer/) | VideoBuffer + VideoPreview internals and plans; [performance/](./videobuffer/performance/) benches |

## Features

| Folder | Notes |
| --- | --- |
| [audio-tagging/](./audio-tagging/) | Implementation plan |
| [language-identification/](./language-identification/) | SLID plan |
| [speaker-embedding/](./speaker-embedding/) | Shared extractor / SID / diarization core |
| [kws/](./kws/) | Keyword spotting plan |
| [tts/](./tts/) | Pocket TTS / EOS investigation |

## Cross-cutting

| File | Notes |
| --- | --- |
| [live-overload.md](./live-overload.md) | Shared offline-weights-on-live-buffers contracts |
| [sdk-feature-support-matrix.md](./sdk-feature-support-matrix.md) | Upstream vs SDK feature matrix |
| [cancel-clean-cut.md](./cancel-clean-cut.md) | Cancel / abort semantics (done) |
| [PREBUILT_RESOLUTION.md](./PREBUILT_RESOLUTION.md) | Android prebuilt cascade |
