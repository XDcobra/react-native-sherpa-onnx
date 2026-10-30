# TextBuffer Spool Format

TextBuffer spool uses checkpoint + append journal persistence for long sessions.

## Files

- Journal: `<base>.txtj`
- Checkpoint: `<base>.txtc`

## Header (little-endian, 16 bytes)

- `magic` (u32): `TXT2`
- `version` (u16): `2`
- `recordType` (u16)
- `payloadLength` (u32)
- `checksum` (u32)

## Record types

- `TEXT_PARTIAL_SET`
- `TEXT_PARTIAL_APPEND`
- `TEXT_SEGMENT_COMMIT`
- `CHECKPOINT_MARK`
- `FINALIZE_MARK`

## Replay model

`fullIfSpooled`:
1. load checkpoint (`.txtc`) if present,
2. replay journal (`.txtj`) records in order,
3. reconstruct full text,
4. fail strict with `TEXT_SPOOL_*` on unavailable/read/corrupted conditions.

## Checkpoint policy

- checkpoint every `128` events or `1 MiB` journal growth.
- after checkpoint, journal is rotated/truncated.

## Compatibility

- No backward compatibility is guaranteed for unreleased pre-1.0 spool files.
- Runtime reads and writes only `.txtc` + `.txtj`.
