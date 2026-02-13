# Kokoro TTS Model (Chinese)

Single-stage neural TTS model with high-quality Chinese synthesis and text normalization.

## File Structure

```
kokoro-zh/
├── model.onnx              # Main TTS model (required)
├── voices.bin              # Voice embeddings (required)
├── tokens.txt              # Token mappings (required)
├── lexicon.txt             # Pronunciation dictionary (required)
├── espeak-ng-data/         # Phoneme data directory (required)
├── date-zh.fst             # Date normalization FST (auto-loaded)
├── number-zh.fst           # Number normalization FST (auto-loaded)
├── phone-zh.fst            # Phone number normalization FST (auto-loaded)
├── README.md               # This file
└── dict/                   # Jieba dictionary for Chinese segmentation (auto-loaded)
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
- **lexicon.txt**: Word-to-phoneme pronunciation dictionary
- **espeak-ng-data/**: Directory containing phoneme generation rules and language data

## Chinese-Specific Files (Auto-loaded)

- **date-zh.fst**: Finite State Transducer for normalizing date expressions (e.g., "2024年1月29日")
- **number-zh.fst**: FST for normalizing number expressions (e.g., "123" → "一百二十三")
- **phone-zh.fst**: FST for normalizing phone numbers
- **dict/**: Jieba dictionary for Chinese word segmentation and tokenization

These files are automatically loaded by sherpa-onnx when present in the model directory.

## Model Notes

- Requires lexicon file and espeak-ng-data directory
- FST files provide intelligent text normalization for dates, numbers, and phone numbers
- Jieba dictionary enables proper Chinese word segmentation
- Auto-loads all normalization and segmentation resources from model directory

## Download

Model files can be downloaded from the sherpa-onnx model repository:
https://github.com/k2-fsa/sherpa-onnx/releases
