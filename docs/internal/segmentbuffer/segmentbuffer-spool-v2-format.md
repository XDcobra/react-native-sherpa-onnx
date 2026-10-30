# SegmentBuffer Spool Format

This document defines the SegmentBuffer spool record format used on Android and iOS.

## Goals

- Append-oriented journal for long sessions.
- Periodic compact checkpoints for bounded replay cost.
- Strict `fullIfSpooled` semantics with explicit corruption detection.

## File layout

- Journal file: `<baseSpoolPath>.segj`
- Checkpoint file: `<baseSpoolPath>.segc`

## Record header (binary, little-endian)

- `magic` (u32): `0x32474553` (`SEG2`)
- `version` (u16): `2`
- `recordType` (u16)
- `payloadLength` (u32)
- `checksum` (u32)

Header size: `16` bytes.

## Record types

- `1` => `SEGMENT_APPEND`
- `2` => `CHECKPOINT_MARK`
- `3` => `FINALIZE_MARK`

## Payload format

- UTF-8 JSON strings.
- `SEGMENT_APPEND` payload encodes exactly one segment in a `{"segments":[...]}` envelope.
- Checkpoint payload encodes full current segment state in the same `{"segments":[...]}` envelope.
- `CHECKPOINT_MARK` and `FINALIZE_MARK` use `{}` payload.

## Replay model (`fullIfSpooled`)

1. Read checkpoint (`.segc`) if available, initialize full state.
2. Replay `.segj` records in order:
   - apply each `SEGMENT_APPEND`.
   - ignore marker records.
3. Return reconstructed full history.

If `.segc/.segj` files do not exist, strict full snapshot mode fails with `SEGMENT_SPOOL_UNAVAILABLE`.

## Checkpoint and compaction policy

- Trigger checkpoint at either threshold:
  - every `128` journal append records, or
  - every `1 MiB` journal bytes since last checkpoint.
- On checkpoint:
  - write new compact checkpoint atomically (temp + rename),
  - rotate/truncate journal and emit `CHECKPOINT_MARK`.

## Error mapping

- Missing spool for strict mode: `SEGMENT_SPOOL_UNAVAILABLE`
- Write/init failures: `SEGMENT_SPOOL_WRITE_FAILED`
- Read/open failures: `SEGMENT_SPOOL_READ_FAILED`
- Header/length/checksum/record-type corruption: `SEGMENT_SPOOL_CORRUPTED`

## Compatibility

- No backward compatibility is guaranteed for unreleased pre-1.0 spool files.
- Runtime reads and writes only `.segc` + `.segj`.
