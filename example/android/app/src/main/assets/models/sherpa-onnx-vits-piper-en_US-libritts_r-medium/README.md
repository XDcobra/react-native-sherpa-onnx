# VITS Piper Model (English US - LibriTTS-R Medium)

This directory should contain a **VITS Piper** model for offline text-to-speech synthesis.

## Required Files

```
sherpa-onnx-vits-piper-en_US-libritts_r-medium/
├── model.onnx              # Required: Main TTS model
├── tokens.txt              # Required: Token vocabulary
├── model.json              # Optional but recommended: Model metadata
│                           # (speaker names, inference parameters)
├── lexicon.txt             # Optional: Pronunciation dictionary
└── espeak-ng-data/         # Optional: Phonemization data
    └── ...
```

## Model Type

- **Type**: `vits`
- **Description**: Fast, high-quality single-stage TTS
- **Language**: English (US)
- **Quality**: Medium (balanced size/quality)
- **Dataset**: LibriTTS-R (expressive multi-speaker)
- **Speakers**: 904 different voices

## Important Notes

### Model Variants

VITS models come in different quantization levels:
- `model.onnx` → Full precision (best quality)
- `model.int8.onnx` → 8-bit quantized (smaller, faster)
- `model.fp16.onnx` → Half precision (balance)

### model.json (Recommended)

The `model.json` file contains important metadata:
```json
{
  "num_speakers": 904,
  "speaker_id_map": {"3922": 0, "8699": 1, ...},
  "inference": {
    "noise_scale": 0.333,
    "length_scale": 1.0,
    "noise_w": 0.333
  }
}
```

Benefits:
- ✅ Speaker selection by name instead of numeric ID
- ✅ Optimal quality parameters automatically applied
- ✅ Sample rate and phoneme mapping information

**While optional**, it's **highly recommended** for multi-speaker models.

### Multi-Speaker Usage

This model has **904 speakers**. In your code:

```typescript
// Get number of speakers
const numSpeakers = await getNumSpeakers(); // Returns 904

// Generate with different speakers
const audio = await generateSpeech('Hello!', { sid: 42 }); // Speaker ID 0-903
```

### Piper Models

Piper is a family of high-quality VITS models with:
- Multiple languages (50+)
- Multiple quality levels (low, medium, high)
- Well-optimized for production use
- Consistent quality and performance

## Download

For download links and more information, see:
- [TTS Model Setup Guide](../../../../../../TTS_MODEL_SETUP.md)
- [Piper Models Collection](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)
- [Piper TTS Project](https://github.com/rhasspy/piper)
