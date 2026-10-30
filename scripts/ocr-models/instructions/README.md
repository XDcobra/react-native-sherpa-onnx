# OCR instruction-parity

Manual pack run: Hugging Face greedy decode versus the shipped ONNX pack, per
instruction. The name is the check — **does this pack match HF for this
prompt?**

Not part of the normal CI suite. In [`ocr-instructions-sdk-plan.md`](../../../docs/ocr/ocr-instructions-sdk-plan.md)
this is still **Phase 0** (evidence gate). Re-run here when a pack, tokenizer,
or prompt changes.

Two Python environments (the HF snapshots need different Transformers lines):

| Venv | Transformers | Families |
|------|----------------|----------|
| `build/ocr-models/.venv-tf4` | 4.57.x | `paddleocr_vl`, `doc_vlm` |
| `build/ocr-models/.venv` | 5.14.1 | `nemotron_parse` |

```bash
# Fixtures (deterministic PNGs)
build/ocr-models/.venv-tf4/bin/python scripts/ocr-models/instructions/fixtures.py

# One family. HF and ORT load sequentially (not together) so a 16 GB
# machine survives; finished goldens are skipped on rerun.
build/ocr-models/.venv-tf4/bin/python \
  scripts/ocr-models/paddleocr-vl/probe_instructions.py --task all --max-new-tokens 64

build/ocr-models/.venv-tf4/bin/python \
  scripts/ocr-models/doc-vlm/probe_instructions.py --task all --max-new-tokens 64

build/ocr-models/.venv/bin/python \
  scripts/ocr-models/nemotron-parse/probe_instructions.py --output-profile all --max-new-tokens 64

# Prompt ids only (processor, no weights)
python3 scripts/ocr-models/instructions/test_tasks.py
build/ocr-models/.venv-tf4/bin/python scripts/ocr-models/instructions/dump_prompt_ids.py
python3 scripts/ocr-models/instructions/verify_prompt_ids.py

# Orchestrator (writes the gitignored report)
build/ocr-models/.venv-tf4/bin/python scripts/ocr-models/instructions/run_phase0.py \
  --max-new-tokens 64
```

`run_phase0.py` / `vast_run_phase0.sh` / `phase0-cache` keep those filenames.

HF snapshots (desktop only, not committed):

```text
build/ocr-models/paddleocr-vl-1.6/hf-src
build/ocr-models/nemotron-3.5-parse/hf-src
build/ocr-models/docvlm-granite-258m/hf-src
```

Goldens land in `test/fixtures/ocr/instructions/<family>/<task>/[<profile>/]<fixture>/`.

Committed / host-test inputs:

- `prompt_ids.json`
- `prompt.txt`
- `raw.txt` (HF)
- `meta.json` (pack id, preprocess, token identity, grammar)
- `_images/` fixtures

Local-only (gitignored; rewritten by `probe_instructions.py`):

- `hf_tokens.json` / `ort_tokens.json` / `ort_raw.txt`
- `prompt-ids-verify.json`
- `phase0-report.json`

An instruction enters the public API only when HF and ORT tokens match on
all three fixtures and the grammar check reports `unknown: []`.

## Test suite names

CI workflow: `Test – OCR host (C++)` (`.github/workflows/test-ocr-host.yml`).
PR/push runs the binaries below. VLM **weights** are not downloaded; pack-gated
cases `GTEST_SKIP`.

| ctest / Jest | Typical `TEST(Suite, Case)` | Packs |
| --- | --- | --- |
| `ocr_instruction_host_test` | `OcrRecognizeSpec.*`, `OcrGeometry.*`, `OcrTable.*`, `OcrOtsl.*`, `OcrElementKind.*` | none |
| `ppocr_host_test` | `OcrFactory.*`, `PpocrCtcUnit.*`, `PpocrDbUnit.*`, `PpocrCrop.*` | `ppocrv6-tiny` |
| `doctr_host_test` | `DoctrCtcUnit.*`, `DoctrParseqUnit.*`, `DoctrDbUnit.*`, `DoctrCrop.*` | `doctr-mobile` |
| `doc_vlm_host_test` | `Prompt.TaskUserIdsMatchGoldens`, `DocTags.InstructionGoldenRawsParseAndIdentity`, parser units. Skip: `DocVlmSmoke.EnHello`, tokenizer cases without `DOCVLM_MODEL_DIR` | none on CI |
| `nemotron_parse_host_test` | `NemotronParsePrompt.FourteenProfilesMatchGoldens`, `NemotronParseMarkup.InstructionMarkdownNonePicGoldens`. Skip: `NemotronParseSmoke.EnHello` without `NEMOTRON_PARSE_MODEL_DIR` | none on CI |
| `paddleocr_vl_host_test` | `PaddleocrVlPrompt.TaskIdsMatchGoldens`, `PaddleocrVlMarkup.InstructionGoldenRawsParse`, `….InstructionSpottingGoldenRawsParseAndIdentity`. Skip: `PaddleocrVlBackend.EnHelloSmoke` without `PADDLEOCR_VL_MODEL_DIR` | none on CI |
| `src/ocr/__tests__/recognizeSpec.test.ts` | TS spec encode/decode + gated-task rejects | none |
| `src/ocr/__tests__/ocrTypes.test-d.ts` | `tsc` type locks | none |

Manual only (this README): `probe_instructions.py` / `run_phase0.py` =
instruction-parity on the large packs.

Manual CI dispatch `run_doc_vlm_golden`: downloads granite-fp32 and runs
`DocVlmSmoke.EnHello`.
