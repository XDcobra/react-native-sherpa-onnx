# Matcha TTS Model (US English, LJSpeech)

Two-stage neural TTS model trained on LJSpeech dataset with separate acoustic model and vocoder.

## File Structure

```
sherpa-onnx-matcha-icefall-en_US-ljspeech/
├── acoustic_model.onnx     # Acoustic features generator (required)
├── vocoder.onnx            # Waveform generator (required)
├── tokens.txt              # Token mappings (required)
├── lexicon.txt             # Pronunciation dictionary (optional)
├── espeak-ng-data/         # Phoneme data directory (optional)
└── README.md               # This file
```

## Required Files

- **acoustic_model.onnx**: First-stage model generating acoustic features (mel-spectrograms)
- **vocoder.onnx**: Second-stage model converting acoustic features to audio waveform
- **tokens.txt**: Vocabulary and token-to-ID mappings

## Optional Files

- **lexicon.txt**: Word-to-phoneme pronunciation dictionary for better pronunciation
- **espeak-ng-data/**: Directory containing phoneme generation rules

## Two-Stage Architecture

1. **Acoustic Model**: Converts text → acoustic features (mel-spectrograms)
   - File: `acoustic_model.onnx`
   - Input: Text/phonemes
   - Output: Mel-spectrogram frames

2. **Vocoder**: Converts acoustic features → audio waveform
   - File: `vocoder.onnx`
   - Input: Mel-spectrogram
   - Output: PCM audio samples

This two-stage approach separates linguistic modeling from audio generation for improved quality.

## Model Notes

- Based on Matcha-TTS architecture with diffusion-based mel-spectrogram generation
- Trained on LJSpeech dataset (single female speaker)
- lexicon and espeak-ng-data auto-loaded if present
- High-quality synthesis with natural prosody

## Download

Model files can be downloaded from the sherpa-onnx model repository:
https://github.com/k2-fsa/sherpa-onnx/releases
