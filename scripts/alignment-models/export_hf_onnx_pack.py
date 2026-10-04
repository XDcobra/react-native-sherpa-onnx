#!/usr/bin/env python3
"""Export a Hugging Face wav2vec2 CTC checkpoint into an onnx-community-style pack.

Layout (mirrors onnx-community/wav2vec2-*-ONNX):

  <out>/
    README.md
    LICENSE
    config.json
    vocab.json
    preprocessor_config.json
    tokenizer.json          (when present upstream)
    tokenizer_config.json
    special_tokens_map.json (when present)
    onnx/
      model.onnx            # fp32
      model_fp16.onnx       # optional
      model_int8.onnx       # dynamic weight quant (QUInt8)

Example:

  build/alignment-onnx-export/.venv/bin/python \\
    scripts/alignment-models/export_hf_onnx_pack.py \\
    --model kresnik/wav2vec2-large-xlsr-korean \\
    --out build/alignment-onnx-export/packs/wav2vec2-large-xlsr-53-korean-ONNX
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.request import Request, urlopen

APACHE_LICENSE_URL = (
    "https://huggingface.co/datasets/choosealicense/licenses/resolve/main/markdown/apache-2.0.md"
)

SIDE_CAR_NAMES = (
    "config.json",
    "vocab.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "alphabet.json",
)


def run(cmd: list[str], cwd: Path | None = None) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, cwd=cwd)


def download(url: str, dest: Path) -> None:
    req = Request(url, headers={"User-Agent": "react-native-sherpa-onnx-export/1.0"})
    with urlopen(req, timeout=120) as resp:
        dest.write_bytes(resp.read())


def write_readme(
    out_dir: Path,
    *,
    model_id: str,
    base_model: str,
    language: str,
    license_spdx: str,
) -> None:
    # YAML front matter compatible with HF model cards.
    body = f"""---
language:
- {language}
license: {license_spdx}
base_model:
- {base_model}
library_name: transformers
tags:
- automatic-speech-recognition
- wav2vec2
- xlsr
- onnx
- forced-alignment
- char-ctc
pipeline_tag: automatic-speech-recognition
---

# {model_id}

ONNX export of [`{base_model}`](https://huggingface.co/{base_model}) for char-CTC
forced alignment / ASR (wav2vec2 XLSR family).

## Files

| Path | Notes |
| --- | --- |
| `onnx/model.onnx` | fp32 |
| `onnx/model_fp16.onnx` | fp16 weights (when present) |
| `onnx/model_int8.onnx` | dynamic QUInt8 weight quantization |
| `vocab.json` | CTC character vocabulary |
| `config.json` | Transformers model config |
| `LICENSE` | {license_spdx} |

## Source

- Base checkpoint: `{base_model}` ({license_spdx})
- Export: `optimum-cli export onnx` + `onnxruntime` dynamic quantization
- Intended use: offline forced alignment (CTC) in commercial apps when the
  base model license allows it

## Sample rate

16 kHz mono PCM.
"""
    (out_dir / "README.md").write_text(body, encoding="utf-8")


def copy_sidecars(cache_or_snapshot: Path, out_dir: Path) -> None:
    for name in SIDE_CAR_NAMES:
        src = cache_or_snapshot / name
        if src.is_file():
            shutil.copy2(src, out_dir / name)
            print(f"[sidecar] {name}", flush=True)


def find_exported_onnx(export_dir: Path) -> Path:
    candidates = sorted(export_dir.rglob("model.onnx"))
    if not candidates:
        # optimum sometimes names by component
        candidates = sorted(p for p in export_dir.rglob("*.onnx") if p.is_file())
    if not candidates:
        raise FileNotFoundError(f"No ONNX file under {export_dir}")
    # Prefer top-level / shortest path named model.onnx
    candidates.sort(key=lambda p: (0 if p.name == "model.onnx" else 1, len(p.parts)))
    return candidates[0]


def quantize_int8(fp32: Path, int8: Path) -> None:
    from onnxruntime.quantization import QuantType, quantize_dynamic

    # wav2vec2 pos_conv_embed Conv weights are not plain initializers after export;
    # quantize MatMul/Gemm only (same practical approach as many HF ORT packs).
    print(f"[quantize] int8 {fp32.name} -> {int8.name} (MatMul/Gemm)", flush=True)
    quantize_dynamic(
        model_input=str(fp32),
        model_output=str(int8),
        weight_type=QuantType.QUInt8,
        op_types_to_quantize=["MatMul", "Gemm"],
    )


def convert_fp16(fp32: Path, fp16: Path) -> bool:
    try:
        import onnx
        from onnxruntime.transformers.float16 import convert_float_to_float16
    except Exception as exc:  # noqa: BLE001
        print(f"[fp16] skip ({exc})", flush=True)
        return False
    print(f"[fp16] {fp32.name} -> {fp16.name}", flush=True)
    model = onnx.load(str(fp32))
    model_fp16 = convert_float_to_float16(model, keep_io_types=True)
    onnx.save(model_fp16, str(fp16))
    return True


def resolve_snapshot(model: str, cache_dir: Path) -> Path:
    from huggingface_hub import snapshot_download

    path = snapshot_download(
        repo_id=model,
        cache_dir=str(cache_dir),
        allow_patterns=[
            "*.json",
            "*.txt",
            "*.model",
            "README.md",
            "*.safetensors",
            "pytorch_model.bin",
            "model.safetensors",
            "preprocessor_config.json",
        ],
    )
    return Path(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="HF model id (PyTorch CTC)")
    parser.add_argument("--out", required=True, type=Path, help="Output pack directory")
    parser.add_argument(
        "--language",
        required=True,
        help="ISO 639-1 language code for the model card (e.g. ko, vi)",
    )
    parser.add_argument(
        "--pack-name",
        default=None,
        help="Display name in README (default: output directory name)",
    )
    parser.add_argument(
        "--license",
        default="apache-2.0",
        help="SPDX license id written into README / assumed for LICENSE file",
    )
    parser.add_argument(
        "--work-dir",
        type=Path,
        default=None,
        help="Scratch directory for optimum export (default: <out>/.export-tmp)",
    )
    parser.add_argument(
        "--skip-fp16",
        action="store_true",
        help="Do not generate onnx/model_fp16.onnx",
    )
    parser.add_argument(
        "--skip-int8",
        action="store_true",
        help="Do not generate onnx/model_int8.onnx",
    )
    args = parser.parse_args()

    out_dir: Path = args.out.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    onnx_dir = out_dir / "onnx"
    onnx_dir.mkdir(parents=True, exist_ok=True)

    work_dir = (args.work_dir or (out_dir / ".export-tmp")).resolve()
    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True)

    cache_dir = out_dir.parent / ".hf-cache"
    cache_dir.mkdir(parents=True, exist_ok=True)

    print(f"[snapshot] {args.model}", flush=True)
    snapshot = resolve_snapshot(args.model, cache_dir)
    copy_sidecars(snapshot, out_dir)

    # Optimum export (fp32) — prefer venv's optimum-cli next to this interpreter.
    optimum_cli = Path(sys.executable).with_name("optimum-cli")
    if not optimum_cli.is_file():
        raise FileNotFoundError(
            f"optimum-cli not found next to {sys.executable}; "
            "install optimum[onnxruntime] in this environment"
        )
    print(f"[optimum] export {args.model}", flush=True)
    run(
        [
            str(optimum_cli),
            "export",
            "onnx",
            "--model",
            args.model,
            "--task",
            "automatic-speech-recognition",
            "--framework",
            "pt",
            str(work_dir),
        ]
    )

    exported = find_exported_onnx(work_dir)
    fp32 = onnx_dir / "model.onnx"
    shutil.copy2(exported, fp32)
    print(f"[onnx] wrote {fp32} ({fp32.stat().st_size} bytes)", flush=True)

    # Copy any sidecars optimum may have written that we missed
    copy_sidecars(work_dir, out_dir)

    if not args.skip_fp16:
        convert_fp16(fp32, onnx_dir / "model_fp16.onnx")

    if not args.skip_int8:
        quantize_int8(fp32, onnx_dir / "model_int8.onnx")
        print(
            f"[onnx] wrote model_int8.onnx ({(onnx_dir / 'model_int8.onnx').stat().st_size} bytes)",
            flush=True,
        )

    # LICENSE
    license_path = out_dir / "LICENSE"
    if args.license == "apache-2.0":
        print(f"[license] download {APACHE_LICENSE_URL}", flush=True)
        download(APACHE_LICENSE_URL, license_path)
    else:
        license_path.write_text(
            f"License: {args.license}\nSee upstream model card for {args.model}.\n",
            encoding="utf-8",
        )

    pack_name = args.pack_name or out_dir.name
    write_readme(
        out_dir,
        model_id=pack_name,
        base_model=args.model,
        language=args.language,
        license_spdx=args.license,
    )

    # Ship the exporter next to the pack for HF upload / reproducibility.
    script_src = Path(__file__).resolve()
    script_dst = out_dir / script_src.name
    if script_src != script_dst:
        shutil.copy2(script_src, script_dst)

    # Small manifest for local bookkeeping (not required by HF)
    manifest = {
        "base_model": args.model,
        "language": args.language,
        "license": args.license,
        "export_script": script_src.name,
        "files": sorted(
            str(p.relative_to(out_dir))
            for p in out_dir.rglob("*")
            if p.is_file() and ".export-tmp" not in p.parts
        ),
    }
    (out_dir / "export_manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )

    # Cleanup scratch (keep hf cache)
    shutil.rmtree(work_dir, ignore_errors=True)

    print(f"[done] pack ready at {out_dir}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
