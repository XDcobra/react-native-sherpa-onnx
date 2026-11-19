import type { ColorValue, StyleProp, ViewStyle } from 'react-native';
import type { ReactNode } from 'react';
import type { OfflineTextBufferHandle } from '../textbuffer/types';

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

/**
 * Inline style over `[start, end)` UTF-16 units of a block's `text` (relative
 * to the block). Runs are sorted and do not overlap; bold inside italic is one
 * run with both flags. Only file blocks of EPUB, MOBI / AZW3 and FB2 have them.
 */
export type ReaderTextStyleRun = {
  start: number;
  end: number;
  italic?: boolean;
  bold?: boolean;
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
  /**
   * Inline italic / bold of the block text (with `includeText` only; absent
   * when the block has none). The text itself carries no markers.
   */
  styles?: ReaderTextStyleRun[];
};

/** One entry of the book's contents (`getReaderToc`). */
export type ReaderTocEntry = {
  title: string;
  /** Nesting depth, starting at 1. */
  level: number;
  locator: ReaderLocator;
};

/** One sentence of a block (`getReaderSentences`). */
export type ReaderSentence = {
  blockId: string;
  /** Position of the sentence in its block, from 0. */
  index: number;
  /** UTF-16 offset in the block text (inclusive). */
  start: number;
  /** UTF-16 offset in the block text (exclusive). */
  end: number;
};

/** A range in the reading flow: `from` inclusive, `to` exclusive. */
export type ReaderRange = { from: ReaderLocator; to: ReaderLocator };

/**
 * Text of consecutive blocks in a new offline text buffer, for reading aloud
 * (`createReaderTextSlice`): paragraphs and headings from `from` on, joined
 * by a blank line, without running headers, footers and page numbers. Ranges
 * of `buffer` map back with `mapTextRanges(doc, ranges, { slice })`. Release
 * `buffer` (`releasePipelineTextBuffer`) when done.
 */
export type ReaderTextSlice = {
  buffer: OfflineTextBufferHandle;
  /** UTF-16 length of the slice text. */
  length: number;
  /** Where the slice starts and ends (`to.offset` exclusive). */
  from: ReaderLocator;
  to: ReaderLocator;
};

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
  /** Block with the line at the top of the reading area (also when cut off). */
  first: ReaderLocator;
  /** Last block with any part in the reading area (also when cut off). */
  last: ReaderLocator;
  /** UTF-16 offset of the first character on the top line of `first` (settled only). */
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

/**
 * A place in the trailing margin next to a block or a range (e.g. a note
 * count). The SDK only places it; the app draws it with `renderMarker`.
 * Markers never change the text or the row height.
 */
export type ReaderMarker = {
  /** Stable, unique ID; `renderMarker` and `onMarkerPress` get it. */
  id: string;
  blockId: string;
  /**
   * UTF-16 range in the block text. Without `start` / `end` the marker belongs
   * to the block and sits at its first line; with a range it sits at the line
   * of the range's last character.
   */
  start?: number;
  /** Exclusive. */
  end?: number;
  /** Read by VoiceOver / TalkBack (e.g. "3 notes"). Default: the text inside the marker view. */
  accessibilityLabel?: string;
};

/** How a text selection is widened while the user selects. */
export type ReaderSelectionSnap = 'none' | 'sentence' | 'block';

/** An app action in the text selection menu (shown before the system items). */
export type ReaderSelectionMenuItem = {
  id: string;
  title: string;
  /** iOS: SF Symbol name shown with the title. Ignored on Android. */
  systemImage?: string;
};

/** A selection menu item was chosen (`onSelectionAction`). */
export type ReaderSelectionAction = {
  itemId: string;
  blockId: string;
  /** Selected UTF-16 range in the block text (after snapping). */
  start: number;
  end: number;
  /** The selected text. */
  text: string;
  /** The sentences the selection touches, as one UTF-16 range in the block. */
  sentenceStart: number;
  sentenceEnd: number;
};

/** A tap on the text (`onTap`). */
export type ReaderTap = {
  blockId: string;
  /** UTF-16 offset of the tapped character in the block; absent on rows without text. */
  offset?: number;
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
  /**
   * Lets the user select text with a long press (within one block). Default
   * false. The system menu keeps its items (copy, look up, …);
   * `selectionMenuItems` adds the app's actions.
   */
  selectable?: boolean;
  /** Widens a selection to whole sentences or the whole block. Default `'none'`. */
  selectionSnap?: ReaderSelectionSnap;
  /** App actions in the selection menu; a choice calls `onSelectionAction`. */
  selectionMenuItems?: ReaderSelectionMenuItem[];
  /** Places in the trailing margin next to blocks or ranges; drawn by `renderMarker`. */
  markers?: ReaderMarker[];
  /**
   * The app's view for a marker. It is mounted only while its row is near the
   * visible range. Without it markers are not shown.
   */
  renderMarker?: (id: string) => ReactNode;
  /**
   * Side of a marker's square hit area, centered on its view (pt / dp). It can
   * reach into the neighbouring rows; never smaller than the view. Default 44
   * (iOS) / 48 (Android).
   */
  markerHitSize?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  onReady?: (info: { blockCount: number; sectionCount: number }) => void;
  onVisibleRangeChange?: (range: ReaderVisibleRange) => void;
  onFurthestPositionChange?: (locator: ReaderLocator) => void;
  onSectionEnd?: (info: { sectionId: string; blockId: string }) => void;
  onJump?: (jump: ReaderJump) => void;
  /** A tap on a row outside markers and inserts (also when not `selectable`). */
  onTap?: (tap: ReaderTap) => void;
  onError?: (error: { code: string; message: string }) => void;
  /** Follow scrolling paused or resumed. */
  onFollowChange?: (change: ReaderFollowChange) => void;
  /** A `selectionMenuItems` entry was chosen; the selection is cleared afterwards. */
  onSelectionAction?: (action: ReaderSelectionAction) => void;
  /**
   * A marker view was tapped (outside its own pressable children) or
   * activated with VoiceOver / TalkBack.
   */
  onMarkerPress?: (marker: { id: string; blockId: string }) => void;
  /** @internal Spike/testing only: render N placeholder rows without a document. */
  __debugRowCount?: number;
};

export type ReaderViewHandle = {
  scrollTo(locator: ReaderLocator, options?: { animated?: boolean }): void;
  /** Resume follow scrolling after the user paused it (scrolls to the highlight). */
  resumeFollow(): void;
};
