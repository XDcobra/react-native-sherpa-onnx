"""Host-side 3D M-RoPE indices (PaddleOCR-VL get_rope_index, numpy)."""

from __future__ import annotations

import numpy as np

from constants import IMAGE_TOKEN_ID, SPATIAL_MERGE, VISION_START_TOKEN_ID


def rope_index_numpy(
    input_ids: np.ndarray,
    image_grid_thw: np.ndarray,
    attention_mask: np.ndarray | None = None,
    image_token_id: int = IMAGE_TOKEN_ID,
    vision_start_token_id: int = VISION_START_TOKEN_ID,
    spatial_merge: int = SPATIAL_MERGE,
) -> tuple[np.ndarray, int]:
    """Return position_ids [3, B, S] and a scalar rope delta for decode steps."""
    ids = np.asarray(input_ids, dtype=np.int64)
    if ids.ndim == 1:
        ids = ids[None, :]
    batch, seq = ids.shape
    grid = np.asarray(image_grid_thw, dtype=np.int64).reshape(-1, 3)
    if attention_mask is None:
        attention_mask = np.ones((batch, seq), dtype=np.int64)
    else:
        attention_mask = np.asarray(attention_mask, dtype=np.int64)
        if attention_mask.ndim == 1:
            attention_mask = attention_mask[None, :]

    position_ids = np.ones((3, batch, seq), dtype=np.int64)
    delta = 0
    image_index = 0
    for b in range(batch):
        valid = ids[b, attention_mask[b] == 1]
        tokens = valid.tolist()
        llm_pos: list[np.ndarray] = []
        st = 0
        n_image = int(grid.shape[0])
        _ = vision_start_token_id  # used by the HF original; span scan is enough here
        for _ in range(n_image):
            try:
                ed = tokens.index(image_token_id, st)
            except ValueError:
                break
            t, h, w = (int(grid[image_index, 0]), int(grid[image_index, 1]), int(grid[image_index, 2]))
            image_index += 1
            llm_grid_t = t
            llm_grid_h = h // spatial_merge
            llm_grid_w = w // spatial_merge
            text_len = ed - st
            st_idx = int(llm_pos[-1].max()) + 1 if llm_pos else 0
            llm_pos.append(np.arange(text_len, dtype=np.int64).reshape(1, -1).repeat(3, axis=0) + st_idx)
            t_index = np.zeros(llm_grid_t * llm_grid_h * llm_grid_w, dtype=np.int64)
            h_index = np.repeat(np.arange(llm_grid_h, dtype=np.int64), llm_grid_w)
            h_index = np.tile(h_index, llm_grid_t)
            w_index = np.tile(np.arange(llm_grid_w, dtype=np.int64), llm_grid_t * llm_grid_h)
            vision = np.stack([t_index, h_index, w_index], axis=0) + text_len + st_idx
            llm_pos.append(vision)
            st = ed + llm_grid_t * llm_grid_h * llm_grid_w
        if st < len(tokens):
            st_idx = int(llm_pos[-1].max()) + 1 if llm_pos else 0
            text_len = len(tokens) - st
            llm_pos.append(np.arange(text_len, dtype=np.int64).reshape(1, -1).repeat(3, axis=0) + st_idx)
        if not llm_pos:
            llm_pos.append(np.arange(len(tokens), dtype=np.int64).reshape(1, -1).repeat(3, axis=0))
        llm_positions = np.concatenate(llm_pos, axis=1)
        mask = attention_mask[b] == 1
        position_ids[:, b, mask] = llm_positions
        delta = int(llm_positions.max()) + 1 - seq
    return position_ids, delta


def decode_position_ids(past_len: int, rope_delta: int, seq: int = 1) -> np.ndarray:
    """3D position ids for a decode step (same t/h/w, offset by rope delta)."""
    pos = np.arange(seq, dtype=np.int64) + past_len + rope_delta
    return np.stack([pos, pos, pos], axis=0)[:, None, :]
