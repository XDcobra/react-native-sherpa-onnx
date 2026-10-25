import { useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { PdfErrorCode } from 'react-native-sherpa-onnx/pdf';
import { styles } from './OCRScreen.styles';

type Props = {
  pdfiumOn: boolean | null;
};

const MATRIX: {
  path: string;
  text: string;
  spans: string;
  coords: string;
  overlay: string;
}[] = [
  {
    path: 'Image',
    text: 'yes · ocr',
    spans: 'yes',
    coords: 'pixels+frameIndex',
    overlay: 'FrameView yes',
  },
  {
    path: 'PDF + text layer',
    text: 'yes · textLayer',
    spans: 'yes',
    coords: 'PDF user-space',
    overlay: 'list only',
  },
  {
    path: 'PDF scan-only',
    text: 'yes · ocr',
    spans: 'yes',
    coords: 'pixels+frameIndex',
    overlay: 'FrameView yes',
  },
];

function PathCard({
  title,
  when,
  steps,
  textBuffer,
  spans,
  example,
}: {
  title: string;
  when: string;
  steps: string;
  textBuffer: string;
  spans: string;
  example: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.pathCard}>
      <TouchableOpacity
        style={styles.pathCardHeader}
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <Text style={styles.pathCardTitle}>{title}</Text>
        <Text style={styles.pathCardChevron}>{open ? '▾' : '▸'}</Text>
      </TouchableOpacity>
      {open ? (
        <View style={styles.pathCardBody}>
          <Text style={styles.pathCardLine}>
            <Text style={styles.pathCardLabel}>When </Text>
            {when}
          </Text>
          <Text style={styles.pathCardMono}>{steps}</Text>
          <Text style={styles.pathCardLine}>
            <Text style={styles.pathCardLabel}>TextBuffer </Text>
            {textBuffer}
          </Text>
          <Text style={styles.pathCardLine}>
            <Text style={styles.pathCardLabel}>Spans </Text>
            {spans}
          </Text>
          <Text style={styles.pathCardLine}>
            <Text style={styles.pathCardLabel}>This example </Text>
            {example}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Developer legend: what each input path can produce (matrix) and how (cards).
 */
export function OcrInputPathLegend({ pdfiumOn }: Props) {
  const badge =
    pdfiumOn === false ? ' · PDFium off' : pdfiumOn ? ' · PDFium on' : '';

  return (
    <View style={styles.compareFrame}>
      <Text style={styles.compareTitle}>Input paths{badge}</Text>
      <Text style={styles.sectionHint}>
        Which SDK path applies, and whether spans have coordinates you can
        overlay.
      </Text>

      <View style={styles.compareTable}>
        <View style={[styles.compareRow, styles.compareHeaderRow]}>
          <Text style={[styles.matrixCell, styles.matrixPathCol]}>Path</Text>
          <Text style={styles.matrixCell}>Text</Text>
          <Text style={styles.matrixCell}>Spans</Text>
          <Text style={styles.matrixCell}>Coords</Text>
          <Text style={styles.matrixCell}>Overlay</Text>
        </View>
        {MATRIX.map((row, index) => (
          <View
            key={row.path}
            style={[
              styles.compareRow,
              index === MATRIX.length - 1 ? { borderBottomWidth: 0 } : null,
            ]}
          >
            <Text style={[styles.matrixCell, styles.matrixPathCol]}>
              {row.path}
            </Text>
            <Text style={styles.matrixCell}>{row.text}</Text>
            <Text style={styles.matrixCell}>{row.spans}</Text>
            <Text style={styles.matrixCell}>{row.coords}</Text>
            <Text style={styles.matrixCell}>{row.overlay}</Text>
          </View>
        ))}
      </View>

      <View style={styles.pathCardList}>
        <PathCard
          title="1. Image (1+ files)"
          when="PNG/JPEG/etc., including Multi-frame — 3 pages (EN+DE+ZH)."
          steps={
            '1. createOfflineImageBufferFromFiles\n2. recognize(buffer, textOut) — omit frames → all frames'
          }
          textBuffer="origin=ocr"
          spans="yes · quad in decoded ImageBuffer pixels + frameIndex"
          example="FrameView preview; overlay boxes on the current page."
        />
        <PathCard
          title="2. PDF + text layer"
          when="Digital — Hello / Digital — 3 pages (native PDF text)."
          steps={
            '1. extractPdfTextLayer(source, textOut, { pages: "all" })\nRaster is not required for extract.'
          }
          textBuffer="origin=textLayer · no OCR engine"
          spans="yes · quad in PDF user-space (y-down, pageNumber / pageWidth / pageHeight)"
          example="Pick still rasterizes lazy-lru for FrameView preview only. Overlay list-only (wrong space for FrameView)."
        />
        <PathCard
          title="3. PDF scan-only"
          when="Scan-only page / Scan-only — 3 pages (image-only PDF)."
          steps={`1. extractPdfTextLayer → ${PdfErrorCode.NO_TEXT_LAYER}\n2. rasterizePdfPages (lazy-lru if multi-page; rasterize-all if 1 page)\n3. recognize(buffer, textOut) — omit frames → all pages`}
          textBuffer="origin=ocr"
          spans="yes · quad in decoded raster pixels + frameIndex"
          example="FrameView preview; overlay boxes on the current page. Recognize onProgress walks every frame."
        />
      </View>
    </View>
  );
}
