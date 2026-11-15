import { TEST_PDF_FILES } from './pdfConfig';

export const TEST_EDOC_FILES = {
  HELLO_EPUB: 'test_edocs/hello.epub',
  HELLO_FB2: 'test_edocs/hello.fb2',
  HELLO_MOBI: 'test_edocs/hello.mobi',
  HELLO_AZW3: 'test_edocs/hello.azw3',
  DRM_MOBI: 'test_edocs/drm.mobi',
  MIXED_EPUB: 'test_edocs/mixed.epub',
  MANGA_CBZ: 'test_edocs/manga.cbz',
  STRUCTURE_EPUB: 'test_edocs/structure.epub',
  LONG_EPUB: 'test_edocs/long.epub',
  FRANKENSTEIN_EPUB: 'test_edocs/frankenstein.epub',
} as const;

export type DocumentExtractKind = 'document' | 'pdf';
export type DocumentExpect =
  | 'text'
  | 'noTextLayer'
  | 'mixed'
  | 'imagesOnly'
  | 'drm';

export type DocumentFileInfo = {
  id: string;
  name: string;
  description: string;
  extract: DocumentExtractKind;
  expect: DocumentExpect;
  section?: string;
};

export const DOCUMENT_FILES: DocumentFileInfo[] = [
  {
    id: TEST_EDOC_FILES.HELLO_EPUB,
    name: 'Hello — EPUB',
    description: 'Short text-only EPUB → extractDocumentText → TTS',
    extract: 'document',
    expect: 'text',
    section: 'E-documents',
  },
  {
    id: TEST_EDOC_FILES.HELLO_FB2,
    name: 'Hello — FB2',
    description: 'Short text-only FictionBook → extractDocumentText → TTS',
    extract: 'document',
    expect: 'text',
    section: 'E-documents',
  },
  {
    id: TEST_EDOC_FILES.HELLO_MOBI,
    name: 'Hello — MOBI',
    description: 'DRM-free MOBI6 → extractDocumentText → TTS',
    extract: 'document',
    expect: 'text',
    section: 'E-documents',
  },
  {
    id: TEST_EDOC_FILES.HELLO_AZW3,
    name: 'Hello — AZW3',
    description: 'DRM-free KF8 AZW3 → extractDocumentText → TTS',
    extract: 'document',
    expect: 'text',
    section: 'E-documents',
  },
  {
    id: TEST_EDOC_FILES.DRM_MOBI,
    name: 'DRM — MOBI',
    description: 'Kindle encryption type 2 → ERR_DOC_DRM (cannot extract)',
    extract: 'document',
    expect: 'drm',
    section: 'DRM',
  },
  {
    id: TEST_EDOC_FILES.MIXED_EPUB,
    name: 'Mixed — EPUB',
    description:
      'Markup chapter + one image-only spine item → text, then images, then OCR',
    extract: 'document',
    expect: 'mixed',
    section: 'Mixed / comics',
  },
  {
    id: TEST_EDOC_FILES.MANGA_CBZ,
    name: 'Manga — CBZ',
    description:
      'Cover + 2 manga pages, no markup → ERR_DOC_NO_TEXT → images → OCR',
    extract: 'document',
    expect: 'imagesOnly',
    section: 'Mixed / comics',
  },
  {
    id: TEST_PDF_FILES.DIGITAL_HELLO,
    name: 'Digital PDF — Hello',
    description: 'Native text layer → extractPdfTextLayer → TTS',
    extract: 'pdf',
    expect: 'text',
    section: 'PDF text layer',
  },
  {
    id: TEST_PDF_FILES.DIGITAL_MULTIPAGE,
    name: 'Digital PDF — 3 pages',
    description: 'Text layer on 3 pages → extractPdfTextLayer → TTS',
    extract: 'pdf',
    expect: 'text',
    section: 'PDF text layer',
  },
  {
    id: TEST_PDF_FILES.SCAN_ONLY_PAGE,
    name: 'Scan-only PDF',
    description: 'No text layer → ERR_PDF_NO_TEXT_LAYER (use OCR screen)',
    extract: 'pdf',
    expect: 'noTextLayer',
    section: 'PDF no text layer',
  },
  {
    id: TEST_PDF_FILES.SCAN_ONLY_MULTIPAGE,
    name: 'Scan-only PDF — 3 pages',
    description: 'No text layer → ERR_PDF_NO_TEXT_LAYER (use OCR screen)',
    extract: 'pdf',
    expect: 'noTextLayer',
    section: 'PDF no text layer',
  },
];

/** Books for the Reader screen (native ReaderView): EPUB, FB2, MOBI / AZW3, PDF, comics. */
export const READER_FILES: DocumentFileInfo[] = [
  {
    id: TEST_EDOC_FILES.FRANKENSTEIN_EPUB,
    name: 'Frankenstein — EPUB',
    description:
      'A real book (Standard Ebooks, public domain): contents, title page image, front and back matter',
    extract: 'document',
    expect: 'text',
    section: 'Books',
  },
  {
    id: TEST_EDOC_FILES.LONG_EPUB,
    name: 'Long book — EPUB',
    description: '40 chapters, 6160 blocks: fast scrolling, jumps and search',
    extract: 'document',
    expect: 'text',
    section: 'Books',
  },
  {
    id: TEST_PDF_FILES.BOOK,
    name: 'Book — PDF',
    description:
      'Text layer: paragraphs, headings, bookmarks as contents, page labels, two columns, a plate',
    extract: 'pdf',
    expect: 'text',
    section: 'PDF and comics',
  },
  {
    id: TEST_PDF_FILES.BOOK_SCAN,
    name: 'Scanned book — PDF',
    description:
      'The same book as page images only: OCR gives it headings and paragraphs, per model',
    extract: 'pdf',
    expect: 'imagesOnly',
    section: 'PDF and comics',
  },
  {
    id: TEST_PDF_FILES.SCAN_ONLY_MULTIPAGE,
    name: 'Scan — PDF',
    description: 'No text layer: the pages are shown as images',
    extract: 'pdf',
    expect: 'imagesOnly',
    section: 'PDF and comics',
  },
  {
    id: TEST_EDOC_FILES.MANGA_CBZ,
    name: 'Manga — CBZ',
    description: 'Comic pages, decoded on demand, full width',
    extract: 'document',
    expect: 'imagesOnly',
    section: 'PDF and comics',
  },
  {
    id: TEST_EDOC_FILES.STRUCTURE_EPUB,
    name: 'Structure — EPUB',
    description:
      'Headings, inline image, separator, preformatted text and an image page',
    extract: 'document',
    expect: 'text',
    section: 'Structure samples',
  },
  {
    id: TEST_EDOC_FILES.MIXED_EPUB,
    name: 'Mixed — EPUB',
    description: 'Text chapters and an image-only page',
    extract: 'document',
    expect: 'mixed',
    section: 'Structure samples',
  },
  {
    id: TEST_EDOC_FILES.HELLO_EPUB,
    name: 'Hello — EPUB',
    description: 'Short text-only EPUB',
    extract: 'document',
    expect: 'text',
    section: 'Structure samples',
  },
  {
    id: TEST_EDOC_FILES.HELLO_FB2,
    name: 'Hello — FB2',
    description: 'FictionBook: title, sections and contents',
    extract: 'document',
    expect: 'text',
    section: 'Structure samples',
  },
  {
    id: TEST_EDOC_FILES.HELLO_MOBI,
    name: 'Hello — MOBI',
    description: 'MOBI6 with metadata',
    extract: 'document',
    expect: 'text',
    section: 'Structure samples',
  },
  {
    id: TEST_EDOC_FILES.HELLO_AZW3,
    name: 'Hello — AZW3',
    description: 'KF8 / AZW3',
    extract: 'document',
    expect: 'text',
    section: 'Structure samples',
  },
];
