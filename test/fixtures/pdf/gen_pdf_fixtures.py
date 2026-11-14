#!/usr/bin/env python3
"""Writes the PDF host-test fixtures that exercise the reader's PDF structure.

Standard library only: the PDFs are written object by object (Helvetica text,
outline, document info, page labels, one Flate-compressed RGB image).

    python3 test/fixtures/pdf/gen_pdf_fixtures.py

book.pdf (A4, 6 pages; labels i, ii, 1, 2, 3, 4):
  1  title page: 28 pt title, 14 pt author, no running header
  2  "Preface" (18 pt) + one paragraph
  3  running header + footer "1"; "Chapter One" (20 pt), "The Beginning"
     (14 pt), indented paragraphs, a hyphenated line break, a paragraph that
     continues on the next page
  4  running header + footer "2"; continuation, "Chapter Two", paragraphs
  5  running header + footer "3"; two text columns
  6  image only (no text layer), like a scanned plate
Outline: Preface, Chapter One > The Beginning, Chapter Two, Plates.
Info: Title "A Short Test Book", Author "Ada Example", Lang en-GB.
"""
from __future__ import annotations

import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent

PAGE_W = 595
PAGE_H = 842
MARGIN = 72
TITLE = "A Short Test Book"


def esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


# Helvetica advance widths (AFM, 1/1000 em) for ASCII 32..126, standard encoding.
HELVETICA_WIDTHS = [
    278, 278, 355, 556, 556, 889, 667, 222, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    222, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]


def text_width(s: str, size: float) -> float:
    return sum(HELVETICA_WIDTHS[ord(c) - 32] if 32 <= ord(c) <= 126 else 556
               for c in s) * size / 1000


def wrap(text: str, width: float, size: float, first_indent: float = 0) -> list[str]:
    """Greedy wrap by rendered width, like a typesetter (ragged right)."""
    lines: list[str] = []
    line = ""
    for word in text.split():
        avail = width - (first_indent if not lines else 0)
        candidate = f"{line} {word}" if line else word
        if line and text_width(candidate, size) > avail:
            lines.append(line)
            line = word
        else:
            line = candidate
    if line:
        lines.append(line)
    return lines


class Page:
    def __init__(self) -> None:
        self.ops: list[str] = []
        self.image = False

    def text(self, x: float, y: float, size: float, s: str) -> None:
        self.ops.append(f"BT /F1 {size:g} Tf {x:g} {y:g} Td ({esc(s)}) Tj ET")

    def lines(self, x: float, y: float, size: float, lines: list[str],
              leading: float) -> float:
        for ln in lines:
            self.text(x, y, size, ln)
            y -= leading
        return y

    def paragraph(self, y: float, s: str, *, indent: bool = True,
                  x: float = MARGIN, width: float = PAGE_W - 2 * MARGIN,
                  size: float = 11, leading: float = 15, gap: float = 9,
                  last_line: str | None = None) -> float:
        lines = wrap(s, width, size, 18 if indent else 0)
        if last_line is not None:
            lines.append(last_line)
        for i, ln in enumerate(lines):
            self.text(x + (18 if indent and i == 0 else 0), y, size, ln)
            y -= leading
        return y - gap

    def running(self, number: int) -> None:
        self.text(MARGIN, PAGE_H - 40, 9, TITLE)
        self.text(PAGE_W / 2 - 3, 36, 9, str(number))


BODY = [
    "The lighthouse keeper counted the ships every evening and wrote their "
    "names into a narrow book with a green cover. Most of them passed without "
    "a signal, and some of them never came back.",
    "On the third night of the storm a small boat drifted into the harbour. "
    "Nobody aboard answered the call, but a lamp was burning in the cabin and "
    "a kettle was still warm on the stove.",
]


def build_book() -> list[Page]:
    pages: list[Page] = []

    p = Page()
    p.text(MARGIN, 600, 28, TITLE)
    p.text(MARGIN, 560, 14, "Ada Example")
    pages.append(p)

    p = Page()
    p.text(MARGIN, PAGE_H - 110, 18, "Preface")
    p.paragraph(PAGE_H - 150,
                "This book is a fixture. It has front matter, chapters, a "
                "running header, page numbers, two columns and a plate.",
                indent=False)
    pages.append(p)

    p = Page()
    p.running(1)
    p.text(MARGIN, PAGE_H - 110, 20, "Chapter One")
    p.text(MARGIN, PAGE_H - 140, 14, "The Beginning")
    y = PAGE_H - 175
    y = p.paragraph(y, BODY[0])
    # A word split over two lines with a hyphen.
    y = p.paragraph(y, "The keeper had seen many things in thirty years: "
                    "whales, burning ships and once a balloon that came down "
                    "in the bay. Each of them was an exam-",
                    last_line="ple of how little a single person can know.")
    # Continues on the next page (no final full stop on this page).
    y = p.paragraph(y, BODY[1] + " He climbed down the ladder and walked "
                    "along the pier while the wind pulled at his coat and the",
                    gap=0)
    pages.append(p)

    p = Page()
    p.running(2)
    y = p.paragraph(PAGE_H - 110, "rain came in sideways from the sea.",
                    indent=False)
    p.text(MARGIN, y - 20, 20, "Chapter Two")
    y = p.paragraph(y - 60, "In the morning the boat was gone. Only a rope was "
                    "left on the pier, tied in a knot the keeper did not know.")
    p.paragraph(y, "He kept the rope in the drawer with the book and never "
                "told anyone about it.")
    pages.append(p)

    p = Page()
    p.running(3)
    col_w = 200
    left = ("The first column talks about the harbour. It is narrow and it "
            "ends before the middle of the page so that a reader can tell the "
            "columns apart.")
    right = ("The second column talks about the town. Its lines start on the "
             "right half of the page and run down next to the first column.")
    p.lines(MARGIN, PAGE_H - 110, 11, wrap(left, col_w, 11), 15)
    p.lines(PAGE_W / 2 + 10, PAGE_H - 110, 11, wrap(right, col_w, 11), 15)
    pages.append(p)

    p = Page()
    p.image = True
    p.ops.append(f"q {PAGE_W - 2 * MARGIN} 0 0 {PAGE_H - 2 * MARGIN} "
                 f"{MARGIN} {MARGIN} cm /Im1 Do Q")
    pages.append(p)
    return pages


def image_stream(w: int = 120, h: int = 160) -> bytes:
    rows = bytearray()
    for y in range(h):
        for x in range(w):
            rows += bytes((40 + x, 60 + y // 2, 140))
    return zlib.compress(bytes(rows))


def write_pdf(path: Path, pages: list[Page], *, outline: list | None,
              info: dict[str, str], labels: str | None,
              lang: str | None) -> None:
    objs: list[bytes | None] = []

    def reserve() -> int:
        objs.append(None)
        return len(objs)

    def put(num: int, body: str | bytes) -> None:
        objs[num - 1] = body.encode("latin-1") if isinstance(body, str) else body

    catalog = reserve()
    pages_obj = reserve()
    font = reserve()
    image = reserve() if any(p.image for p in pages) else 0
    page_nums = [reserve() for _ in pages]
    content_nums = [reserve() for _ in pages]

    put(font, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica "
              "/Encoding /WinAnsiEncoding >>")
    if image:
        data = image_stream()
        put(image, b"<< /Type /XObject /Subtype /Image /Width 120 /Height 160 "
                   b"/ColorSpace /DeviceRGB /BitsPerComponent 8 "
                   b"/Filter /FlateDecode /Length " + str(len(data)).encode()
                   + b" >>\nstream\n" + data + b"\nendstream")

    for page, pnum, cnum in zip(pages, page_nums, content_nums):
        content = "\n".join(page.ops).encode("latin-1")
        put(cnum, b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n"
            + content + b"\nendstream")
        res = f"/Font << /F1 {font} 0 R >>"
        if page.image:
            res += f" /XObject << /Im1 {image} 0 R >>"
        put(pnum, f"<< /Type /Page /Parent {pages_obj} 0 R "
                  f"/MediaBox [0 0 {PAGE_W} {PAGE_H}] /Resources << {res} >> "
                  f"/Contents {cnum} 0 R >>")

    kids = " ".join(f"{n} 0 R" for n in page_nums)
    put(pages_obj, f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>")

    extra = ""
    if outline:
        # outline: [(title, page_index, [(child_title, page_index), ...]), ...]
        root = reserve()
        items = [reserve() for _ in outline]
        for i, (title, page_index, children) in enumerate(outline):
            fields = [f"/Title ({esc(title)})", f"/Parent {root} 0 R",
                      f"/Dest [{page_nums[page_index]} 0 R /XYZ 0 {PAGE_H} 0]"]
            if i > 0:
                fields.append(f"/Prev {items[i - 1]} 0 R")
            if i + 1 < len(items):
                fields.append(f"/Next {items[i + 1]} 0 R")
            if children:
                kid_nums = [reserve() for _ in children]
                for j, (ctitle, cpage) in enumerate(children):
                    cf = [f"/Title ({esc(ctitle)})", f"/Parent {items[i]} 0 R",
                          f"/Dest [{page_nums[cpage]} 0 R /XYZ 0 {PAGE_H} 0]"]
                    if j > 0:
                        cf.append(f"/Prev {kid_nums[j - 1]} 0 R")
                    if j + 1 < len(kid_nums):
                        cf.append(f"/Next {kid_nums[j + 1]} 0 R")
                    put(kid_nums[j], "<< " + " ".join(cf) + " >>")
                fields += [f"/First {kid_nums[0]} 0 R",
                           f"/Last {kid_nums[-1]} 0 R",
                           f"/Count {len(kid_nums)}"]
            put(items[i], "<< " + " ".join(fields) + " >>")
        put(root, f"<< /Type /Outlines /First {items[0]} 0 R "
                  f"/Last {items[-1]} 0 R /Count {len(items)} >>")
        extra += f" /Outlines {root} 0 R /PageMode /UseOutlines"
    if labels:
        extra += f" /PageLabels {labels}"
    if lang:
        extra += f" /Lang ({esc(lang)})"
    put(catalog, f"<< /Type /Catalog /Pages {pages_obj} 0 R{extra} >>")

    info_obj = reserve()
    put(info_obj, "<< " + " ".join(f"/{k} ({esc(v)})" for k, v in info.items())
        + " >>")

    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        assert body is not None, f"object {i} not written"
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (f"trailer\n<< /Size {len(objs) + 1} /Root {catalog} 0 R "
            f"/Info {info_obj} 0 R >>\nstartxref\n{xref}\n%%EOF\n").encode()
    path.write_bytes(bytes(out))


def main() -> None:
    write_pdf(
        HERE / "book.pdf",
        build_book(),
        outline=[("Preface", 1, []),
                 ("Chapter One", 2, [("The Beginning", 2)]),
                 ("Chapter Two", 3, []),
                 ("Plates", 5, [])],
        info={"Title": TITLE, "Author": "Ada Example",
              "Producer": "gen_pdf_fixtures.py"},
        labels="<< /Nums [0 << /S /r >> 2 << /S /D /St 1 >>] >>",
        lang="en-GB",
    )


if __name__ == "__main__":
    main()
