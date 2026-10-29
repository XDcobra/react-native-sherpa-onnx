#!/usr/bin/env python3
"""Copy the OmniDoc page and write a perspective-warped camera fixture."""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

from PIL import Image

from infer_ort import make_warp_photo
from paths import PAGES_DIR, REPO_ROOT

NEMOTRON_PAGE = (
    REPO_ROOT
    / "build"
    / "ocr-models"
    / "nemotron-3.5-parse"
    / "pages"
    / "images"
    / "PPT_8076_MEYER_Chapter_2_-_Language_Change_page_014.png"
)
OMNIDOC_NAME = "PPT_8076_MEYER_Chapter_2_-_Language_Change_page_014.png"
PHOTO_NAME = "meyer_page_014_warp.jpg"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--omnidoc", type=Path, default=NEMOTRON_PAGE)
    args = parser.parse_args(argv or sys.argv[1:])
    images = PAGES_DIR / "images"
    images.mkdir(parents=True, exist_ok=True)
    dest_page = images / OMNIDOC_NAME
    if not args.omnidoc.is_file():
        raise FileNotFoundError(
            f"OmniDoc fixture missing at {args.omnidoc}. "
            "Place PPT_8076_MEYER_Chapter_2_-_Language_Change_page_014.png there."
        )
    if dest_page.resolve() != args.omnidoc.resolve():
        shutil.copy2(args.omnidoc, dest_page)
    photo = images / PHOTO_NAME
    warped = make_warp_photo(Image.open(dest_page).convert("RGB"))
    warped.save(photo, quality=88)
    print(f"[fixtures] page={dest_page}")
    print(f"[fixtures] photo={photo} size={warped.size}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
