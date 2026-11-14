/**
 * Reader API: reading structure (EPUB, FB2, MOBI, PDF) or page images →
 * ReaderDocument with stable block IDs → native, virtualized ReaderView
 * (Fabric only). See docs/reader.md.
 */
export { ReaderView } from './ReaderView';
export {
  createReadAloudTimeline,
  splitWords,
  useReadAloudHighlights,
} from './readAloud';
export type {
  CreateReadAloudTimelineOptions,
  ReadAloudAlignedWord,
  ReadAloudHighlightOptions,
  ReadAloudPosition,
  ReadAloudTimeline,
  ReadAloudUnit,
} from './readAloud';
export {
  compareLocators,
  computeDocumentKey,
  createReaderDocument,
  createReaderTextSlice,
  formatBlockId,
  getReaderBlocks,
  getReaderToc,
  insertSection,
  loadReaderDocument,
  locatorAtTextOffset,
  mapTextRanges,
  parseBlockId,
  ReaderErrorCode,
  releaseReaderDocument,
  remapLocator,
  removeSection,
} from './api';
export { attachReaderPageText, recognizeReaderPages } from './ocr';
export type { RecognizeReaderPagesOptions } from './ocr';
export type {
  CreateReaderDocumentOptions,
  LoadReaderDocumentOptions,
  ReaderErrorCodeValue,
} from './api';
export { READER_STRUCTURE_VERSION, READER_TEXT_HASH_VERSION } from './types';
export type {
  ReaderAppBlock,
  ReaderAppSection,
  ReaderBlock,
  ReaderBlockType,
  ReaderDocument,
  ReaderDocumentFormat,
  ReaderDocumentMetadata,
  ReaderFollowChange,
  ReaderFollowOptions,
  ReaderHighlight,
  ReaderHighlightStyle,
  ReaderInsert,
  ReaderInsertTarget,
  ReaderJump,
  ReaderJumpCause,
  ReaderLocator,
  ReaderPageDisplay,
  ReaderRange,
  ReaderSectionInfo,
  ReaderTextSlice,
  ReaderTocEntry,
  ReaderTheme,
  ReaderViewHandle,
  ReaderViewProps,
  ReaderVisibleRange,
} from './types';
