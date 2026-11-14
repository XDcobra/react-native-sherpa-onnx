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

export type ReaderBlockType = 'paragraph' | 'heading' | 'image' | 'separator';

export type ReaderSectionInfo = {
  /** `s{index}` for file sections, `app:{id}` for app sections. */
  id: string;
  /** Section index in the file (linear spine order); absent for app sections. */
  sectionIndex?: number;
  origin: 'file' | 'app';
  kind: 'text' | 'image';
  href?: string;
  title?: string;
  titleSource: 'toc' | 'heading' | 'app' | 'none';
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
  /**
   * UTF-16 range of the block in the document's text buffer (file text blocks
   * only). The shown text is exactly this slice.
   */
  textRange?: { start: number; end: number };
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

export type ReaderJumpCause = 'scroll' | 'fling' | 'scrollTo';

export type ReaderJump = {
  from: ReaderLocator;
  to: ReaderLocator;
  /** Signed distance in blocks. */
  distance: number;
  cause: ReaderJumpCause;
};

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
  style?: StyleProp<ViewStyle>;
  testID?: string;
  onReady?: (info: { blockCount: number; sectionCount: number }) => void;
  onVisibleRangeChange?: (range: ReaderVisibleRange) => void;
  onFurthestPositionChange?: (locator: ReaderLocator) => void;
  onSectionEnd?: (info: { sectionId: string; blockId: string }) => void;
  onJump?: (jump: ReaderJump) => void;
  onTap?: (info: { blockId: string }) => void;
  onError?: (error: { code: string; message: string }) => void;
  /** @internal Spike/testing only: render N placeholder rows without a document. */
  __debugRowCount?: number;
};

export type ReaderViewHandle = {
  scrollTo(locator: ReaderLocator, options?: { animated?: boolean }): void;
  /** Reserved for read-aloud; not implemented yet. */
  highlight(range: { from: ReaderLocator; to: ReaderLocator }): void;
};
