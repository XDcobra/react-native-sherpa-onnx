/**
 * Reader API: EPUB structure → ReaderDocument with stable block IDs →
 * native, virtualized ReaderView (Fabric only). See docs/reader.md.
 */
export { ReaderView } from './ReaderView';
export {
  compareLocators,
  computeDocumentKey,
  createReaderDocument,
  formatBlockId,
  getReaderBlocks,
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
  ReaderTheme,
  ReaderViewHandle,
  ReaderViewProps,
  ReaderVisibleRange,
} from './types';
