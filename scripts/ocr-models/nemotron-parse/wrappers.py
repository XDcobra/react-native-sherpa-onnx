"""ONNX-friendly wrappers around the Hugging Face Nemotron-3.5-Parse modules."""

from __future__ import annotations

import torch
from torch import nn
from torch.nn import functional as F

from constants import (
    DECODER_WIDTH,
    EMBED_SCALE,
    NUM_CLS_TOKENS,
    NUM_DECODER_LAYERS,
    VISION_WIDTH,
)


class VisionEncoderONNX(nn.Module):
    """ViT + neck. Input patches are already Linear-projected and NaViT-positioned.

    ``patch_tokens``: ``[1, rows, cols, 1152]``
    ``vision``: ``[1, rows * (cols / 4) + 1, 1024]``
    """

    def __init__(self, encoder):
        super().__init__()
        radio = encoder.model_encoder.radio_model
        vit = radio.model
        self.cls_token = vit.patch_generator.cls_token.token
        self.blocks = vit.blocks
        self.summary_idxs = radio.summary_idxs
        self.conv1 = encoder.conv1
        self.layer_norm1 = encoder.layer_norm1
        self.conv2 = encoder.conv2
        self.layer_norm2 = encoder.layer_norm2
        self.sum_proj = encoder.sum_proj
        self.layer_norm3 = encoder.layer_norm3

    def forward(self, patch_tokens: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        rows = patch_tokens.shape[1]
        cols = patch_tokens.shape[2]
        patches = patch_tokens.reshape(1, rows * cols, VISION_WIDTH)
        hidden = torch.cat((self.cls_token.unsqueeze(0), patches), dim=1)
        for block in self.blocks:
            hidden = block(hidden)
        summary = hidden[:, self.summary_idxs].flatten(1)
        features = hidden[:, NUM_CLS_TOKENS:]
        features = self.layer_norm1(self.conv1(features.transpose(1, 2)).transpose(1, 2))
        features = features.transpose(1, 2).reshape(1, DECODER_WIDTH, rows, cols)
        features = self.conv2(features).flatten(2).transpose(1, 2)
        features = self.layer_norm2(features)
        summary = self.layer_norm3(self.sum_proj(summary)).unsqueeze(1)
        vision = torch.cat((features, summary), dim=1)
        mask = torch.ones(vision.shape[0], vision.shape[1], dtype=torch.float32, device=vision.device)
        return vision, mask


class PatchEmbedONNX(nn.Module):
    def __init__(self, encoder):
        super().__init__()
        self.embedder = encoder.model_encoder.radio_model.model.patch_generator.embedder

    def forward(self, patches: torch.Tensor) -> torch.Tensor:
        return self.embedder(patches)


class EmbedTokensONNX(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.embed_tokens = model.decoder.embed_tokens
        self.embed_scale = float(getattr(self.embed_tokens, "embed_scale", EMBED_SCALE))

    def forward(self, input_ids: torch.Tensor) -> torch.Tensor:
        return self.embed_tokens(input_ids)


class GQAAttentionONNX(nn.Module):
    def __init__(self, attn: nn.Module):
        super().__init__()
        self.num_heads = attn.num_heads
        self.num_kv_heads = attn.num_kv_heads
        self.head_dim = attn.head_dim
        self.q_proj = attn.q_proj
        self.k_proj = attn.k_proj
        self.v_proj = attn.v_proj
        self.out_proj = attn.out_proj
        self.repeat = self.num_heads // self.num_kv_heads

    def forward(
        self,
        hidden: torch.Tensor,
        key_mask: torch.Tensor,
        past_key: torch.Tensor,
        past_value: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        batch, length, _ = hidden.shape
        query = self.q_proj(hidden).view(batch, length, self.num_heads, self.head_dim).transpose(1, 2)
        key = self.k_proj(hidden).view(batch, length, self.num_kv_heads, self.head_dim).transpose(1, 2)
        value = self.v_proj(hidden).view(batch, length, self.num_kv_heads, self.head_dim).transpose(1, 2)
        key = torch.cat((past_key, key), dim=2)
        value = torch.cat((past_value, value), dim=2)
        kv_len = key.shape[2]
        past_len = kv_len - length
        query_pos = torch.arange(length, device=hidden.device) + past_len
        key_pos = torch.arange(kv_len, device=hidden.device)
        causal = key_pos.unsqueeze(0) <= query_pos.unsqueeze(1)
        allowed = causal.unsqueeze(0).unsqueeze(0) & key_mask[:, None, None, :].bool()
        attn_bias = torch.zeros(
            batch, self.num_heads, length, kv_len, device=hidden.device, dtype=query.dtype
        )
        attn_bias = attn_bias.masked_fill(~allowed, torch.finfo(query.dtype).min)
        output = F.scaled_dot_product_attention(
            query,
            key.repeat_interleave(self.repeat, dim=1),
            value.repeat_interleave(self.repeat, dim=1),
            attn_mask=attn_bias,
            dropout_p=0.0,
        )
        output = self.out_proj(output.transpose(1, 2).reshape(batch, length, -1))
        return output, key, value


class DecoderLayerONNX(nn.Module):
    def __init__(self, layer: nn.Module):
        super().__init__()
        self.self_attn = GQAAttentionONNX(layer.self_attn)
        self.self_attn_layer_norm = layer.self_attn_layer_norm
        self.final_layer_norm = layer.final_layer_norm
        self.fc1 = layer.fc1
        self.fc2 = layer.fc2

    def forward(self, hidden, key_mask, past_key, past_value):
        attn_out, present_key, present_value = self.self_attn(
            self.self_attn_layer_norm(hidden), key_mask, past_key, past_value
        )
        hidden = hidden + attn_out
        hidden = hidden + self.fc2(F.gelu(self.fc1(self.final_layer_norm(hidden))))
        return hidden, present_key, present_value


class DecoderONNX(nn.Module):
    """Prefill and decode share this graph.

    ``inputs_embeds``: ``[B, S, 1024]``
    ``attention_mask``: ``[B, past + S]`` (1 = keep)
    ``past_key_N`` / ``past_value_N``: ``[B, 8, past, 64]``
    """

    def __init__(self, model):
        super().__init__()
        self.layernorm_embedding = model.decoder.layernorm_embedding
        self.layer_norm = model.decoder.layer_norm
        self.lm_head = model.lm_head
        self.layers = nn.ModuleList([DecoderLayerONNX(layer) for layer in model.decoder.layers])

    def forward(self, inputs_embeds: torch.Tensor, attention_mask: torch.Tensor, *past):
        if len(past) != NUM_DECODER_LAYERS * 2:
            raise ValueError(f"expected {NUM_DECODER_LAYERS * 2} past tensors, got {len(past)}")
        hidden = self.layernorm_embedding(inputs_embeds)
        presents = []
        for index, layer in enumerate(self.layers):
            hidden, present_key, present_value = layer(
                hidden, attention_mask, past[2 * index], past[2 * index + 1]
            )
            presents.append(present_key)
            presents.append(present_value)
        hidden = self.layer_norm(hidden)
        logits = self.lm_head(hidden)
        return (logits, *presents)


def empty_past(batch: int = 1, device=None, dtype=torch.float32):
    zeros = []
    for _ in range(NUM_DECODER_LAYERS):
        zeros.append(torch.zeros(batch, NUM_KV_HEADS, 0, HEAD_DIM, device=device, dtype=dtype))
        zeros.append(torch.zeros(batch, NUM_KV_HEADS, 0, HEAD_DIM, device=device, dtype=dtype))
    return zeros


def decoder_input_names():
    names = ["inputs_embeds", "attention_mask"]
    for layer in range(NUM_DECODER_LAYERS):
        names.append(f"past_key_{layer}")
        names.append(f"past_value_{layer}")
    return names


def decoder_output_names():
    names = ["logits"]
    for layer in range(NUM_DECODER_LAYERS):
        names.append(f"present_key_{layer}")
        names.append(f"present_value_{layer}")
    return names
