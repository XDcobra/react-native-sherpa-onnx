# Hotwords (Contextual Biasing)

Boost recognition of specific words and phrases during transducer-based speech recognition.

**Import path:** `react-native-sherpa-onnx/stt`

---

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
  - [sttSupportsHotwords()](#sttsupportshotwordsmodeltype)
  - [Init Options](#init-options)
  - [Runtime Update](#runtime-update)
  - [Validation](#validation)
- [Hotwords File Format](#hotwords-file-format)
- [Modeling Unit & BPE Vocab](#modeling-unit--bpe-vocab)
- [Detailed Examples](#detailed-examples)
- [Troubleshooting & Tuning](#troubleshooting--tuning)
- [See Also](#see-also)

---

## Overview

| Feature | Status | Notes |
| --- | --- | --- |
| Supported models | ✅ | `transducer` and `nemo_transducer` only |
| Type check | ✅ | `sttSupportsHotwords(modelType)` |
| Init-time config | ✅ | `hotwordsFile`, `hotwordsScore`, `modelingUnit`, `bpeVocab` |
| Runtime update | ✅ | `stt.setConfig({ hotwordsFile, hotwordsScore })` |
| File validation | ✅ | Native: null-byte check, readability, existence |
| Auto beam switch | ✅ | Decoding auto-switches to `modified_beam_search` when hotwords are set |

Hotwords boost the probability of specified phrases during decoding. This is useful for domain-specific terms, proper nouns, product names, or any words the model would otherwise miss.

**Only transducer and nemo_transducer models support hotwords.** Other model types (whisper, paraformer, sense_voice, etc.) ignore hotwords silently or return an error.

---

## Quick Start

```typescript
import { createSTT, sttSupportsHotwords } from 'react-native-sherpa-onnx/stt';

const stt = await createSTT({
  modelPath: { type: 'asset', path: 'models/sherpa-onnx-streaming-zipformer-en' },
  modelType: 'transducer',
  hotwordsFile: '/path/to/hotwords.txt',
  hotwordsScore: 2.0,
});

// Update hotwords at runtime
await stt.setConfig({
  hotwordsFile: '/path/to/updated-hotwords.txt',
  hotwordsScore: 1.5,
});
```

**hotwords.txt:**
```
sherpa onnx :3.0
react native :2.5
zipformer
```

---

## API Reference

### `sttSupportsHotwords(modelType)`

```ts
function sttSupportsHotwords(modelType: STTModelType | string): boolean;
```

Returns `true` only for `'transducer'` and `'nemo_transducer'`. Use to show/hide hotword options in the UI.

```typescript
import { sttSupportsHotwords, STT_HOTWORDS_MODEL_TYPES } from 'react-native-sherpa-onnx/stt';

if (sttSupportsHotwords('transducer')) {
  // show hotword settings
}

// Or use the constant array:
// STT_HOTWORDS_MODEL_TYPES = ['transducer', 'nemo_transducer']
```

---

### Init Options

Pass these in `createSTT()` (or `createStreamingSTT()`):

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `hotwordsFile` | `string` | — | Absolute path to hotwords text file |
| `hotwordsScore` | `number` | `1.5` | Global boost score (higher = stronger bias) |
| `modelingUnit` | `string` | — | `'cjkchar'`, `'bpe'`, or `'cjkchar+bpe'` |
| `bpeVocab` | `string` | — | Path to BPE vocab file (required when `modelingUnit` includes `'bpe'`) |

---

### Runtime Update

Update hotwords without recreating the engine:

```typescript
await stt.setConfig({
  hotwordsFile: '/new/path/hotwords.txt',
  hotwordsScore: 2.0,
});
```

Both `hotwordsFile` and `hotwordsScore` can be set independently via `setConfig()`.

---

### Validation

The native layer validates the hotwords file on init and `setConfig()`:

| Error Code | Meaning |
| --- | --- |
| `HOTWORDS_NOT_SUPPORTED` | Model type doesn't support hotwords |
| `INVALID_HOTWORDS_FILE` | File doesn't exist, isn't readable, or contains null bytes |

Validation checks (native side):
1. File exists
2. File is a regular file (not a directory)
3. File is readable
4. File contains no null bytes (must be valid text)

---

## Hotwords File Format

Plain text, one phrase per line. Optional score suffix after `:`.

```
# Lines starting with # are NOT comments — include only phrases!

sherpa onnx :3.0
react native :2.5
zipformer
custom term :4.0
```

| Syntax | Description |
| --- | --- |
| `phrase` | Boosted with the global `hotwordsScore` |
| `phrase :score` | Boosted with the per-phrase `score` (overrides global) |

- Lines are trimmed; empty lines are ignored
- Multi-word phrases are supported (space-separated)
- Scores are float values; higher = stronger bias
- There is no comment syntax — every non-empty line is treated as a hotword entry

---

## Modeling Unit & BPE Vocab

For some transducer models, you may need to specify how hotwords are tokenized:

| `modelingUnit` | Use Case | `bpeVocab` Required? |
| --- | --- | --- |
| `'cjkchar'` | Chinese/CJK models | No |
| `'bpe'` | BPE-tokenized models | Yes — path to `bpe.vocab` |
| `'cjkchar+bpe'` | Mixed CJK + BPE models | Yes — path to `bpe.vocab` |
| (omitted) | Default tokenization | No |

The `bpeVocab` file is typically distributed with the model (e.g. `bpe.vocab` in the model directory). When `modelingUnit` includes `'bpe'`, you must provide this file, otherwise hotwords may not work correctly.

```typescript
const stt = await createSTT({
  modelPath: { type: 'asset', path: 'models/zipformer-bilingual' },
  modelType: 'transducer',
  hotwordsFile: '/path/to/hotwords.txt',
  modelingUnit: 'cjkchar+bpe',
  bpeVocab: '/path/to/bpe.vocab',
});
```

---

## Detailed Examples

### Check support before showing UI

```typescript
import { detectSttModel } from 'react-native-sherpa-onnx/stt';
import { sttSupportsHotwords } from 'react-native-sherpa-onnx/stt';

const detection = await detectSttModel(modelPath);
if (detection.success && detection.modelType) {
  const showHotwords = sttSupportsHotwords(detection.modelType);
  // showHotwords: true for transducer/nemo_transducer, false for others
}
```

### Streaming STT with hotwords

```typescript
import { createStreamingSTT } from 'react-native-sherpa-onnx/stt';

const engine = await createStreamingSTT({
  modelPath: { type: 'asset', path: 'models/streaming-zipformer-en' },
  modelType: 'transducer',
  hotwordsFile: '/path/to/hotwords.txt',
  hotwordsScore: 2.0,
});

const stream = await engine.createStream();
// Feed audio chunks...
```

### Dynamic hotwords (per-session)

```typescript
import RNFS from 'react-native-fs';

// Write hotwords for this session
const hotwordsPath = `${RNFS.CachesDirectoryPath}/session-hotwords.txt`;
await RNFS.writeFile(hotwordsPath, 'customer name :3.0\nproduct code :2.5\n');

await stt.setConfig({ hotwordsFile: hotwordsPath, hotwordsScore: 2.0 });

// After session, update for next context
await RNFS.writeFile(hotwordsPath, 'different context :3.0\n');
await stt.setConfig({ hotwordsFile: hotwordsPath });
```

---

## Troubleshooting & Tuning

| Issue | Solution |
| --- | --- |
| `HOTWORDS_NOT_SUPPORTED` | Model type is not transducer/nemo_transducer — hotwords only work with these |
| `INVALID_HOTWORDS_FILE` | Check file path, readability, and that it's a valid text file (no null bytes) |
| Hotwords not boosting | Increase `hotwordsScore`; verify file format (one phrase per line) |
| Over-boosting (hallucinations) | Lower `hotwordsScore`; a value of 1.0–2.0 is usually sufficient |
| CJK hotwords not working | Set `modelingUnit: 'cjkchar'` or `'cjkchar+bpe'` |
| BPE hotwords fail | Ensure `bpeVocab` path points to a valid `bpe.vocab` file |

**Auto beam search switch:** When `hotwordsFile` is set, the decoder automatically switches to `modified_beam_search` if it wasn't already. This is required for hotwords to take effect.

**Tuning tips:**

- Start with `hotwordsScore: 1.5` and adjust based on results
- Per-phrase scores (`:3.0` suffix) let you prioritize critical terms
- Too many hotwords (thousands) may slow decoding — keep the list focused
- Test with representative audio to find the right balance between boosting and false positives

---

## See Also

- [STT](stt.md) — Offline speech recognition API
- [Streaming STT](stt-streaming.md) — Real-time recognition with hotwords
- [Model Setup](model-setup.md) — Model discovery and paths
