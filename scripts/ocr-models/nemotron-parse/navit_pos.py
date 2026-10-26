"""Content-normalized NaViT positional interpolation.

Mirrors ``hf_prefix_geometry._normalized_2d_position_pages`` so host-side
ORT inference can stay bit-close to Transformers without putting the
dynamic Resize into the vision graph.
"""

from __future__ import annotations

import numpy as np
import torch
from torch.nn import functional as F

from constants import PATCH_SIZE, POS_GRID


def add_navit_positions_torch(
    patches: torch.Tensor,
    pos_embed: torch.Tensor,
    image_size: tuple[int, int],
    content_size: tuple[int, int],
) -> torch.Tensor:
    """``patches`` is ``[1, N, 1152]`` after the patch Linear."""
    height, width = int(image_size[0]), int(image_size[1])
    if height % PATCH_SIZE or width % PATCH_SIZE:
        raise ValueError(f"image size {(height, width)} is not aligned to {PATCH_SIZE}")
    rows, cols = height // PATCH_SIZE, width // PATCH_SIZE
    if int(patches.shape[1]) != rows * cols:
        raise ValueError(
            f"expected {rows * cols} patches, got {int(patches.shape[1])}"
        )
    positions = interpolate_pos_grid(
        pos_embed,
        rows,
        cols,
        int(content_size[0]),
        int(content_size[1]),
    )
    return patches + positions


def add_navit_positions_numpy(
    patches: np.ndarray,
    pos_embed: np.ndarray,
    image_size: tuple[int, int],
    content_size: tuple[int, int],
) -> np.ndarray:
    """NumPy/ORT host path. Uses torch only as a math library."""
    tensor = add_navit_positions_torch(
        torch.from_numpy(np.asarray(patches, dtype=np.float32)),
        torch.from_numpy(np.asarray(pos_embed, dtype=np.float32)),
        image_size,
        content_size,
    )
    return tensor.detach().cpu().numpy()


def interpolate_pos_grid(
    pos_embed: torch.Tensor,
    rows: int,
    cols: int,
    content_h: int,
    content_w: int,
) -> torch.Tensor:
    """Return ``[1, rows*cols, 1152]`` interpolated positions for one page."""
    positional_grid = pos_embed.reshape(1, POS_GRID, POS_GRID, -1).permute(0, 3, 1, 2)
    content_rows = (content_h + PATCH_SIZE - 1) // PATCH_SIZE
    content_cols = (content_w + PATCH_SIZE - 1) // PATCH_SIZE
    if min(content_rows, content_cols) == 1:
        page_positions = F.adaptive_avg_pool2d(
            positional_grid.float(), (content_rows, content_cols)
        )
    else:
        page_positions = F.interpolate(
            positional_grid.float(),
            size=(content_rows, content_cols),
            mode="bilinear",
            align_corners=False,
            antialias=True,
        )
    row_starts = torch.arange(rows, device=pos_embed.device, dtype=torch.float32) * PATCH_SIZE
    col_starts = torch.arange(cols, device=pos_embed.device, dtype=torch.float32) * PATCH_SIZE
    row_extents = (content_h - row_starts).clamp(min=0.0, max=float(PATCH_SIZE))
    col_extents = (content_w - col_starts).clamp(min=0.0, max=float(PATCH_SIZE))
    normalized_y = (row_starts + 0.5 * row_extents).clamp(max=float(content_h)) / float(
        content_h
    )
    normalized_x = (col_starts + 0.5 * col_extents).clamp(max=float(content_w)) / float(
        content_w
    )
    grid_y, grid_x = torch.meshgrid(normalized_y, normalized_x, indexing="ij")
    sampling_grid = torch.stack((2.0 * grid_x - 1.0, 2.0 * grid_y - 1.0), dim=-1)
    page_positions = F.grid_sample(
        page_positions,
        sampling_grid.unsqueeze(0),
        mode="bilinear",
        padding_mode="border",
        align_corners=False,
    )
    return page_positions.flatten(2).permute(0, 2, 1).to(dtype=pos_embed.dtype)
