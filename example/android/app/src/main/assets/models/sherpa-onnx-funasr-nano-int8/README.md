# FunASR Nano Model

This directory should contain a **FunASR Nano** model for offline speech recognition.

## Required Files

```
sherpa-onnx-funasr-nano-int8/
├── encoder_adaptor.onnx  (or encoder_adaptor.int8.onnx for quantized)
├── llm.onnx              (or llm.int8.onnx for quantized)
├── embedding.onnx        (or embedding.int8.onnx for quantized)
└── tokenizer/            (tokenizer directory - can be in subdirectory with "Qwen3" in name)
    ├── vocab.json        (REQUIRED)
    ├── merges.txt        (REQUIRED)
    └── tokenizer.json    (REQUIRED)
```

## Model Type

- **Type**: `funasr_nano`
- **Description**: Requires encoder_adaptor, llm, embedding, and tokenizer directory

## Tokenizer Location

The tokenizer directory can be located in two places:

1. **Directly in the model directory** - `vocab.json` should be in the root
2. **In a subdirectory** - The subdirectory name should contain "Qwen3" (case-insensitive, e.g., `Qwen3-0.6B/`)

The library automatically searches for the tokenizer in both locations.

## Download

For download links and more information, see the [main README.md](../../../../../../README.md#supported-model-types).

Look for the **FunASR Nano** model type in the "Supported Model Types" table.
