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

  it('forwards apkAsset FileSource to native', async () => {
    mockNative.extractPdfTextLayer.mockResolvedValue({
      pageCount: 1,
      pagesWithText: 1,
      utf16Length: 4,
      spatialSpanCount: 1,
    });
    const source = {
      kind: 'app' as const,
      base: 'apkAsset' as const,
      path: 'test_pdfs/a.pdf',
    };
    await extractPdfTextLayer(
      source,
      'txt_off_00000000-0000-0000-0000-000000000001'
    );
    expect(mockNative.extractPdfTextLayer).toHaveBeenCalledWith(
      source,
      'txt_off_00000000-0000-0000-0000-000000000001',
      {}
    );
  });

  it('isPdfiumEnabled forwards native', async () => {
    mockNative.isPdfiumEnabled.mockResolvedValue(false);
    await expect(isPdfiumEnabled()).resolves.toBe(false);
    mockNative.isPdfiumEnabled.mockResolvedValue(true);
    await expect(isPdfiumEnabled()).resolves.toBe(true);
  });

  it('maps message-only no-text-layer reject to ERR_PDF_NO_TEXT_LAYER', async () => {
    mockNative.extractPdfTextLayer.mockRejectedValue(
      Object.assign(
        new Error(
          'No extractable text layer on the selected pages (scan-only PDF or empty)'
        ),
        { code: PdfErrorCode.NO_TEXT_LAYER }
      )
    );
    await expect(
      extractPdfTextLayer(
        { kind: 'fs', path: '/tmp/scan.pdf' },
        'txt_off_00000000-0000-0000-0000-000000000001'
      )
    ).rejects.toMatchObject({ code: PdfErrorCode.NO_TEXT_LAYER });
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

  it('extractPdfTextLayer forwards password and omits empty', async () => {
    mockNative.extractPdfTextLayer.mockResolvedValue({
      pageCount: 1,
      pagesWithText: 1,
      utf16Length: 4,
      spatialSpanCount: 1,
    });
    await extractPdfTextLayer(
      { kind: 'fs', path: '/tmp/secret.pdf' },
      'txt_off_00000000-0000-0000-0000-000000000001',
      { password: 'secret' }
    );
    expect(mockNative.extractPdfTextLayer).toHaveBeenCalledWith(
      { kind: 'fs', path: '/tmp/secret.pdf' },
      'txt_off_00000000-0000-0000-0000-000000000001',
      { password: 'secret' }
    );
    mockNative.extractPdfTextLayer.mockClear();
    await extractPdfTextLayer(
      { kind: 'fs', path: '/tmp/secret.pdf' },
      'txt_off_00000000-0000-0000-0000-000000000001',
      { password: '' }
    );
    expect(mockNative.extractPdfTextLayer).toHaveBeenCalledWith(
      { kind: 'fs', path: '/tmp/secret.pdf' },
      'txt_off_00000000-0000-0000-0000-000000000001',
      {}
    );
  });

  it('extractPdfTextLayer rejects non-string password', async () => {
    await expect(
      extractPdfTextLayer(
        { kind: 'fs', path: '/tmp/a.pdf' },
        'txt_off_00000000-0000-0000-0000-000000000001',
        { password: 1 as unknown as string }
      )
    ).rejects.toMatchObject({ code: PdfErrorCode.INVALID_ARGUMENT });
    expect(mockNative.extractPdfTextLayer).not.toHaveBeenCalled();
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
    expect(r.info.state).toBe('immutable');
    expect(r.pageCount).toBe(1);
    expect(mockNative.rasterizePdfPages).toHaveBeenCalledWith(
      { kind: 'fs', path: '/tmp/a.pdf' },
      { pages: [1], dpi: 144, maxSide: 2048, strategy: 'rasterize-all' }
    );
  });

  it('rasterizePdfPages rejects invalid dpi', async () => {
    await expect(
      rasterizePdfPages({ kind: 'fs', path: '/tmp/a.pdf' }, { dpi: 0 })
    ).rejects.toThrow(/dpi must be > 0/);
    expect(mockNative.rasterizePdfPages).not.toHaveBeenCalled();
  });

  it('rasterizePdfPages passes lazy-lru strategy and hotFrames', async () => {
    mockNative.rasterizePdfPages.mockResolvedValue({
      bufferId: 'img_off_00000000-0000-0000-0000-0000000000bb',
      kind: 'offlineImageBuffer',
      state: 'lazy',
      frameCount: 5,
      totalBytes: 0,
      storageKind: 'ram',
      pageCount: 5,
    });
    const r = await rasterizePdfPages(
      { kind: 'fs', path: '/tmp/big.pdf' },
      { strategy: 'lazy-lru', hotFrames: 2, dpi: 144 }
    );
    expect(r.info.state).toBe('lazy');
    expect(r.info.frameCount).toBe(5);
    expect(mockNative.rasterizePdfPages).toHaveBeenCalledWith(
      { kind: 'fs', path: '/tmp/big.pdf' },
      { strategy: 'lazy-lru', hotFrames: 2, dpi: 144 }
    );
  });

  it('rasterizePdfPages forwards password', async () => {
    mockNative.rasterizePdfPages.mockResolvedValue({
      bufferId: 'img_off_00000000-0000-0000-0000-0000000000cc',
      kind: 'offlineImageBuffer',
      state: 'immutable',
      frameCount: 1,
      totalBytes: 10,
      storageKind: 'ram',
      pageCount: 1,
    });
    await rasterizePdfPages(
      { kind: 'fs', path: '/tmp/secret.pdf' },
      { password: 'secret' }
    );
    expect(mockNative.rasterizePdfPages).toHaveBeenCalledWith(
      { kind: 'fs', path: '/tmp/secret.pdf' },
      { strategy: 'rasterize-all', password: 'secret' }
    );
  });

  it('rasterizePdfPages rejects invalid strategy', async () => {
    await expect(
      rasterizePdfPages(
        { kind: 'fs', path: '/tmp/a.pdf' },
        { strategy: 'nope' as 'lazy-lru' }
      )
    ).rejects.toThrow(/strategy must be/);
    expect(mockNative.rasterizePdfPages).not.toHaveBeenCalled();
  });
});
