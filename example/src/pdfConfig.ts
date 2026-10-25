/**
 * Bundled PDF fixtures for the OCR example (text-layer vs scan-only paths).
 * - Android: example/android/app/src/main/assets/test_pdfs/
 * - iOS: example/ios/sherpa_models/test_pdfs/ (copied into the app bundle at build time)
 */

export const TEST_PDF_FILES = {
  DIGITAL_HELLO: 'test_pdfs/digital_hello.pdf',
  DIGITAL_MULTIPAGE: 'test_pdfs/digital_multipage.pdf',
  SCAN_ONLY_PAGE: 'test_pdfs/scan_only_page.pdf',
  SCAN_ONLY_MULTIPAGE: 'test_pdfs/scan_only_multipage.pdf',
} as const;

export type PdfFileId = (typeof TEST_PDF_FILES)[keyof typeof TEST_PDF_FILES];

export type PdfFileInfo = {
  id: PdfFileId;
  name: string;
  description: string;
  /** Expected outcome for the example probe. */
  expect: 'textLayer' | 'noTextLayer';
  section?: string;
};

export const PDF_FILES: PdfFileInfo[] = [
  {
    id: TEST_PDF_FILES.DIGITAL_HELLO,
    name: 'Digital — Hello',
    description: 'Native text layer → extract boxes on the preview',
    expect: 'textLayer',
    section: 'Text layer',
  },
  {
    id: TEST_PDF_FILES.DIGITAL_MULTIPAGE,
    name: 'Digital — 3 pages',
    description:
      'Text layer + 3 pages → extract boxes on lazy-lru preview (OCR still all frames)',
    expect: 'textLayer',
    section: 'Text layer',
  },
  {
    id: TEST_PDF_FILES.SCAN_ONLY_PAGE,
    name: 'Scan-only page',
    description: 'Image-only → ERR_PDF_NO_TEXT_LAYER (no OCR fallback)',
    expect: 'noTextLayer',
    section: 'No text layer',
  },
  {
    id: TEST_PDF_FILES.SCAN_ONLY_MULTIPAGE,
    name: 'Scan-only — 3 pages',
    description:
      'Image-only ×3 → NO_TEXT_LAYER → lazy-lru rasterize → OCR all frames',
    expect: 'noTextLayer',
    section: 'No text layer',
  },
];
