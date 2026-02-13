# Kokoro TTS Model (US English)

Single-stage neural TTS model with high-quality English synthesis.

## File Structure

```
kokoro-us/
├── model.onnx              # Main TTS model (required)
├── voices.bin              # Voice embeddings (required)
├── tokens.txt              # Token mappings (required)
├── lexicon.txt             # Pronunciation dictionary (required)
├── espeak-ng-data/         # Phoneme data directory (required)
├── README.md               # This file
└── dict/                   # Jieba dictionary for Chinese (optional, for mixed text)
    ├── hmm_model.utf8
    ├── idf.utf8
    ├── jieba.dict.utf8
    ├── user.dict.utf8
    └── README.md
```

## Required Files

- **model.onnx**: ONNX format neural network model
- **voices.bin**: Pre-computed voice embeddings for speaker characteristics
- **tokens.txt**: Vocabulary and token-to-ID mappings
- **lexicon.txt**: Word-to-phoneme pronunciation dictionary (use lexicon-us-en.txt or lexicon-gb-en.txt, rename to lexicon.txt)
- **espeak-ng-data/**: Directory containing phoneme generation rules and language data

## Optional Files

- **dict/**: Jieba dictionary for Chinese word segmentation when processing mixed language text

## Model Notes

- Requires lexicon file - choose between US English (lexicon-us-en.txt) or GB English (lexicon-gb-en.txt) and rename to lexicon.txt
- Requires espeak-ng-data directory for phoneme generation
- Supports high-quality single-speaker synthesis
- Auto-loads lexicon and espeak-ng-data from model directory

## Download

Model files can be downloaded from the sherpa-onnx model repository:
https://github.com/k2-fsa/sherpa-onnx/releases
