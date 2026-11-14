const mockNative = {
  getReaderPages: jest.fn(),
  attachReaderPageText: jest.fn(),
  saveReaderRecognition: jest.fn(),
  loadReaderRecognition: jest.fn(),
};
const mockText = {
  createEmptyOfflineTextBuffer: jest.fn(),
  releasePipelineTextBuffer: jest.fn(),
};

jest.mock('react-native', () => ({
  TurboModuleRegistry: { getEnforcing: () => mockNative },
}));

jest.mock('../../document', () => ({ DocumentErrorCode: {} }));
jest.mock('../../document/detect', () => ({}));
jest.mock('../../imagebuffer', () => ({}));
jest.mock('../../pdf', () => ({}));

jest.mock('../../textbuffer', () => ({
  createEmptyOfflineTextBuffer: (...a: unknown[]) =>
    mockText.createEmptyOfflineTextBuffer(...a),
  releasePipelineTextBuffer: (...a: unknown[]) =>
    mockText.releasePipelineTextBuffer(...a),
  resolveOfflineTextBufferId: (id: unknown) =>
    typeof id === 'string' ? id : (id as { bufferId: string }).bufferId,
}));

import {
  attachReaderPageText,
  loadReaderRecognition,
  recognizeReaderPages,
  saveReaderRecognition,
} from '../ocr';

const DOC = {
  id: 'rdr_1',
  revision: 1,
  documentKey: 'k',
  format: 'pages',
  structureVersion: 1,
  textHashVersion: 1,
  blockCount: 6,
  sections: [],
  metadata: {},
} as const;

function pages(withText: number[] = []) {
  return JSON.stringify({
    imageBufferId: 'img_off_1',
    pages: [0, 1, 2, 3, 4, 5].map((i) => ({
      sectionId: `s${i}`,
      blockId: `s${i}.b0`,
      frame: i,
      hasText: withText.includes(i),
    })),
  });
}

function engine() {
  return {
    instanceId: 'ocr_1',
    family: 'ppocr',
    capabilities: {},
    recognize: jest.fn().mockResolvedValue({ family: 'ppocr', spanCount: 3 }),
    destroy: jest.fn(),
  };
}

describe('reader ocr', () => {
  let revision = 1;
  beforeEach(() => {
    jest.clearAllMocks();
    revision = 1;
    let n = 0;
    mockText.createEmptyOfflineTextBuffer.mockImplementation(async () => ({
      bufferId: `txt_off_${++n}`,
    }));
    mockText.releasePipelineTextBuffer.mockResolvedValue(undefined);
    mockNative.attachReaderPageText.mockImplementation(async () =>
      JSON.stringify({ ...DOC, revision: ++revision })
    );
  });

  it('saves and loads recognized pages through the native sidecar calls', async () => {
    mockNative.saveReaderRecognition.mockResolvedValue({
      pages: 3,
      outputKind: 'path',
      outputPath: '/data/book.ocr',
    });
    const dest = { kind: 'fs', path: '/data/book.ocr' } as never;
    await expect(
      saveReaderRecognition(DOC as never, dest, { modelId: 'ppocrv6-tiny' })
    ).resolves.toEqual({ pages: 3, outputPath: '/data/book.ocr' });
    expect(mockNative.saveReaderRecognition).toHaveBeenCalledWith(
      'rdr_1',
      dest,
      'ppocrv6-tiny',
      false,
      false
    );
    mockNative.loadReaderRecognition.mockResolvedValue(
      JSON.stringify({ ...DOC, revision: 5 })
    );
    const doc = await loadReaderRecognition(DOC as never, dest);
    expect(doc.revision).toBe(5);
    expect(mockNative.loadReaderRecognition).toHaveBeenCalledWith(
      'rdr_1',
      dest,
      ''
    );
    mockNative.loadReaderRecognition.mockRejectedValue(
      new Error('ERR_READER_SIDECAR_MISMATCH: another document')
    );
    await expect(
      loadReaderRecognition(DOC as never, dest)
    ).rejects.toMatchObject({ code: 'ERR_READER_SIDECAR_MISMATCH' });
  });

  it('attachReaderPageText resolves the new revision', async () => {
    const doc = await attachReaderPageText(DOC as never, {
      text: { bufferId: 'txt_off_9' } as never,
    });
    expect(mockNative.attachReaderPageText).toHaveBeenCalledWith(
      'rdr_1',
      'txt_off_9'
    );
    expect(doc.revision).toBe(2);
  });

  it('around: the current page, then ahead, then behind; skips pages with text', async () => {
    mockNative.getReaderPages.mockResolvedValue(pages([3]));
    const ocr = engine();
    const onProgress = jest.fn();
    const doc = await recognizeReaderPages(DOC as never, ocr as never, {
      at: { sectionId: 's2', blockId: 's2.b0' },
      recognize: { readingDirection: 'rtl' },
      onProgress,
    });
    const frames = ocr.recognize.mock.calls.map((c) => c[2].frames[0]);
    expect(frames).toEqual([2, 4, 1]);
    expect(ocr.recognize.mock.calls[0][0]).toBe('img_off_1');
    expect(ocr.recognize.mock.calls[0][2].readingDirection).toBe('rtl');
    expect(mockNative.attachReaderPageText).toHaveBeenCalledTimes(3);
    expect(mockText.releasePipelineTextBuffer).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenLastCalledWith({
      done: 3,
      total: 3,
      sectionId: 's1',
    });
    expect(doc.revision).toBe(4);
  });

  it('all with force runs every page; onDocument is throttled but ends on the last value', async () => {
    mockNative.getReaderPages.mockResolvedValue(pages([0, 1]));
    const ocr = engine();
    const onDocument = jest.fn();
    await recognizeReaderPages(DOC as never, ocr as never, {
      scope: 'all',
      force: true,
      onDocument,
      updateIntervalMs: 60_000,
    });
    expect(ocr.recognize).toHaveBeenCalledTimes(6);
    expect(onDocument).toHaveBeenCalledTimes(2);
    expect(onDocument.mock.calls[1][0].revision).toBe(7);
  });

  it('stops when aborted and keeps the pages done', async () => {
    mockNative.getReaderPages.mockResolvedValue(pages());
    const ocr = engine();
    const controller = new AbortController();
    ocr.recognize.mockImplementation(async () => {
      controller.abort();
      return { family: 'ppocr', spanCount: 1 };
    });
    const doc = await recognizeReaderPages(DOC as never, ocr as never, {
      scope: 'all',
      signal: controller.signal,
    });
    expect(ocr.recognize).toHaveBeenCalledTimes(1);
    expect(doc.revision).toBe(2);
  });

  it('a recognize error is thrown and the text handle is released', async () => {
    mockNative.getReaderPages.mockResolvedValue(pages());
    const ocr = engine();
    ocr.recognize.mockRejectedValue(
      Object.assign(new Error('boom'), { code: 'OCR_RECOGNIZE_FAILED' })
    );
    await expect(
      recognizeReaderPages(DOC as never, ocr as never, {
        scope: { sections: ['s5'] },
      })
    ).rejects.toMatchObject({ code: 'OCR_RECOGNIZE_FAILED' });
    expect(mockText.releasePipelineTextBuffer).toHaveBeenCalledTimes(1);
  });
});
