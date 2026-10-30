# Granite Docling instruction-parity

HF greedy versus the ORT pack for `doc_vlm` (IBM Granite-Docling-258M).
Plan Phase 0; see [`../instructions/README.md`](../instructions/README.md).

```bash
build/ocr-models/.venv/bin/python scripts/ocr-models/instructions/fixtures.py

build/ocr-models/.venv/bin/hf download ibm-granite/granite-docling-258M \
  --local-dir build/ocr-models/docvlm-granite-258m/hf-src

build/ocr-models/.venv/bin/python \
  scripts/ocr-models/doc-vlm/probe_instructions.py --task page --max-new-tokens 128
```

`--task` is one of: `page`, `element_table`, `element_chart`, `element_formula`,
`element_code`, `regionText`, `identifyElement`.
