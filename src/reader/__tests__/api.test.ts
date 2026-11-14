const mockNative = {
  computeFileSourceSha256: jest.fn(),
  createReaderDocument: jest.fn(),
  insertReaderSection: jest.fn(),
  removeReaderSection: jest.fn(),
  getReaderBlocks: jest.fn(),
  findReaderBlockByHash: jest.fn(),
  mapReaderTextRanges: jest.fn(),
  getReaderToc: jest.fn(),
  releaseReaderDocument: jest.fn(),
};

const mockDocument = {
  extractDocumentText: jest.fn(),
  extractDocumentImages: jest.fn(),
};
const mockText = {
  createEmptyOfflineTextBuffer: jest.fn(),
  releasePipelineTextBuffer: jest.fn(),
};
const mockImages = { releaseOfflineImageBuffer: jest.fn() };

jest.mock('react-native', () => ({
  TurboModuleRegistry: { getEnforcing: () => mockNative },
  StyleSheet: { create: (s: unknown) => s },
  codegenNativeComponent: () => 'SherpaReaderView',
  codegenNativeCommands: () => ({ scrollToLocator: jest.fn() }),
}));

jest.mock('../../document', () => ({
  extractDocumentText: (...a: unknown[]) =>
    mockDocument.extractDocumentText(...a),
  extractDocumentImages: (...a: unknown[]) =>
    mockDocument.extractDocumentImages(...a),
  DocumentErrorCode: { NO_IMAGES: 'ERR_DOC_NO_IMAGES' },
}));

jest.mock('../../textbuffer', () => ({
  createEmptyOfflineTextBuffer: (...a: unknown[]) =>
    mockText.createEmptyOfflineTextBuffer(...a),
  releasePipelineTextBuffer: (...a: unknown[]) =>
    mockText.releasePipelineTextBuffer(...a),
  resolveOfflineTextBufferId: (id: unknown) =>
    typeof id === 'string' ? id : (id as { bufferId: string }).bufferId,
}));

jest.mock('../../imagebuffer', () => ({
  releaseOfflineImageBuffer: (...a: unknown[]) =>
    mockImages.releaseOfflineImageBuffer(...a),
}));

import {
  compareLocators,
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
} from '../api';

const SUMMARY = {
  id: 'rdr_1',
  revision: 1,
  documentKey: 'abc',
  structureVersion: 1,
  textHashVersion: 1,
  blockCount: 3,
  metadata: { title: 'Book', language: 'en' },
  sections: [
    {
      id: 's0',
      sectionIndex: 0,
      origin: 'file',
      kind: 'text',
      href: 'OEBPS/ch1.xhtml',
      title: 'One',
      titleSource: 'toc',
      blockCount: 3,
      firstBlockId: 's0.b0',
      lastBlockId: 's0.b2',
    },
  ],
};

describe('reader api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockText.releasePipelineTextBuffer.mockResolvedValue(undefined);
    mockImages.releaseOfflineImageBuffer.mockResolvedValue(undefined);
  });

  it('creates a document from a text buffer and parses the summary', async () => {
    mockNative.createReaderDocument.mockResolvedValue(JSON.stringify(SUMMARY));
    const doc = await createReaderDocument({
      text: { bufferId: 'txt_off_1' } as never,
      images: 'img_off_1',
      documentKey: 'abc',
    });
    expect(mockNative.createReaderDocument).toHaveBeenCalledWith(
      'txt_off_1',
      'img_off_1',
      'abc'
    );
    expect(doc.id).toBe('rdr_1');
    expect(doc.sections[0]).toMatchObject({
      id: 's0',
      origin: 'file',
      title: 'One',
      sectionIndex: 0,
    });
    expect(doc.metadata).toEqual({ title: 'Book', language: 'en' });
  });

  it('maps native reader error codes', async () => {
    mockNative.createReaderDocument.mockRejectedValue(
      new Error('ERR_READER_NO_STRUCTURE: Text buffer has no reading structure')
    );
    await expect(
      createReaderDocument({ text: 'txt_off_1', documentKey: 'k' })
    ).rejects.toMatchObject({ code: ReaderErrorCode.NO_STRUCTURE });
  });

  it('inserts an app section with parallel block arrays', async () => {
    mockNative.insertReaderSection.mockResolvedValue(
      JSON.stringify({ ...SUMMARY, revision: 2 })
    );
    const doc = await insertSection(SUMMARY as never, {
      after: 's0',
      id: 'app:guide',
      title: 'Path',
      blocks: [
        { key: 'h', type: 'heading', text: 'Path', level: 2 },
        { key: 'p1', type: 'paragraph', text: 'Text' },
      ],
    });
    expect(mockNative.insertReaderSection).toHaveBeenCalledWith(
      'rdr_1',
      's0',
      'app:guide',
      'Path',
      ['h', 'p1'],
      ['heading', 'paragraph'],
      ['Path', 'Text'],
      [2, 0]
    );
    expect(doc.revision).toBe(2);
  });

  it('rejects invalid app ids and keys before native', async () => {
    const doc = SUMMARY as never;
    await expect(
      insertSection(doc, { after: 's0', id: 'guide', blocks: [] })
    ).rejects.toMatchObject({ code: ReaderErrorCode.INVALID_ARGUMENT });
    await expect(
      insertSection(doc, {
        after: 's0',
        id: 'app:x',
        blocks: [{ key: 'a b', type: 'paragraph' }],
      })
    ).rejects.toMatchObject({ code: ReaderErrorCode.INVALID_ARGUMENT });
    expect(mockNative.insertReaderSection).not.toHaveBeenCalled();
  });

  it('pages blocks in chunks of 4096', async () => {
    mockNative.getReaderBlocks.mockImplementation(
      async (_id: string, start: number, n: number) =>
        JSON.stringify(
          Array.from({ length: n }, (_, i) => ({
            id: `s0.b${start + i}`,
            index: start + i,
          }))
        )
    );
    const blocks = await getReaderBlocks({
      ...SUMMARY,
      blockCount: 5000,
    } as never);
    expect(blocks).toHaveLength(5000);
    expect(mockNative.getReaderBlocks).toHaveBeenNthCalledWith(
      1,
      'rdr_1',
      0,
      4096,
      false
    );
    expect(mockNative.getReaderBlocks).toHaveBeenNthCalledWith(
      2,
      'rdr_1',
      4096,
      904,
      false
    );
  });

  it('remaps a stored position by textHash', async () => {
    mockNative.findReaderBlockByHash.mockResolvedValue(
      JSON.stringify({ blockId: 's2.b7', sectionId: 's2' })
    );
    await expect(
      remapLocator(
        SUMMARY as never,
        { textHash: 'h', offset: 4 },
        { sectionId: 's2', blockId: 's2.b6' }
      )
    ).resolves.toEqual({ sectionId: 's2', blockId: 's2.b7', offset: 4 });
    mockNative.findReaderBlockByHash.mockResolvedValue('null');
    await expect(
      remapLocator(SUMMARY as never, { textHash: 'h' })
    ).resolves.toBeNull();
  });

  it('loadReaderDocument extracts, hashes, owns the images and frees the text handle', async () => {
    mockText.createEmptyOfflineTextBuffer.mockResolvedValue({
      bufferId: 'txt_off_9',
    });
    mockDocument.extractDocumentText.mockResolvedValue({});
    mockDocument.extractDocumentImages.mockResolvedValue({
      buffer: 'img_off_9',
    });
    mockNative.computeFileSourceSha256.mockResolvedValue('feed');
    mockNative.createReaderDocument.mockResolvedValue(JSON.stringify(SUMMARY));
    const source = { kind: 'fs', path: '/tmp/a.epub' } as const;
    const doc = await loadReaderDocument(source);
    expect(mockDocument.extractDocumentImages).toHaveBeenCalledWith(source, {
      scope: 'all',
      maxSide: 2048,
    });
    expect(mockNative.createReaderDocument).toHaveBeenCalledWith(
      'txt_off_9',
      'img_off_9',
      'feed'
    );
    expect(mockText.releasePipelineTextBuffer).toHaveBeenCalled();
    expect(mockImages.releaseOfflineImageBuffer).not.toHaveBeenCalled();
    mockNative.releaseReaderDocument.mockResolvedValue(true);
    await releaseReaderDocument(doc);
    expect(mockImages.releaseOfflineImageBuffer).toHaveBeenCalledWith(
      'img_off_9'
    );
  });

  it('loadReaderDocument works without images', async () => {
    mockText.createEmptyOfflineTextBuffer.mockResolvedValue({
      bufferId: 'txt_off_8',
    });
    mockDocument.extractDocumentText.mockResolvedValue({});
    mockDocument.extractDocumentImages.mockRejectedValue(
      Object.assign(new Error('no images'), { code: 'ERR_DOC_NO_IMAGES' })
    );
    mockNative.computeFileSourceSha256.mockResolvedValue('feed');
    mockNative.createReaderDocument.mockResolvedValue(JSON.stringify(SUMMARY));
    await loadReaderDocument({ kind: 'fs', path: '/tmp/a.epub' });
    expect(mockNative.createReaderDocument).toHaveBeenCalledWith(
      'txt_off_8',
      '',
      'feed'
    );
  });

  it('reads the contents with levels and locators', async () => {
    mockNative.getReaderToc.mockResolvedValue(
      JSON.stringify([
        { title: 'Part One', level: 1, sectionId: 's1', blockId: 's1.b0' },
        { title: 'The Boat', level: 2, sectionId: 's1', blockId: 's1.b6' },
        { title: 'Odd', level: 0, sectionId: 's2', blockId: 's2.b0' },
      ])
    );
    await expect(getReaderToc(SUMMARY as never)).resolves.toEqual([
      {
        title: 'Part One',
        level: 1,
        locator: { sectionId: 's1', blockId: 's1.b0' },
      },
      {
        title: 'The Boat',
        level: 2,
        locator: { sectionId: 's1', blockId: 's1.b6' },
      },
      {
        title: 'Odd',
        level: 1,
        locator: { sectionId: 's2', blockId: 's2.b0' },
      },
    ]);
    expect(mockNative.getReaderToc).toHaveBeenCalledWith('rdr_1');
  });

  it('maps text-buffer ranges to reader ranges in one call', async () => {
    const from = { sectionId: 's0', blockId: 's0.b1', offset: 3 };
    const to = { sectionId: 's0', blockId: 's0.b2', offset: 5 };
    mockNative.mapReaderTextRanges.mockResolvedValue(
      JSON.stringify([{ from, to }, null])
    );
    await expect(
      mapTextRanges(SUMMARY as never, [
        [10, 40.7],
        [100, 101],
      ])
    ).resolves.toEqual([{ from, to }, null]);
    expect(mockNative.mapReaderTextRanges).toHaveBeenCalledWith(
      'rdr_1',
      [10, 100],
      [40, 101]
    );
    await expect(mapTextRanges(SUMMARY as never, [])).resolves.toEqual([]);
    mockNative.mapReaderTextRanges.mockResolvedValue(
      JSON.stringify([{ from, to: from }])
    );
    await expect(locatorAtTextOffset(SUMMARY as never, 13)).resolves.toEqual(
      from
    );
  });

  it('block id helpers', () => {
    expect(formatBlockId(11, 42)).toBe('s11.b42');
    expect(parseBlockId('s11.b42')).toEqual({
      sectionId: 's11',
      key: 'b42',
      sectionIndex: 11,
      blockIndex: 42,
    });
    expect(parseBlockId('app:guide.intro')).toEqual({
      sectionId: 'app:guide',
      key: 'intro',
    });
    expect(parseBlockId('nope')).toBeNull();
    expect(
      compareLocators(
        { sectionId: 's1', blockId: 's1.b9' },
        { sectionId: 's2', blockId: 's2.b0' }
      )
    ).toBeLessThan(0);
    expect(
      compareLocators(
        { sectionId: 's2', blockId: 's2.b3', offset: 5 },
        { sectionId: 's2', blockId: 's2.b3', offset: 2 }
      )
    ).toBeGreaterThan(0);
    expect(
      compareLocators(
        { sectionId: 'app:x', blockId: 'app:x.k' },
        { sectionId: 's2', blockId: 's2.b0' }
      )
    ).toBeNull();
  });
});
