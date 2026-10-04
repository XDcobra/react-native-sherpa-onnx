# Alignment: vocab profile + romanization

Char-CTC alignment packs (EN wav2vec2-960h, VoxPopuli, MMS FA, XLSR-56) share one
native ORT + CTC pipeline. Omnilingual ASR-CTC is STT-only in this SDK (not an
alignment pack).

## Native: `AlignmentVocabProfile`

Resolved in `sherpa_onnx_ctc_alignment.cpp` from:

1. Explicit `vocab.json` content / `vocabPath`, else
2. Sidecar `vocab.json` next to `model.onnx`, else
3. Baked English wav2vec2-base-960h defaults.

Profile fields:

- `blankId` — smallest id among `<pad>` / `<blank>` / `[PAD]` / …
- `unkId` — `<unk>` / `[UNK]`
- `wordDelimiterId` — `|` or `-1` when absent (MMS)
- `caseMode` — upper / lower / none (both cases present)
- `frameSeconds` — currently `0.02`

Tokenization uses Unicode whitespace → word indices (not `|`-scanning) and
case-insensitive, diacritic-preserving vocab lookup.

`detectAlignmentModel` returns `paths.model` and optional `paths.vocab`. Align
APIs accept optional `vocabPath`.

## TS: pack profile + romanization

- [`src/alignment/modelProfiles.ts`](../../../src/alignment/modelProfiles.ts) —
  pack id heuristics → `needsRomanization`, romanizer id, language hints.
- [`src/alignment/romanization/`](../../../src/alignment/romanization/) —
  `Romanizer` interface with `identity` and `latin_diacritic` backends.
  Non-Latin `uroman` is reserved for a later backend behind the same API.

MMS FA is the only shipping pack that sets `needsRomanization: true` today
(ASCII-romanized Latin vocab). VoxPopuli keeps European diacritics.

## Adding a future char-CTC pack

1. Add a row to `scripts/alignment-models/sources.csv` (optional `vocab_url`).
2. Publish via the alignment release workflow.
3. Add one entry / heuristic in `modelProfiles.ts` (romanization + hints).
4. Extend language catalog pack hints if needed; regenerate with
   `yarn generate:model-language-catalog`.
