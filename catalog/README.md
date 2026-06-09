# Model language catalog

Single source of truth for curated language rows and STT picker entries.

## Source file

Edit [`model-language-catalog.json`](model-language-catalog.json), then regenerate:

```bash
yarn generate:model-language-catalog
```

CI runs `yarn check:model-language-catalog` to ensure generated artifacts match JSON.

## Generated outputs

| Output | Purpose |
| --- | --- |
| `android/.../model_language_catalog.inc.h` | Embedded C++ `PublicLanguageRow` tables + `ModelOptionIdForHint` |
| `src/model-languages/generated/catalog.ts` | Public picker APIs and hint helpers |

## Canonical row shape

Native detect and the JS public API use the same bundled row:

```json
{ "iso6391Hint": "zh", "id": "中文" }
```

- **`iso6391Hint`**: filter chips, download catalog, System TTS locales (`lang="de"`)
- **`id`**: value for STT/TTS `modelOptions` / API parameters (FunASR `中文`, Dolphin `zh-cn`, …)

Codegen computes `iso6391Hint` from each JSON entry at build time (FunASR labels, ISO ids, Dolphin locale ids). No manual `publicHint` field in JSON.

## Schema (version 1)

### TTS — hint-only entries

ISO-style primary tags (pre-normalized). Codegen emits `{ hint, hint }` rows:

```json
{
  "tts": {
    "pocket": { "hints": ["en"] },
    "supertonic": {
      "variants": [
        {
          "modelKeyMatch": ["supertonic-3", "supertonic_3", "supertonic-v3", "supertonic3"],
          "hints": ["ar", "bg", "…", "na"]
        },
        { "modelKeyMatch": "default", "hints": ["en", "ko", "fr", "es", "pt"] }
      ]
    }
  }
}
```

### STT — picker rows

Full `ModelLanguage` rows; codegen emits `{ iso6391Hint, id }` per entry:

```json
{
  "stt": {
    "whisper": {
      "entries": [{ "id": "en", "name": "english" }]
    },
    "funasr_nano": {
      "entries": [{ "id": "中文", "name": "chinese" }],
      "pickerVariants": {
        "nano": [{ "id": "中文", "name": "chinese" }],
        "mlt": [{ "id": "中文", "name": "chinese" }]
      }
    },
    "moonshine": { "hints": ["en"] }
  }
}
```

- **`entries`**: `{ id, name }` — native detect rows (C++) and `sttModelLanguagesForModelType`.
- **`pickerVariants`** (FunASR only): `{ nano, mlt }` picker subsets; every `id` must exist in `entries`.
- **`hints`**: direct hint list (Moonshine) → `{ hint, hint }` rows.
- **`excludeFromHints`**: entry ids omitted from detect rows (e.g. SenseVoice `auto`).

## Merge policy (native detect)

1. Folder/name heuristics fill `derivedLanguages` as `{ hint, hint }` rows.
2. When `modelType` is known, upgrade each row's `id` via `ModelOptionIdForHint` (e.g. heuristic `zh` → FunASR `中文`).
3. If still empty and the model kind is known: append full curated row lists for `(domain, modelType, modelKey)`.
4. Name-only detect also receives curated rows when applicable.
5. `lexiconLanguages` stays separate.

When curated rows are applied, native adds `curatedCatalog` to `detectionSources`.

## Bridge shape

Native detect returns:

```json
"languages": [
  { "iso6391Hint": "zh", "id": "中文" },
  { "iso6391Hint": "de", "id": "de" }
]
```

TypeScript `publicLanguageHintsFromNative` only normalizes `iso6391Hint`; it does not re-map ids.

## Adding a model family

1. Add a `tts.*` or `stt.*` block to the JSON.
2. Run `yarn generate:model-language-catalog`.
3. Ensure C++ maps the detect `modelType` in `model_language_catalog.cpp` when needed.
4. Add C++ tests in `test/cpp/model_detect/curated_language_catalog_test.cpp` when behavior is non-obvious.

Alignment, VAD, punctuation, and enhancement have no curated entries today.
