// Writes book_scan.pdf: the pages of book.pdf as images only (no text layer),
// like a scanned book. macOS only (CoreGraphics).
//
//     swift test/fixtures/pdf/gen_book_scan.swift
//
// Each page is rendered in 8-bit gray at 150 dpi and placed full-page in a new
// PDF with the same page size; the scan has no text, outline or page labels.
import CoreGraphics
import Foundation

let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let input = here.appendingPathComponent("book.pdf")
let output = here.appendingPathComponent("book_scan.pdf")
let dpi: CGFloat = 150

guard let doc = CGPDFDocument(input as CFURL) else {
  fatalError("Cannot open \(input.path)")
}
var firstBox = doc.page(at: 1)!.getBoxRect(.mediaBox)
guard let out = CGContext(output as CFURL, mediaBox: &firstBox, nil) else {
  fatalError("Cannot write \(output.path)")
}
for n in 1...doc.numberOfPages {
  let page = doc.page(at: n)!
  var box = page.getBoxRect(.mediaBox)
  let scale = dpi / 72
  let w = Int((box.width * scale).rounded())
  let h = Int((box.height * scale).rounded())
  let bitmap = CGContext(
    data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
  bitmap.setFillColor(gray: 1, alpha: 1)
  bitmap.fill(CGRect(x: 0, y: 0, width: w, height: h))
  bitmap.scaleBy(x: scale, y: scale)
  bitmap.drawPDFPage(page)
  let image = bitmap.makeImage()!
  out.beginPage(mediaBox: &box)
  out.draw(image, in: box)
  out.endPage()
}
out.closePDF()
print("wrote \(output.path) (\(doc.numberOfPages) pages)")
