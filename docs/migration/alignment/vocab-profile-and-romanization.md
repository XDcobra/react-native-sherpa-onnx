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
  pack id / language hints still come from **name heuristics** (logging / UX).
- [`src/alignment/romanization/inferFromVocab.ts`](../../../src/alignment/romanization/inferFromVocab.ts) —
  **`needsRomanization` / `romanizerId` are chosen from `vocab.json` charset**
  when a vocab path is available (`resolveAlignmentOnnxPath` reads the file).
- Name-based romanizer is only the **fallback** when vocab is missing or unreadable.
- No extra sidecar is required for third-party packs that already ship `vocab.json`.

### Vocab charset heuristic

Letter tokens (skip `<…>`, `[…]`, `|`, digits/punct):

| Vocab letters | Romanizer |
| --- | --- |
| Only ASCII `a–z` / `A–Z` | `uroman` (MMS-style ASCII vocab) |
| Any diacritic / non-Latin letter | `identity` (VoxPopuli, XLSR, …) |
| No letter tokens / unreadable vocab | keep name-heuristic profile |

Renaming a model folder does not matter as long as `vocab.json` sits beside
`model.onnx` (detect still returns `paths.vocab`).

| Typical pack | Effective `romanizerId` | Notes |
| --- | --- | --- |
| MMS FA | `uroman` | ASCII-romanized vocab |
| VoxPopuli | `identity` | Diacritics in vocab |
| XLSR-56 | `identity` | Native-script chars in vocab |
| EN 960h (no vocab file) | name fallback → often `identity` | Baked native defaults |

### uroman backend

[`src/alignment/romanization/uroman/`](../../../src/alignment/romanization/uroman/)
implements a greedy longest-match engine over rule tables exported from
[isi-nlp/uroman](https://github.com/isi-nlp/uroman), then applies torchaudio-style
MMS ASCII normalize (`a-z`, `'`, space). Optional `language` (ISO 639-1/639-3)
improves language-sensitive mappings (e.g. Russian word-initial Е → Ye).

Attribution / NOTICE: [`src/alignment/romanization/uroman/NOTICE.md`](../../../src/alignment/romanization/uroman/NOTICE.md).

Regenerate tables and goldens (requires `pip install uroman`):

```bash
python3 scripts/alignment-romanization/export-uroman-tables.py --goldens
```

**License note:** the MMS FA **model** remains CC-BY-NC-4.0. The uroman rule
data itself is redistributable under the upstream uroman permission notice with
attribution.

## Adding a future char-CTC pack

1. Add a row to `scripts/alignment-models/sources.csv` (optional `vocab_url`).
2. Publish via the alignment release workflow.
3. Optional: name heuristic in `modelProfiles.ts` for pack id / romanizer family
   (romanizer follows vocab automatically when `vocab.json` is present).
4. Set the `languages` column on the `sources.csv` row (ISO codes). Regenerate
   with `yarn generate:model-language-catalog` — pack language hints are
   **pack-first** from that CSV (never “contains xlsr ⇒ multilingual list”).
