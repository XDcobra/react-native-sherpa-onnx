"""Deterministic synthetic OCR fixtures for the Phase 0 evidence gate."""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from gate_paths import CATALOG_PATH, IMAGE_DIR, REPO_ROOT

_FONT_CANDIDATES = (
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in _FONT_CANDIDATES:
        if Path(path).is_file():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def _bbox(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, fnt) -> dict[str, int]:
    box = draw.textbbox(xy, text, font=fnt)
    return {
        "x": int(box[0]),
        "y": int(box[1]),
        "width": int(box[2] - box[0]),
        "height": int(box[3] - box[1]),
    }


def _save(image: Image.Image, name: str) -> Path:
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    path = IMAGE_DIR / f"{name}.png"
    image.save(path)
    return path


def make_page(index: int, title: str, paragraphs: list[str]) -> tuple[Image.Image, dict]:
    width, height = 900, 1200
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    title_font = font(36)
    body = font(20)
    small = font(16)
    y = 48
    draw.text((48, y), title, fill="black", font=title_font)
    region = _bbox(draw, (48, y), title, title_font)
    y += 64
    draw.text((48, y), f"Fixture page {index:02d}", fill="#333333", font=small)
    y += 48
    for paragraph in paragraphs:
        draw.text((48, y), paragraph, fill="black", font=body)
        y += 40
    y += 24
    draw.text((48, y), "Shift summary", fill="black", font=title_font)
    y += 48
    headers = ["Shift", "Units", "Rejects"]
    rows = [["Mon AM", "3210", "14"], ["Mon PM", "2980", "21"], ["Tue AM", "3440", "9"]]
    col_x = [48, 280, 480]
    for i, header in enumerate(headers):
        draw.text((col_x[i], y), header, fill="black", font=body)
    y += 32
    draw.line((48, y, width - 48, y), fill="black", width=1)
    y += 12
    for row in rows:
        for i, cell in enumerate(row):
            draw.text((col_x[i], y), cell, fill="black", font=body)
        y += 32
    return image, {
        "kind": "page",
        "width": width,
        "height": height,
        "region": region,
        "expected_text": title,
    }


def make_table(index: int, rows: list[list[str]]) -> tuple[Image.Image, dict]:
    width, height = 720, 360
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    fnt = font(22)
    y = 32
    col_x = [32, 220, 420, 560]
    headers = rows[0]
    for i, header in enumerate(headers):
        draw.text((col_x[i], y), header, fill="black", font=fnt)
    y += 36
    draw.line((24, y, width - 24, y), fill="black", width=2)
    y += 12
    for row in rows[1:]:
        for i, cell in enumerate(row):
            draw.text((col_x[i], y), cell, fill="black", font=fnt)
        y += 40
    return image, {"kind": "table", "width": width, "height": height, "index": index}


def make_formula(index: int, text: str) -> tuple[Image.Image, dict]:
    width, height = 640, 180
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    fnt = font(48)
    draw.text((40, 56), text, fill="black", font=fnt)
    return image, {
        "kind": "formula",
        "width": width,
        "height": height,
        "expected_text": text,
        "index": index,
    }


def make_code(index: int, lines: list[str]) -> tuple[Image.Image, dict]:
    width, height = 720, 320
    image = Image.new("RGB", (width, height), "#f7f7f7")
    draw = ImageDraw.Draw(image)
    fnt = font(22)
    y = 32
    for line in lines:
        draw.text((32, y), line, fill="black", font=fnt)
        y += 36
    return image, {"kind": "code", "width": width, "height": height, "index": index}


def make_chart(index: int, values: list[tuple[str, int]]) -> tuple[Image.Image, dict]:
    width, height = 720, 420
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    title = font(24)
    body = font(18)
    draw.text((32, 16), f"Units by day {index}", fill="black", font=title)
    origin_x, origin_y = 80, 360
    max_v = max(v for _, v in values) or 1
    bar_w = 80
    gap = 40
    for i, (label, value) in enumerate(values):
        x = origin_x + i * (bar_w + gap)
        bar_h = int(value / max_v * 220)
        draw.rectangle((x, origin_y - bar_h, x + bar_w, origin_y), outline="black", width=2)
        draw.text((x, origin_y + 8), label, fill="black", font=body)
        draw.text((x + 8, origin_y - bar_h - 24), str(value), fill="black", font=body)
    draw.line((origin_x - 16, origin_y, width - 32, origin_y), fill="black", width=2)
    return image, {"kind": "chart", "width": width, "height": height, "index": index}


def make_seal(index: int, org: str) -> tuple[Image.Image, dict]:
    size = 400
    image = Image.new("RGB", (size, size), "white")
    draw = ImageDraw.Draw(image)
    draw.ellipse((24, 24, size - 24, size - 24), outline="#aa0000", width=8)
    draw.ellipse((48, 48, size - 48, size - 48), outline="#aa0000", width=3)
    fnt = font(28)
    draw.text((90, 170), org, fill="#aa0000", font=fnt)
    draw.text((120, 220), f"SEAL {index:02d}", fill="#aa0000", font=font(22))
    return image, {"kind": "seal", "width": size, "height": size, "expected_text": org}


def make_spotting(index: int, lines: list[tuple[int, int, str]]) -> tuple[Image.Image, dict]:
    width, height = 800, 600
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    fnt = font(18)
    boxes = []
    for x, y, text in lines:
        draw.text((x, y), text, fill="black", font=fnt)
        boxes.append({"text": text, **_bbox(draw, (x, y), text, fnt)})
    return image, {
        "kind": "spotting",
        "width": width,
        "height": height,
        "index": index,
        "boxes": boxes,
    }


def generate_all() -> dict[str, dict]:
    catalog: dict[str, dict] = {}

    pages = [
        (
            "Quarterly Operations Report",
            [
                "Inbound shipments were inspected on arrival.",
                "The packing line ran 18 shifts this week.",
                "Customer returns concentrated on carton damage.",
            ],
        ),
        (
            "Laboratory Safety Briefing",
            [
                "Wear gloves before opening solvent cabinets.",
                "Record every spill in the yellow log book.",
                "Evacuation maps are posted beside each stairwell.",
            ],
        ),
        (
            "Harbor Traffic Summary",
            [
                "Three bulk carriers docked before noon.",
                "Tug availability dropped after the fog advisory.",
                "Pilot boats remained on station until 21:00.",
            ],
        ),
    ]
    for i, (title, paragraphs) in enumerate(pages, start=1):
        image, meta = make_page(i, title, paragraphs)
        name = f"page_{i:02d}"
        path = _save(image, name)
        catalog[name] = {**meta, "path": str(path), "id": name}

    tables = [
        [["Item", "Qty", "Price"], ["Bolts", "120", "4.50"], ["Nuts", "240", "1.20"], ["Washers", "400", "0.40"]],
        [["City", "Temp", "Wind"], ["Hamburg", "12C", "NW 8"], ["Oslo", "4C", "E 3"], ["Lisbon", "19C", "SW 11"]],
        [["Code", "Status", "Owner"], ["A-17", "Open", "Lee"], ["B-04", "Closed", "Patel"], ["C-22", "Hold", "Ng"]],
    ]
    for i, rows in enumerate(tables, start=1):
        image, meta = make_table(i, rows)
        name = f"table_{i:02d}"
        path = _save(image, name)
        catalog[name] = {**meta, "path": str(path), "id": name}

    formulas = ["E = mc^2", "a^2 + b^2 = c^2", "F = ma"]
    for i, text in enumerate(formulas, start=1):
        image, meta = make_formula(i, text)
        name = f"formula_{i:02d}"
        path = _save(image, name)
        catalog[name] = {**meta, "path": str(path), "id": name}

    codes = [
        ["def add(a, b):", "    return a + b", "", "print(add(2, 3))"],
        ["function greet(name) {", "  return `hello ${name}`", "}"],
        ["SELECT id, name", "FROM users", "WHERE active = 1;"],
    ]
    for i, lines in enumerate(codes, start=1):
        image, meta = make_code(i, lines)
        name = f"code_{i:02d}"
        path = _save(image, name)
        catalog[name] = {**meta, "path": str(path), "id": name}

    charts = [
        [("Mon", 12), ("Tue", 18), ("Wed", 9), ("Thu", 21)],
        [("Q1", 40), ("Q2", 55), ("Q3", 33), ("Q4", 70)],
        [("A", 8), ("B", 15), ("C", 11), ("D", 6)],
    ]
    for i, values in enumerate(charts, start=1):
        image, meta = make_chart(i, values)
        name = f"chart_{i:02d}"
        path = _save(image, name)
        catalog[name] = {**meta, "path": str(path), "id": name}

    seals = ["CITY HALL", "PORT AUTH", "UNI SEAL"]
    for i, org in enumerate(seals, start=1):
        image, meta = make_seal(i, org)
        name = f"seal_{i:02d}"
        path = _save(image, name)
        catalog[name] = {**meta, "path": str(path), "id": name}

    spotting_sets = [
        [(40, 40, "Hello World"), (40, 120, "Dock 12"), (300, 300, "Gate B")],
        [(60, 80, "Lot 44"), (200, 240, "Hold"), (480, 420, "Clear")],
        [(32, 200, "Alpha"), (400, 80, "Bravo"), (520, 480, "Charlie")],
    ]
    for i, lines in enumerate(spotting_sets, start=1):
        image, meta = make_spotting(i, lines)
        name = f"spotting_{i:02d}"
        path = _save(image, name)
        catalog[name] = {**meta, "path": str(path), "id": name}

    for entry in catalog.values():
        p = Path(entry["path"])
        try:
            entry["path"] = str(p.resolve().relative_to(REPO_ROOT))
        except ValueError:
            entry["path"] = str(p)

    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    CATALOG_PATH.write_text(json.dumps(catalog, indent=2) + "\n")
    return catalog


def load_catalog() -> dict[str, dict]:
    if not CATALOG_PATH.is_file():
        return generate_all()
    return json.loads(CATALOG_PATH.read_text())


if __name__ == "__main__":
    generated = generate_all()
    print(f"wrote {len(generated)} fixtures under {IMAGE_DIR}")
