import type { ColorValue, StyleProp, ViewStyle } from 'react-native';
import type { ReactNode } from 'react';

/** Version of the structure decomposition rules (see docs/reader.md). */
export const READER_STRUCTURE_VERSION = 1;
/** Version of the text normalization + hash used for `textHash`. */
export const READER_TEXT_HASH_VERSION = 1;

/**
 * Position in a reader document. `blockId` is `s{section}.b{block}` for blocks
 * from the file and `app:{id}.{key}` for app sections. `offset` is an optional
 * UTF-16 offset inside the block.
 */
export type ReaderLocator = {
  sectionId: string;
  blockId: string;
  offset?: number;
};

/** `page`: the image of a page in a page-based document (PDF, comic). */
export type ReaderBlockType =
  | 'paragraph'
  | 'heading'
  | 'image'
  | 'separator'
  | 'page';

/**
 * Source format of a reader document. `pages`: a document made only from page
 * images (scanned PDF, comic), with text attached later (e.g. OCR).
 */
export type ReaderDocumentFormat = 'epub' | 'fb2' | 'mobi' | 'pdf' | 'pages';

export type ReaderSectionInfo = {
  /** `s{index}` for file sections, `app:{id}` for app sections. */
  id: string;
  /** Section index in the file (linear spine order); absent for app sections. */
  sectionIndex?: number;
  origin: 'file' | 'app';
  /** `page`: one page of a page-based document (PDF, comic). */
  kind: 'text' | 'image' | 'page';
  href?: string;
  title?: string;
  titleSource: 'toc' | 'heading' | 'app' | 'none';
  /** Printed page label of a PDF page (`"iv"`, `"12"`), when the PDF has one. */
  label?: string;
  blockCount: number;
  firstBlockId: string;
  lastBlockId: string;
};

export type ReaderDocumentMetadata = {
  title?: string;
  creator?: string;
  language?: string;
};

/**
 * Immutable value describing a native reader document. `insertSection` and
 * `removeSection` return a new value with a higher `revision`.
 */
export type ReaderDocument = {
  /** Native handle (`rdr_*`). */
  id: string;
  revision: number;
  documentKey: string;
  format: ReaderDocumentFormat;
  /** Version of the structure rules of `format`. */
  structureVersion: number;
  textHashVersion: number;
  blockCount: number;
  sections: ReaderSectionInfo[];
  metadata: ReaderDocumentMetadata;
};

export type ReaderBlock = {
  id: string;
  sectionId: string;
  index: number;
  type: ReaderBlockType;
  headingLevel?: number;
  textHash: string;
  text?: string;
  imageHref?: string;
  imageFrameIndex?: number;
  alt?: string;
  /** Running header, footer or page number (hidden in reflowed text). */
  furniture?: boolean;
  /** Position on its page or image, normalized `[x, y, width, height]` (0..1). */
  rect?: [number, number, number, number];
  /**
   * UTF-16 range of the block in the document's text buffer (file text blocks
   * only). The shown text is exactly this slice.
   */
  textRange?: { start: number; end: number };
};

/** One entry of the book's contents (`getReaderToc`). */
export type ReaderTocEntry = {
  title: string;
  /** Nesting depth, starting at 1. */
  level: number;
  locator: ReaderLocator;
};

/** A range in the reading flow: `from` inclusive, `to` exclusive. */
export type ReaderRange = { from: ReaderLocator; to: ReaderLocator };

export type ReaderAppBlock = {
  /** Unique within the section, `[A-Za-z0-9_-]+`. */
  key: string;
  type: 'paragraph' | 'heading' | 'separator';
  text?: string;
  level?: number;
};

export type ReaderAppSection = {
  /** Existing section ID to insert after (`s11`, `app:x`). */
  after: string;
  /** `app:<id>`. */
  id: string;
  title?: string;
  blocks: ReaderAppBlock[];
};

export type ReaderInsertTarget =
  | { sectionEnd: string }
  | { beforeBlock: string }
  | { afterBlock: string };

export type ReaderInsert = {
  key: string;
  at: ReaderInsertTarget;
};

export type ReaderTheme = {
  fontFamily?: string;
  /** Base size in points / dp before scaling. Default 18. */
  fontSize?: number;
  /** `'system'` follows Dynamic Type / Android font scale; a number is a fixed factor. */
  fontScale?: 'system' | number;
  /** Upper bound for the system scale (0 = no limit). */
  maxFontScale?: number;
  /** Line height multiplier. Default 1.5. */
  lineHeight?: number;
  /** Space between blocks in em. Default 0.75. */
  paragraphSpacing?: number;
  margins?: { horizontal?: number; vertical?: number };
  textAlign?: 'start' | 'justify';
  hyphenation?: boolean;
  colors?: { background?: ColorValue; text?: ColorValue; accent?: ColorValue };
};

export type ReaderVisibleRange = {
  first: ReaderLocator;
  last: ReaderLocator;
  /** UTF-16 offset of the first visible character in `first`. */
  firstOffset: number;
  /** True once scrolling has stopped. */
  settled: boolean;
  visibleInserts: string[];
};

/**
 * - `scroll`: moved more than `jumpThreshold` blocks without continuous visibility.
 * - `fling`: a fling landed more than `jumpThreshold` blocks away.
 * - `scrollTo`: the `scrollTo` command.
 * - `follow`: follow scrolling moved far (e.g. read-aloud restarted elsewhere).
 */
export type ReaderJumpCause = 'scroll' | 'fling' | 'scrollTo' | 'follow';

/** How a highlight is drawn. */
export type ReaderHighlightStyle = 'background' | 'underline' | 'textColor';

/**
 * A marked range in the reading flow. Several highlights can be shown at the
 * same time and may overlap; later entries draw on top.
 */
export type ReaderHighlight = {
  /** Stable ID; moving a highlight means passing the same ID with a new range. */
  id: string;
  /** Inclusive start. Without `offset`: start of the block. */
  from: ReaderLocator;
  /** Exclusive end. Without `offset`: end of the block. */
  to: ReaderLocator;
  /** Default `'background'`. */
  style?: ReaderHighlightStyle;
  /**
   * Default: the theme's accent color (for `background` at 30 % opacity).
   * Use a translucent color for backgrounds so the text stays readable.
   */
  color?: ColorValue;
  /** Keep this highlight in view (see `follow`). The first one with `follow` wins. */
  follow?: boolean;
};

/** Follow scrolling: keeps the followed highlight in view. */
export type ReaderFollowOptions = {
  /**
   * - `keepVisible` (default): scroll only when the highlight leaves the
   *   comfort zone (10 %–85 % of the height), then place it at `anchor`.
   * - `center`: keep the highlight centered on every change.
   * - `off`: never scroll.
   */
  mode?: 'keepVisible' | 'center' | 'off';
  /** 0..1, where `keepVisible` places the highlight. Default 0.3. */
  anchor?: number;
  /**
   * Pause following while the user scrolls (default true). It resumes when the
   * highlight is back in the comfort zone, or with `resumeFollow()`.
   */
  pauseOnUserScroll?: boolean;
};

export type ReaderFollowChange = {
  following: boolean;
  /** `user`: paused by user scrolling; `resumed`: back in view; `command`: `resumeFollow()`. */
  reason: 'user' | 'resumed' | 'command';
};

export type ReaderJump = {
  from: ReaderLocator;
  to: ReaderLocator;
  /** Signed distance in blocks. */
  distance: number;
  cause: ReaderJumpCause;
};

/**
 * How page sections (PDF pages, comic and scanned pages) are shown.
 * - `'text'`: the page's text; the page image only when the page has no text.
 *   Running headers, footers and page numbers are hidden.
 * - `'image'`: one full-width page image per page. It stands for the page's
 *   text: visible range, furthest position and `scrollTo` use the blocks'
 *   positions on the page.
 * - `'imageAndText'`: the page image, then its text.
 * - `'auto'` (default): `'image'` for page documents (`format: 'pages'`),
 *   else `'text'`.
 * Other sections (EPUB, FB2, MOBI chapters, app sections) are not affected.
 */
export type ReaderPageDisplay = 'auto' | 'text' | 'image' | 'imageAndText';

export type ReaderViewProps = {
  document: ReaderDocument | null;
  initialLocator?: ReaderLocator | null;
  /** Frontier for `onFurthestPositionChange`; owned by the app. */
  furthestLocator?: ReaderLocator | null;
  mode?: 'scroll';
  theme?: ReaderTheme;
  inserts?: ReaderInsert[];
  renderInsert?: (key: string) => ReactNode;
  /** Blocks; a move further than this is reported as a jump. Default 20. */
  jumpThreshold?: number;
  /** Marked ranges (search hits, read-aloud sentence / word, notes, …). */
  highlights?: ReaderHighlight[];
  /** Follow scrolling for the highlight with `follow: true`. */
  follow?: ReaderFollowOptions;
  /** How pages of PDFs, comics and scans are shown. Default `'auto'`. */
  pageDisplay?: ReaderPageDisplay;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  onReady?: (info: { blockCount: number; sectionCount: number }) => void;
  onVisibleRangeChange?: (range: ReaderVisibleRange) => void;
  onFurthestPositionChange?: (locator: ReaderLocator) => void;
  onSectionEnd?: (info: { sectionId: string; blockId: string }) => void;
  onJump?: (jump: ReaderJump) => void;
  onTap?: (info: { blockId: string }) => void;
  onError?: (error: { code: string; message: string }) => void;
  /** Follow scrolling paused or resumed. */
  onFollowChange?: (change: ReaderFollowChange) => void;
  /** @internal Spike/testing only: render N placeholder rows without a document. */
  __debugRowCount?: number;
};

export type ReaderViewHandle = {
  scrollTo(locator: ReaderLocator, options?: { animated?: boolean }): void;
  /** Resume follow scrolling after the user paused it (scrolls to the highlight). */
  resumeFollow(): void;
};
