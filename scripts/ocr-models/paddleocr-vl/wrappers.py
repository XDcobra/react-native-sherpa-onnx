"""ONNX-friendly wrappers around PaddleOCR-VL-1.6 (NaViT + ERNIE-4.5)."""

from __future__ import annotations

import torch
from torch import nn
from torch.nn import functional as F

from constants import (
    DECODER_WIDTH,
    HEAD_DIM,
    MROPE_SECTION,
    NUM_ATTENTION_HEADS,
    NUM_DECODER_LAYERS,
    NUM_KV_HEADS,
    POS_GRID,
    SPATIAL_MERGE,
    VISION_HIDDEN,
)


def rotate_half(x: torch.Tensor) -> torch.Tensor:
    x1 = x[..., : x.shape[-1] // 2]
    x2 = x[..., x.shape[-1] // 2 :]
    return torch.cat((-x2, x1), dim=-1)


def apply_vision_rope(q: torch.Tensor, k: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor):
    cos = cos.unsqueeze(-2)
    sin = sin.unsqueeze(-2)
    q_embed = (q * cos) + (rotate_half(q) * sin)
    k_embed = (k * cos) + (rotate_half(k) * sin)
    return q_embed, k_embed


def apply_mrope(q: torch.Tensor, k: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor):
    """Apply Qwen2-VL style M-RoPE. ``cos``/``sin`` are ``[3, B, S, D]``.

    Upstream does ``mrope_section * 2`` on a Python list, which *repeats*
    the three widths: ``[16, 24, 24, 16, 24, 24]``, not ``[32, 48, 48]``.
    """
    sections = list(MROPE_SECTION) * 2
    cos_parts = torch.split(cos, sections, dim=-1)
    sin_parts = torch.split(sin, sections, dim=-1)
    cos_m = torch.cat([part[i % 3] for i, part in enumerate(cos_parts)], dim=-1).unsqueeze(1)
    sin_m = torch.cat([part[i % 3] for i, part in enumerate(sin_parts)], dim=-1).unsqueeze(1)
    q_embed = (q * cos_m) + (rotate_half(q) * sin_m)
    k_embed = (k * cos_m) + (rotate_half(k) * sin_m)
    return q_embed, k_embed


class VisionEncoderONNX(nn.Module):
    """NaViT tower + 2×2 projector.

    ``pixel_values``: ``[1, P, 3, 14, 14]``
    ``image_grid_thw``: ``[1, 3]`` (t, h, w) in patch units
    ``image_embeds``: ``[P / 4, 1024]``
    """

    def __init__(self, model):
        super().__init__()
        vision = model.visual.vision_model
        self.patch_embedding = vision.embeddings.patch_embedding
        self.position_embedding = vision.embeddings.position_embedding
        self.encoder_layers = vision.encoder.layers
        self.rotary_pos_emb = vision.encoder.rotary_pos_emb
        self.post_layernorm = vision.post_layernorm
        projector = model.mlp_AR
        self.pre_norm = projector.pre_norm
        self.linear_1 = projector.linear_1
        self.act = projector.act
        self.linear_2 = projector.linear_2
        self.merge = SPATIAL_MERGE
        self.vision_hidden = VISION_HIDDEN
        self.pos_grid = POS_GRID

    def forward(self, pixel_values: torch.Tensor, image_grid_thw: torch.Tensor) -> torch.Tensor:
        batch, num_patches, channels, height, width = pixel_values.shape
        patches = pixel_values.reshape(batch * num_patches, channels, height, width)
        patch_embeds = self.patch_embedding(patches).flatten(-2).squeeze(-1)
        embeddings = patch_embeds.reshape(batch, num_patches, -1)

        t = image_grid_thw[0, 0]
        h = image_grid_thw[0, 1]
        w = image_grid_thw[0, 2]
        pos = self.position_embedding.weight.reshape(1, self.pos_grid, self.pos_grid, -1)
        pos = pos.permute(0, 3, 1, 2)
        pos = F.interpolate(pos, size=(h, w), mode="bilinear", align_corners=False)
        pos = pos.permute(0, 2, 3, 1).reshape(1, -1, embeddings.shape[-1])
        pos = pos.repeat(1, t, 1)
        embeddings = embeddings + pos

        hw = h * w
        image_pids = torch.arange(num_patches, device=pixel_values.device) % hw
        height_ids = torch.div(image_pids, w, rounding_mode="floor")
        width_ids = image_pids % w
        pids = torch.stack([height_ids, width_ids], dim=-1)
        max_grid = torch.max(pids) + 1
        rope_grid = self.rotary_pos_emb(max_grid)
        rope_emb = rope_grid[pids].flatten(1).repeat(1, 2).unsqueeze(0)
        rope_pair = (rope_emb.cos(), rope_emb.sin())
        cu_seqlens = torch.stack(
            (
                torch.zeros((), dtype=torch.int32, device=pixel_values.device),
                torch.full((), num_patches, dtype=torch.int32, device=pixel_values.device),
            )
        )

        hidden = embeddings
        for layer in self.encoder_layers:
            hidden = layer(hidden, None, False, cu_seqlens, rope_pair)[0]
        hidden = self.post_layernorm(hidden).squeeze(0)

        merge = self.merge
        merged_h = torch.div(h, merge, rounding_mode="floor")
        merged_w = torch.div(w, merge, rounding_mode="floor")
        hidden = hidden.reshape(t, merged_h, merge, merged_w, merge, self.vision_hidden)
        hidden = hidden.permute(0, 1, 3, 2, 4, 5).reshape(-1, merge * merge * self.vision_hidden)
        hidden = self.pre_norm(hidden.reshape(-1, self.vision_hidden)).reshape(
            -1, merge * merge * self.vision_hidden
        )
        hidden = self.linear_2(self.act(self.linear_1(hidden)))
        return hidden


class EmbedTokensONNX(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.embed_tokens = model.model.embed_tokens

    def forward(self, input_ids: torch.Tensor) -> torch.Tensor:
        return self.embed_tokens(input_ids)


class DecoderONNX(nn.Module):
    """Merged prefill/decode graph with explicit KV cache.

    ``inputs_embeds``: ``[B, S, 1024]``
    ``attention_mask``: ``[B, past + S]`` (1 = keep)
    ``position_ids``: ``[3, B, S]`` host M-RoPE indices for the current step
    ``past_key_values.{i}.{key,value}``: ``[B, 2, past, 128]``
    """

    def __init__(self, model):
        super().__init__()
        decoder = model.model
        self.layers = decoder.layers
        self.norm = decoder.norm
        self.lm_head = model.lm_head
        self.inv_freq = decoder.rotary_emb.inv_freq
        self.attention_scaling = float(getattr(decoder.rotary_emb, "attention_scaling", 1.0))
        self.num_heads = NUM_ATTENTION_HEADS
        self.num_kv_heads = NUM_KV_HEADS
        self.head_dim = HEAD_DIM
        self.repeat = NUM_ATTENTION_HEADS // NUM_KV_HEADS
        self.scaling = HEAD_DIM**-0.5

    def _rope(self, hidden: torch.Tensor, position_ids: torch.Tensor):
        inv_freq = self.inv_freq.to(device=hidden.device, dtype=torch.float32)
        inv_freq_expanded = inv_freq[None, None, :, None].expand(3, position_ids.shape[1], -1, 1)
        position_ids_expanded = position_ids[:, :, None, :].to(torch.float32)
        freqs = (inv_freq_expanded @ position_ids_expanded).transpose(2, 3)
        emb = torch.cat((freqs, freqs), dim=-1)
        cos = (emb.cos() * self.attention_scaling).to(dtype=hidden.dtype)
        sin = (emb.sin() * self.attention_scaling).to(dtype=hidden.dtype)
        return cos, sin

    def forward(self, inputs_embeds: torch.Tensor, attention_mask: torch.Tensor, position_ids: torch.Tensor, *past):
        if len(past) != NUM_DECODER_LAYERS * 2:
            raise ValueError(f"expected {NUM_DECODER_LAYERS * 2} past tensors, got {len(past)}")
        batch, seq, _ = inputs_embeds.shape
        past_len = past[0].shape[2]
        total_len = past_len + seq
        query_pos = torch.arange(seq, device=inputs_embeds.device) + past_len
        key_pos = torch.arange(total_len, device=inputs_embeds.device)
        causal = key_pos.unsqueeze(0) <= query_pos.unsqueeze(1)
        keep = attention_mask[:, None, None, :].to(dtype=torch.bool)
        allowed = causal.unsqueeze(0).unsqueeze(0) & keep
        attn_bias = torch.zeros(
            batch, 1, seq, total_len, device=inputs_embeds.device, dtype=inputs_embeds.dtype
        )
        attn_bias = attn_bias.masked_fill(~allowed, torch.finfo(inputs_embeds.dtype).min)
        cos, sin = self._rope(inputs_embeds, position_ids)

        hidden = inputs_embeds
        presents = []
        for index, layer in enumerate(self.layers):
            past_key = past[2 * index]
            past_value = past[2 * index + 1]
            residual = hidden
            attn_in = layer.input_layernorm(hidden)
            query = layer.self_attn.q_proj(attn_in).view(batch, seq, self.num_heads, self.head_dim).transpose(1, 2)
            key = layer.self_attn.k_proj(attn_in).view(batch, seq, self.num_kv_heads, self.head_dim).transpose(1, 2)
            value = layer.self_attn.v_proj(attn_in).view(batch, seq, self.num_kv_heads, self.head_dim).transpose(1, 2)
            query, key = apply_mrope(query, key, cos, sin)
            key = torch.cat((past_key, key), dim=2)
            value = torch.cat((past_value, value), dim=2)
            key_rep = key.repeat_interleave(self.repeat, dim=1)
            value_rep = value.repeat_interleave(self.repeat, dim=1)
            scores = torch.matmul(query, key_rep.transpose(2, 3)) * self.scaling
            scores = scores + attn_bias
            probs = torch.softmax(scores, dim=-1, dtype=torch.float32).to(query.dtype)
            attn = torch.matmul(probs, value_rep)
            attn = layer.self_attn.o_proj(attn.transpose(1, 2).reshape(batch, seq, -1))
            hidden = residual + attn
            residual = hidden
            hidden = residual + layer.mlp(layer.post_attention_layernorm(hidden))
            presents.append(key)
            presents.append(value)
        hidden = self.norm(hidden)
        logits = self.lm_head(hidden)
        return (logits, *presents)


def empty_past(batch: int = 1, past_len: int = 0, device=None, dtype=torch.float32):
    zeros = []
    for _ in range(NUM_DECODER_LAYERS):
        zeros.append(torch.zeros(batch, NUM_KV_HEADS, past_len, HEAD_DIM, device=device, dtype=dtype))
        zeros.append(torch.zeros(batch, NUM_KV_HEADS, past_len, HEAD_DIM, device=device, dtype=dtype))
    return zeros


def decoder_input_names():
    names = ["inputs_embeds", "attention_mask", "position_ids"]
    for layer in range(NUM_DECODER_LAYERS):
        names.append(f"past_key_values.{layer}.key")
        names.append(f"past_key_values.{layer}.value")
    return names


def decoder_output_names():
    names = ["logits"]
    for layer in range(NUM_DECODER_LAYERS):
        names.append(f"present.{layer}.key")
        names.append(f"present.{layer}.value")
    return names
