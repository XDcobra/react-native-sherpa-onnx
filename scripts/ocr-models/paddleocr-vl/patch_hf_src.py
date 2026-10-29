"""Make the 1.6 snapshot load on transformers 4.57 (create_causal_mask kwarg)."""

from __future__ import annotations

from pathlib import Path

from paths import HF_SRC

OLD = "            inputs_embeds=inputs_embeds,\n            attention_mask=attention_mask,\n            past_key_values=past_key_values,"
NEW = "            input_embeds=inputs_embeds,\n            attention_mask=attention_mask,\n            past_key_values=past_key_values,"


def apply_causal_mask_patch() -> None:
    path = HF_SRC / "modeling_paddleocr_vl.py"
    text = path.read_text(encoding="utf-8")
    if OLD not in text:
        return
    path.write_text(text.replace(OLD, NEW, 1), encoding="utf-8")
    print(f"[patch] create_causal_mask input_embeds in {path}", flush=True)
