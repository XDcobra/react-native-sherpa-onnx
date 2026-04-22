# Voice Activity Detection (VAD)

VAD engine APIs are being migrated to a new streaming-first model.

## Current status

- Legacy placeholder functions are being replaced as part of the VAD migration.
- `SegmentBuffer` is now the core output primitive for VAD-oriented pipelines.
- Public SegmentBuffer docs:
  - [segmentbuffer-streaming.md](segmentbuffer-streaming.md)
  - [segmentbuffer-offline.md](segmentbuffer-offline.md)

## Migration docs

- [VAD spec](migration/vad/vad-spec.md)
- [VAD TypeScript API proposal](migration/vad/typescript-api-proposal.md)

This page will be expanded with full VAD runtime usage once the engine migration is finalized.
