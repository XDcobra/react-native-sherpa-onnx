/**
 * Reader API: EPUB structure → ReaderDocument with stable block IDs →
 * native, virtualized ReaderView (Fabric only). See docs/reader.md.
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
export type { ReaderErrorCodeValue } from './api';
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
  ReaderRange,
  ReaderSectionInfo,
  ReaderTocEntry,
  ReaderTheme,
  ReaderViewHandle,
  ReaderViewProps,
  ReaderVisibleRange,
} from './types';
