/**
 * Bundled PDF fixtures for the OCR example (text-layer vs scan-only paths).
 * - Android: example/android/app/src/main/assets/test_pdfs/
 * - iOS: example/ios/sherpa_models/test_pdfs/ (copied into the app bundle at build time)
 */

export const TEST_PDF_FILES = {
  DIGITAL_HELLO: 'test_pdfs/digital_hello.pdf',
  SCAN_ONLY_PAGE: 'test_pdfs/scan_only_page.pdf',
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
    description: 'Native text layer → extractPdfTextLayer succeeds',
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
];
