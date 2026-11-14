/**
 * Reader API: EPUB structure → ReaderDocument with stable block IDs →
 * native, virtualized ReaderView (Fabric only). See docs/reader.md.
 */
export { ReaderView } from './ReaderView';
export { READER_STRUCTURE_VERSION, READER_TEXT_HASH_VERSION } from './types';
export type {
  ReaderAppBlock,
  ReaderAppSection,
  ReaderBlock,
  ReaderBlockType,
  ReaderDocument,
  ReaderDocumentMetadata,
  ReaderInsert,
  ReaderInsertTarget,
  ReaderJump,
  ReaderJumpCause,
  ReaderLocator,
  ReaderSectionInfo,
  ReaderTheme,
  ReaderViewHandle,
  ReaderViewProps,
  ReaderVisibleRange,
} from './types';
