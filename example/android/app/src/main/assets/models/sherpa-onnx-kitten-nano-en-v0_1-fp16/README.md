# KittenTTS Nano Model (English, FP16)

Compact single-stage neural TTS model optimized for mobile deployment with 16-bit floating point precision.

## File Structure

```
sherpa-onnx-kitten-nano-en-v0_1-fp16/
├── model.onnx              # Main TTS model (required)
├── voices.bin              # Voice embeddings (required)
├── tokens.txt              # Token mappings (required)
├── espeak-ng-data/         # Phoneme data directory (optional)
└── README.md               # This file
```

## Required Files

- **model.onnx**: ONNX format neural network model with FP16 quantization
- **voices.bin**: Pre-computed voice embeddings for speaker characteristics
- **tokens.txt**: Vocabulary and token-to-ID mappings

## Optional Files

- **espeak-ng-data/**: Directory containing phoneme generation rules (optional for KittenTTS)

## Model Notes

- No lexicon file required (unlike Kokoro models)
- espeak-ng-data is optional - model can work without it
- FP16 quantization provides good balance between quality and model size
- Optimized for low-resource environments and mobile devices
- Single-speaker synthesis

## Download

Model files can be downloaded from the sherpa-onnx model repository:
https://github.com/k2-fsa/sherpa-onnx/releases
