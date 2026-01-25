# Whisper Model

This directory should contain a **Whisper** model for offline speech recognition.

## Required Files

```
sherpa-onnx-whisper-tiny-en/
├── encoder.onnx          (or encoder.int8.onnx for quantized)
├── decoder.onnx          (or decoder.int8.onnx for quantized)
└── tokens.txt            (REQUIRED)
```

## Model Type

- **Type**: `whisper`
- **Description**: Requires encoder, decoder, and tokens files (no joiner)

## Download

For download links and more information, see the [main README.md](../../../../../../README.md#supported-model-types).

Look for the **Whisper** model type in the "Supported Model Types" table.
