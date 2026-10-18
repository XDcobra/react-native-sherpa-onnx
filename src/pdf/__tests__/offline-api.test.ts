const mockNative = {
  isPdfiumEnabled: jest.fn(),
  extractPdfTextLayer: jest.fn(),
  rasterizePdfPages: jest.fn(),
};

jest.mock('react-native', () => ({
  TurboModuleRegistry: {
    getEnforcing: () => mockNative,
  },
  NativeEventEmitter: jest.fn().mockImplementation(() => ({
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  })),
  NativeModules: { SherpaOnnx: {} },
}));

jest.mock('../../textbuffer', () => ({
  resolveOfflineTextBufferId: (id: unknown) =>
    typeof id === 'string' ? id : (id as { bufferId: string }).bufferId,
}));

import {
  extractPdfTextLayer,
  isPdfiumEnabled,
  PdfErrorCode,
  rasterizePdfPages,
} from '../index';

describe('pdf offline api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('isPdfiumEnabled forwards native', async () => {
    mockNative.isPdfiumEnabled.mockResolvedValue(false);
    await expect(isPdfiumEnabled()).resolves.toBe(false);
    mockNative.isPdfiumEnabled.mockResolvedValue(true);
    await expect(isPdfiumEnabled()).resolves.toBe(true);
  });

  it('maps disabled native error to ERR_PDF_PDFIUM_DISABLED', async () => {
    mockNative.extractPdfTextLayer.mockRejectedValue(
      new Error('ERR_PDF_PDFIUM_DISABLED: PDFium is not linked')
    );
    await expect(
      extractPdfTextLayer(
        { kind: 'fs', path: '/tmp/a.pdf' },
        'txt_off_00000000-0000-0000-0000-000000000001'
      )
    ).rejects.toMatchObject({ code: PdfErrorCode.PDFIUM_DISABLED });
  });

  it('extractPdfTextLayer returns counts on success', async () => {
    mockNative.extractPdfTextLayer.mockResolvedValue({
      pageCount: 2,
      pagesWithText: 2,
      utf16Length: 10,
      spatialSpanCount: 3,
    });
    const r = await extractPdfTextLayer(
      { kind: 'fs', path: '/tmp/a.pdf' },
      'txt_off_00000000-0000-0000-0000-000000000001',
      { pages: [1] }
    );
    expect(r).toEqual({
      pageCount: 2,
      pagesWithText: 2,
      utf16Length: 10,
      spatialSpanCount: 3,
    });
    expect(mockNative.extractPdfTextLayer).toHaveBeenCalledWith(
      { kind: 'fs', path: '/tmp/a.pdf' },
      'txt_off_00000000-0000-0000-0000-000000000001',
      { pages: [1] }
    );
  });

  it('rasterizePdfPages maps disabled error', async () => {
    mockNative.rasterizePdfPages.mockRejectedValue(
      new Error('ERR_PDF_PDFIUM_DISABLED: PDFium is not linked')
    );
    await expect(
      rasterizePdfPages({ kind: 'fs', path: '/tmp/a.pdf' })
    ).rejects.toMatchObject({ code: PdfErrorCode.PDFIUM_DISABLED });
  });

  it('rasterizePdfPages returns OfflineImageBufferRef', async () => {
    mockNative.rasterizePdfPages.mockResolvedValue({
      bufferId: 'img_off_00000000-0000-0000-0000-0000000000aa',
      kind: 'offlineImageBuffer',
      state: 'immutable',
      frameCount: 1,
      totalBytes: 1200,
      storageKind: 'ram',
      pageCount: 1,
    });
    const r = await rasterizePdfPages(
      { kind: 'fs', path: '/tmp/a.pdf' },
      { pages: [1], dpi: 144, maxSide: 2048 }
    );
    expect(r.bufferId).toBe('img_off_00000000-0000-0000-0000-0000000000aa');
    expect(r.info.frameCount).toBe(1);
    expect(r.pageCount).toBe(1);
    expect(mockNative.rasterizePdfPages).toHaveBeenCalledWith(
      { kind: 'fs', path: '/tmp/a.pdf' },
      { pages: [1], dpi: 144, maxSide: 2048 }
    );
  });

  it('rasterizePdfPages rejects invalid dpi', async () => {
    await expect(
      rasterizePdfPages({ kind: 'fs', path: '/tmp/a.pdf' }, { dpi: 0 })
    ).rejects.toThrow(/dpi must be > 0/);
    expect(mockNative.rasterizePdfPages).not.toHaveBeenCalled();
  });
});
