const mockNative = {
  computeFileSourceSha256: jest.fn(),
  createReaderDocument: jest.fn(),
  createReaderPagesDocument: jest.fn(),
  insertReaderSection: jest.fn(),
  removeReaderSection: jest.fn(),
  getReaderBlocks: jest.fn(),
  findReaderBlockByHash: jest.fn(),
  mapReaderTextRanges: jest.fn(),
  createReaderTextSlice: jest.fn(),
  getReaderToc: jest.fn(),
  releaseReaderDocument: jest.fn(),
};

const mockDocument = {
  detectDocumentFormat: jest.fn(),
  extractDocumentText: jest.fn(),
  extractDocumentImages: jest.fn(),
};
const mockPdf = {
  extractPdfTextLayer: jest.fn(),
  rasterizePdfPages: jest.fn(),
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
  detectDocumentFormat: (...a: unknown[]) =>
    mockDocument.detectDocumentFormat(...a),
  extractDocumentText: (...a: unknown[]) =>
    mockDocument.extractDocumentText(...a),
  extractDocumentImages: (...a: unknown[]) =>
    mockDocument.extractDocumentImages(...a),
  DocumentErrorCode: { NO_IMAGES: 'ERR_DOC_NO_IMAGES' },
}));

jest.mock('../../pdf', () => ({
  extractPdfTextLayer: (...a: unknown[]) => mockPdf.extractPdfTextLayer(...a),
  rasterizePdfPages: (...a: unknown[]) => mockPdf.rasterizePdfPages(...a),
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
    mockDocument.detectDocumentFormat.mockResolvedValue('epub');
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

  it('passes style runs through with the text', async () => {
    mockNative.getReaderBlocks.mockResolvedValue(
      JSON.stringify([
        {
          id: 's0.b1',
          sectionId: 's0',
          index: 0,
          type: 'paragraph',
          textHash: '0123456789abcdef',
          text: 'Plain italic and bold text.',
          styles: [
            { start: 6, end: 12, italic: true },
            { start: 17, end: 21, bold: true },
          ],
        },
        { id: 's0.b2', index: 1, text: 'No styles.' },
      ])
    );
    const blocks = await getReaderBlocks(
      { ...SUMMARY, blockCount: 2 } as never,
      0,
      2,
      { includeText: true }
    );
    const [styled, plain] = blocks;
    expect(styled?.styles).toEqual([
      { start: 6, end: 12, italic: true },
      { start: 17, end: 21, bold: true },
    ]);
    expect(styled?.text?.slice(6, 12)).toBe('italic');
    expect(plain?.styles).toBeUndefined();
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

  it('loadReaderDocument opens a PDF with paragraphs and lazy pages', async () => {
    mockDocument.detectDocumentFormat.mockResolvedValue('pdf');
    mockText.createEmptyOfflineTextBuffer.mockResolvedValue({
      bufferId: 'txt_off_7',
    });
    mockPdf.extractPdfTextLayer.mockResolvedValue({ pageCount: 3 });
    mockPdf.rasterizePdfPages.mockResolvedValue({ bufferId: 'img_off_7' });
    mockNative.computeFileSourceSha256.mockResolvedValue('feed');
    mockNative.createReaderDocument.mockResolvedValue(
      JSON.stringify({ ...SUMMARY, format: 'pdf' })
    );
    const source = { kind: 'fs', path: '/tmp/a.pdf' } as const;
    const doc = await loadReaderDocument(source, { password: 'pw' });
    expect(doc.format).toBe('pdf');
    expect(mockPdf.extractPdfTextLayer).toHaveBeenCalledWith(
      source,
      { bufferId: 'txt_off_7' },
      { layout: 'paragraphs', password: 'pw' }
    );
    expect(mockPdf.rasterizePdfPages).toHaveBeenCalledWith(source, {
      strategy: 'lazy-lru',
      dpi: 144,
      maxSide: 2048,
      password: 'pw',
    });
    expect(mockNative.createReaderDocument).toHaveBeenCalledWith(
      'txt_off_7',
      'img_off_7',
      'feed'
    );
    expect(mockDocument.extractDocumentText).not.toHaveBeenCalled();
    mockNative.releaseReaderDocument.mockResolvedValue(true);
    await releaseReaderDocument(doc);
    expect(mockImages.releaseOfflineImageBuffer).toHaveBeenCalledWith(
      'img_off_7'
    );
  });

  it('loadReaderDocument opens a comic as a page document', async () => {
    mockDocument.detectDocumentFormat.mockResolvedValue('cbz');
    mockDocument.extractDocumentImages.mockResolvedValue({
      buffer: 'img_off_6',
    });
    mockNative.computeFileSourceSha256.mockResolvedValue('feed');
    mockNative.createReaderPagesDocument.mockResolvedValue(
      JSON.stringify({ ...SUMMARY, format: 'pages' })
    );
    const doc = await loadReaderDocument({ kind: 'fs', path: '/tmp/a.cbz' });
    expect(doc.format).toBe('pages');
    expect(mockDocument.extractDocumentImages).toHaveBeenCalledWith(
      { kind: 'fs', path: '/tmp/a.cbz' },
      { strategy: 'lazy-lru', maxSide: 2048 }
    );
    expect(mockNative.createReaderPagesDocument).toHaveBeenCalledWith(
      'img_off_6',
      'feed'
    );
    expect(mockText.createEmptyOfflineTextBuffer).not.toHaveBeenCalled();
  });

  it('createReaderDocument builds a page document from an image buffer', async () => {
    mockNative.createReaderPagesDocument.mockResolvedValue(
      JSON.stringify({ ...SUMMARY, format: 'pages' })
    );
    await createReaderDocument({
      pages: { bufferId: 'img_off_5' },
      documentKey: 'k',
    });
    expect(mockNative.createReaderPagesDocument).toHaveBeenCalledWith(
      'img_off_5',
      'k'
    );
    await expect(
      createReaderDocument({ pages: '', documentKey: 'k' })
    ).rejects.toMatchObject({ code: ReaderErrorCode.INVALID_ARGUMENT });
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
      [40, 101],
      ''
    );
    await expect(mapTextRanges(SUMMARY as never, [])).resolves.toEqual([]);
    mockNative.mapReaderTextRanges.mockResolvedValue(
      JSON.stringify([{ from, to: from }])
    );
    await expect(locatorAtTextOffset(SUMMARY as never, 13)).resolves.toEqual(
      from
    );
  });

  it('creates a text slice and maps its ranges through it', async () => {
    const from = { sectionId: 's2', blockId: 's2.b3', offset: 0 };
    const to = { sectionId: 's3', blockId: 's3.b3', offset: 35 };
    mockNative.createReaderTextSlice.mockResolvedValue(
      JSON.stringify({ bufferId: 'txt_off_7', length: 900, from, to })
    );
    const slice = await createReaderTextSlice(SUMMARY as never, {
      from: { sectionId: 's2', blockId: 's2.b0' },
      to: { sectionId: 's3', blockId: 's3.b3' },
      maxLength: 4000.5,
    });
    expect(mockNative.createReaderTextSlice).toHaveBeenCalledWith(
      'rdr_1',
      's2.b0',
      0,
      's3.b3',
      4000
    );
    expect(slice).toEqual({ buffer: 'txt_off_7', length: 900, from, to });
    mockNative.mapReaderTextRanges.mockResolvedValue(
      JSON.stringify([{ from, to }])
    );
    await mapTextRanges(SUMMARY as never, [[0, 900]], { slice });
    expect(mockNative.mapReaderTextRanges).toHaveBeenLastCalledWith(
      'rdr_1',
      [0],
      [900],
      'txt_off_7'
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
