# Zipformer/Transducer Model

This directory should contain a **Zipformer/Transducer** model for offline speech recognition.

## Required Files

```
sherpa-onnx-zipformer-small-en/
├── encoder.onnx          (or encoder.int8.onnx for quantized)
├── decoder.onnx          (or decoder.int8.onnx for quantized)
├── joiner.onnx           (or joiner.int8.onnx for quantized)
└── tokens.txt            (REQUIRED)
```

## Model Type

- **Type**: `transducer` (Zipformer/Transducer)
- **Description**: Requires encoder, decoder, joiner, and tokens files

## Download

For download links and more information, see the [main README.md](../../../../../../README.md#supported-model-types).

Look for the **Zipformer/Transducer** model type in the "Supported Model Types" table.
