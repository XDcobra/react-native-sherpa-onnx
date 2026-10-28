#!/usr/bin/env python3
"""Build committed e-document host-test fixtures next to this script."""

from __future__ import annotations

import base64
import io
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent

PNG = bytes(
    [
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00,
        0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
        0x00, 0x00, 0x03, 0x00, 0x01, 0x18, 0xDD, 0x8D, 0xB4, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ]
)

CONTAINER = """<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

MIXED_OPF = """<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:uuid:north-wind-sun</dc:identifier>
    <dc:title>The North Wind and the Sun</dc:title>
    <dc:creator>VoiceLab fixtures</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="css" href="stylesheet.css" media-type="text/css"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="skip" href="skip.xhtml" media-type="application/xhtml+xml"/>
    <item id="scan" href="scan.xhtml" media-type="application/xhtml+xml"/>
    <item id="img" href="img.png" media-type="image/png"/>
    <item id="ornament" href="ornament.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="skip" linear="no"/>
    <itemref idref="ch2"/>
    <itemref idref="scan"/>
  </spine>
</package>
"""

CH1 = """<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
<head><title>The contest</title>
<style>body { color: red; }</style>
<link rel="stylesheet" href="stylesheet.css"/>
</head>
<body>
<h1>The North Wind and the Sun</h1>
<p>The North Wind and the Sun disputed which was the stronger, while a traveler walked the road wrapped in a warm cloak.</p>
<p>They agreed that the one who first made the traveler take off his cloak should be counted the stronger.</p>
<blockquote><p>Pride, said the Sun, yields where warmth persists.</p></blockquote>
<ul>
<li>Wind: force and bluster</li>
<li>Sun: patience and heat</li>
</ul>
<p>Ruby keeps <ruby><rb>漢</rb><rt>kan</rt></ruby> but drops the annotation.</p>
<p>Café naïve — an em dash and a line<br/>break stay in the paragraph.</p>
<img src="ornament.png" alt="decorative chapter flourish"/>
<script>alert(1)</script>
</body></html>
"""

CH2 = """<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
<h2>After the contest</h2>
<p>The North Wind blew with all his might, but the traveler only wrapped his cloak tighter.</p>
<p>Then the Sun shone out warmly, and immediately the traveler took off his cloak.</p>
<pre>score: sun 1
wind 0</pre>
<table><tr><td>Winner</td><td>the Sun</td></tr></table>
<p class="glossary">cloak: a traveler's wrap against the wind.</p>
</body></html>
"""

NAV = """<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body class="hidden-toc"><nav><ol>
<li><a href="ch1.xhtml">The contest</a></li>
<li><a href="ch2.xhtml">After the contest</a></li>
</ol></nav></body></html>
"""

SKIP = """<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Should not appear</p></body></html>
"""

SCAN = """<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
<img src="img.png" alt="photograph of a scanned page" title="scan" aria-label="page"/>
</body></html>
"""

CSS = "body { font-family: serif; }\n.hidden-toc { display: none; }\n"

DRM_XML = """<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">
    <EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
    <CipherData><CipherReference URI="OEBPS/ch1.xhtml"/></CipherData>
  </EncryptedData>
</encryption>
"""

FONT_XML = """<?xml version="1.0"?>
<encryption>
  <EncryptedData>
    <EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
    <CipherData><CipherReference URI="OEBPS/fonts/Body.otf"/></CipherData>
  </EncryptedData>
</encryption>
"""

TEXT_ONLY_OPF = """<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">x</dc:identifier><dc:title>t</dc:title><dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>
"""

TEXT_ONLY_CH1 = """<html><body><h1>Only text</h1><p>A short book with two paragraphs of markup and no spine images.</p><p>extractDocumentImages must fail with ERR_DOC_NO_IMAGES.</p></body></html>
"""

MOBI_HTML = """<html>
<head><title>The North Wind and the Sun</title><style>body{color:red}</style></head>
<body>
<h1>The North Wind and the Sun</h1>
<p>The North Wind and the Sun disputed which was the stronger, while a traveler walked the road wrapped in a warm cloak.</p>
<p>They agreed that the one who first made the traveler take off his cloak should be counted the stronger.</p>
<blockquote><p>Pride, said the Sun, yields where warmth persists.</p></blockquote>
<ul>
<li>Wind: force and bluster</li>
<li>Sun: patience and heat</li>
</ul>
<p>Ruby keeps <ruby><rb>漢</rb><rt>kan</rt></ruby> but drops the annotation.</p>
<p>Café naïve — an em dash and a line<br/>break stay in the paragraph.</p>
<script>shouldNotAppear()</script>
<mbp:pagebreak/>
<h2>After the contest</h2>
<p>The North Wind blew with all his might, but the traveler only wrapped his cloak tighter.</p>
<p>Then the Sun shone out warmly, and immediately the traveler took off his cloak.</p>
<pre>score: sun 1
wind 0</pre>
<table><tr><td>Winner</td><td>the Sun</td></tr></table>
<mbp:pagebreak/>
<img recindex="00001" alt="scan of the moral plate"/>
</body></html>
"""

AZW3_HTML = """<html>
<head><title>The North Wind and the Sun</title></head>
<body>
<h1>The North Wind and the Sun</h1>
<p>The North Wind and the Sun disputed which was the stronger, while a traveler walked the road wrapped in a warm cloak.</p>
<p>They agreed that the one who first made the traveler take off his cloak should be counted the stronger.</p>
<blockquote><p>Pride, said the Sun, yields where warmth persists.</p></blockquote>
<ul>
<li>Wind: force and bluster</li>
<li>Sun: patience and heat</li>
</ul>
<p>Café naïve — an em dash and a line<br/>break stay in the paragraph.</p>
<mbp:pagebreak/>
<h2>After the contest</h2>
<p>The North Wind blew with all his might, but the traveler only wrapped his cloak tighter.</p>
<p>Then the Sun shone out warmly, and immediately the traveler took off his cloak.</p>
<pre>score: sun 1
wind 0</pre>
<table><tr><td>Winner</td><td>the Sun</td></tr></table>
</body></html>
"""


def mixed_files(extra: list[tuple[str, bytes]] | None = None) -> list[tuple[str, bytes]]:
    files = [
        ("META-INF/container.xml", CONTAINER.encode()),
        ("OEBPS/content.opf", MIXED_OPF.encode()),
        ("OEBPS/stylesheet.css", CSS.encode()),
        ("OEBPS/nav.xhtml", NAV.encode()),
        ("OEBPS/ch1.xhtml", CH1.encode()),
        ("OEBPS/ch2.xhtml", CH2.encode()),
        ("OEBPS/skip.xhtml", SKIP.encode()),
        ("OEBPS/scan.xhtml", SCAN.encode()),
        ("OEBPS/img.png", PNG),
        ("OEBPS/ornament.png", PNG),
    ]
    if extra:
        files.extend(extra)
    return files


def write_epub(path: Path, files: list[tuple[str, bytes]]) -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        for name, data in files:
            zf.writestr(name, data, compress_type=zipfile.ZIP_DEFLATED)
    path.write_bytes(buf.getvalue())


def write_zip(path: Path, files: list[tuple[str, bytes]]) -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files:
            zf.writestr(name, data, compress_type=zipfile.ZIP_STORED)
    path.write_bytes(buf.getvalue())


def fb2_xml() -> str:
    b64 = base64.b64encode(PNG).decode("ascii")
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
  <description>
    <title-info>
      <book-title>The North Wind and the Sun</book-title>
      <author><first-name>VoiceLab</first-name><last-name>Fixtures</last-name></author>
      <lang>en</lang>
    </title-info>
  </description>
  <body>
    <section id="ch1">
      <title><p>The North Wind and the Sun</p></title>
      <epigraph>
        <p>Pride yields where warmth persists.</p>
        <text-author>A fable</text-author>
      </epigraph>
      <p>The North Wind and the Sun disputed which was the stronger, while a traveler walked the road wrapped in a warm cloak.</p>
      <cite><p>They agreed that the one who first made the traveler take off his cloak should be counted the stronger.</p></cite>
      <p>Café naïve — the cloak stayed on until the Sun shone.</p>
    </section>
    <section id="ch2">
      <title><p>After the contest</p></title>
      <poem>
        <v>The wind blew; the cloak stayed.</v>
        <v>The sun shone; the cloak fell.</v>
      </poem>
      <p>Immediately the traveler took off his cloak.</p>
    </section>
    <section id="plate"><image l:href="#pic"/></section>
  </body>
  <binary id="pic" content-type="image/png">{b64}</binary></FictionBook>
"""


def poke16(buf: bytearray, off: int, v: int) -> None:
    buf[off] = (v >> 8) & 0xFF
    buf[off + 1] = v & 0xFF


def poke32(buf: bytearray, off: int, v: int) -> None:
    buf[off] = (v >> 24) & 0xFF
    buf[off + 1] = (v >> 16) & 0xFF
    buf[off + 2] = (v >> 8) & 0xFF
    buf[off + 3] = v & 0xFF


def app16(buf: bytearray, v: int) -> None:
    buf.append((v >> 8) & 0xFF)
    buf.append(v & 0xFF)


def app32(buf: bytearray, v: int) -> None:
    buf.append((v >> 24) & 0xFF)
    buf.append((v >> 16) & 0xFF)
    buf.append((v >> 8) & 0xFF)
    buf.append(v & 0xFF)


def app_var(buf: bytearray, v: int) -> None:
    chunks = []
    x = v
    while True:
        chunks.append(x & 0x7F)
        x >>= 7
        if x == 0 or len(chunks) == 4:
            break
    for i, c in enumerate(reversed(chunks)):
        if i == len(chunks) - 1:
            buf.append(c | 0x80)
        else:
            buf.append(c)


def make_indx_header(n_data: int, tags: list[tuple[int, int, int, int]], n_ctrl: int) -> bytes:
    rec = bytearray(192)
    rec[0:4] = b"INDX"
    poke32(rec, 4, 192)
    poke32(rec, 24, n_data)
    poke32(rec, 28, 65001)
    rec.extend(b"TAGX")
    app32(rec, 12 + len(tags) * 4)
    app32(rec, n_ctrl)
    for tag, num_values, mask, end in tags:
        rec.extend([tag, num_values, mask, end])
    return bytes(rec)


def make_indx_data(rows: list[tuple[str, list[int]]], n_ctrl: int, control_byte: int) -> bytes:
    rec = bytearray(192)
    rec[0:4] = b"INDX"
    poke32(rec, 4, 192)
    poke32(rec, 24, len(rows))
    poke32(rec, 28, 65001)
    offs: list[int] = []
    body = bytearray()
    for name, values in rows:
        offs.append(192 + len(body))
        encoded = name.encode("utf-8")
        body.append(len(encoded))
        body.extend(encoded)
        body.append(control_byte)
        for v in values:
            app_var(body, v)
    rec.extend(body)
    idxt = len(rec)
    rec.extend(b"IDXT")
    for o in offs:
        app16(rec, o)
    poke32(rec, 20, idxt)
    return bytes(rec)


def make_fdst(flows: list[tuple[int, int]]) -> bytes:
    rec = bytearray(12)
    rec[0:4] = b"FDST"
    poke32(rec, 8, len(flows))
    for a, b in flows:
        app32(rec, a)
        app32(rec, b)
    return bytes(rec)


def make_mobi(
    html: str,
    *,
    compression: int = 1,
    encryption: int = 0,
    mobi_type: int = 2,
    version: int = 6,
    encoding: int = 65001,
    fdst: int = 0xFFFFFFFF,
    num_fdst: int = 0,
    frag: int = 0xFFFFFFFF,
    skel: int = 0xFFFFFFFF,
    type8: bytes = b"BOOKMOBI",
    with_mobi_magic: bool = True,
    dictionary_exth: bool = False,
    extra_records: list[bytes] | None = None,
    extra_resource: bytes | None = None,
) -> bytes:
    text = html.encode("utf-8")
    rec_size = 4096
    chunks = [text[i : i + rec_size] for i in range(0, max(len(text), 1), rec_size)] or [b""]
    ntext = len(chunks)
    rec0 = bytearray(256)
    poke16(rec0, 0, compression)
    poke32(rec0, 4, len(text))
    poke16(rec0, 8, ntext)
    poke16(rec0, 10, rec_size)
    poke16(rec0, 12, encryption)
    if with_mobi_magic:
        rec0[16:20] = b"MOBI"
        poke32(rec0, 20, 240)
        poke32(rec0, 24, mobi_type)
        poke32(rec0, 28, encoding)
        poke32(rec0, 36, version)
        extras = extra_records or []
        res_start = 0xFFFFFFFF if extra_resource is None else 1 + ntext + len(extras)
        poke32(rec0, 108, res_start)
        poke32(rec0, 112, 0xFFFFFFFF)
        poke32(rec0, 192, fdst)
        poke32(rec0, 196, num_fdst)
        poke32(rec0, 244, 0xFFFFFFFF)
        poke32(rec0, 248, frag)
        poke32(rec0, 252, skel)
        if dictionary_exth:
            poke32(rec0, 128, 0x40)
            rec0.extend(bytes(24))
            exth = 256
            rec0[exth : exth + 4] = b"EXTH"
            poke32(rec0, exth + 4, 24)
            poke32(rec0, exth + 8, 1)
            poke32(rec0, exth + 12, 403)
            poke32(rec0, exth + 16, 12)
            poke32(rec0, exth + 20, 0)
    recs: list[bytes] = [bytes(rec0)] + chunks
    if extra_records:
        recs.extend(extra_records)
    if extra_resource is not None:
        recs.append(extra_resource)
    nrec = len(recs)
    list_off = 78
    rec0_off = list_off + nrec * 8
    offs = []
    cur = rec0_off
    for r in recs:
        offs.append(cur)
        cur += len(r)
    pdb = bytearray(cur)
    pdb[0:5] = b"HELLO"
    pdb[60:68] = type8
    poke16(pdb, 76, nrec)
    for i, (off, r) in enumerate(zip(offs, recs)):
        poke32(pdb, list_off + i * 8, off)
        pdb[off : off + len(r)] = r
    return bytes(pdb)


def main() -> None:
    write_epub(HERE / "mixed.epub", mixed_files())
    write_epub(
        HERE / "text-only.epub",
        [
            ("META-INF/container.xml", CONTAINER.encode()),
            ("OEBPS/content.opf", TEXT_ONLY_OPF.encode()),
            ("OEBPS/ch1.xhtml", TEXT_ONLY_CH1.encode()),
        ],
    )
    write_epub(
        HERE / "drm.epub",
        mixed_files([("META-INF/encryption.xml", DRM_XML.encode())]),
    )
    write_epub(
        HERE / "font-embed.epub",
        mixed_files(
            [
                ("META-INF/encryption.xml", FONT_XML.encode()),
                ("OEBPS/fonts/Body.otf", b"not-a-real-font"),
            ]
        ),
    )

    fb2 = fb2_xml()
    (HERE / "north-wind.fb2").write_text(fb2, encoding="utf-8")
    write_zip(HERE / "north-wind.fbz", [("book.fb2", fb2.encode())])

    write_zip(
        HERE / "comic.cbz",
        [
            ("ComicInfo.xml", b"<ComicInfo/>"),
            ("page10.png", PNG),
            ("page2.png", PNG),
            (".hidden.png", PNG),
        ],
    )

    (HERE / "tiny.mobi").write_bytes(make_mobi(MOBI_HTML, extra_resource=PNG))
    (HERE / "tiny.azw3").write_bytes(make_mobi(AZW3_HTML, version=8))
    (HERE / "palmdoc.mobi").write_bytes(
        make_mobi(
            "<html><body><h1>PalmDOC chapter</h1>"
            "<p>The North Wind blew, but the traveler kept the cloak on.</p>"
            "<p>Then the Sun shone and the cloak came off.</p></body></html>",
            compression=2,
        )
    )
    (HERE / "drm.mobi").write_bytes(
        make_mobi("<html><body><p>Secret</p></body></html>", encryption=2)
    )
    (HERE / "print-replica.azw4").write_bytes(
        make_mobi("<html><body><p>Print replica</p></body></html>", mobi_type=258)
    )
    (HERE / "audio.mobi").write_bytes(
        make_mobi("<html><body><p>Audio</p></body></html>", mobi_type=4)
    )
    (HERE / "dictionary.mobi").write_bytes(
        make_mobi("<html><body><p>Dict</p></body></html>", dictionary_exth=True)
    )
    (HERE / "palmdoc.pdb").write_bytes(
        make_mobi(
            "<html><body><p>Palm text</p></body></html>",
            with_mobi_magic=False,
            type8=b"TEXtREAd",
        )
    )

    a = (
        "<html><body><h1>Alpha flow</h1><p>The first KF8 flow is a chapter with "
        "a heading and a paragraph.</p></body></html>"
    )
    b = (
        "<html><body><h2>Beta flow</h2><p>The second flow continues the book "
        "after the FDST boundary.</p></body></html>"
    )
    (HERE / "fdst.azw3").write_bytes(
        make_mobi(
            a + b,
            version=8,
            fdst=2,
            num_fdst=2,
            extra_records=[make_fdst([(0, len(a)), (len(a), len(a) + len(b))])],
        )
    )

    skel = "<html><body></body></html>"
    frag = (
        "<h1>KF8 chapter</h1><p>The skeleton is hollow until this fragment "
        "is inserted at the body.</p>"
    )
    skel_tags = [(1, 1, 0x03, 0), (6, 2, 0x0C, 0), (0, 0, 0, 1)]
    frag_tags = [(2, 1, 0x03, 0), (4, 1, 0x0C, 0), (6, 2, 0x30, 0), (0, 0, 0, 1)]
    (HERE / "kf8-skel.azw3").write_bytes(
        make_mobi(
            skel + frag,
            version=8,
            skel=2,
            frag=4,
            extra_records=[
                make_indx_header(1, skel_tags, 1),
                make_indx_data([("skel0", [1, 0, len(skel)])], 1, 0x05),
                make_indx_header(1, frag_tags, 1),
                make_indx_data([("12", [0, 0, 0, len(frag)])], 1, 0x15),
            ],
        )
    )

    (HERE / "truncated.cbr").write_bytes(b"Rar!\x1a\x07\x00\x00")
    (HERE / "not-a-book.pdf").write_bytes(b"%PDF-1.4")
    (HERE / "not-a-book.html").write_bytes(b"<html></html>")
    (HERE / "garbage.bin").write_bytes(bytes([0x00, 0x01, 0x02, 0x03, 0xFF]))

    print("wrote fixtures to", HERE)


if __name__ == "__main__":
    main()
