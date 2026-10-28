const mockNative = {
  extractDocumentText: jest.fn(),
  extractDocumentImages: jest.fn(),
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
  DocumentErrorCode,
  extractDocumentImages,
  extractDocumentText,
} from '../index';

const TEXT_OUT = 'txt_off_00000000-0000-0000-0000-000000000001';

describe('document offline api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects a missing FileSource before native', async () => {
    await expect(
      extractDocumentText(null as never, TEXT_OUT)
    ).rejects.toMatchObject({
      message: expect.stringContaining(DocumentErrorCode.INVALID_ARGUMENT),
    });
    expect(mockNative.extractDocumentText).not.toHaveBeenCalled();
  });

  it('maps archive-disabled native error', async () => {
    mockNative.extractDocumentText.mockRejectedValue(
      new Error('ERR_DOC_ARCHIVE_DISABLED: libarchive is not linked')
    );
    await expect(
      extractDocumentText({ kind: 'fs', path: '/tmp/a.epub' }, TEXT_OUT)
    ).rejects.toMatchObject({ code: DocumentErrorCode.ARCHIVE_DISABLED });
  });

  it('maps no-text native error from code', async () => {
    mockNative.extractDocumentText.mockRejectedValue(
      Object.assign(new Error('comic has no markup'), {
        code: DocumentErrorCode.NO_TEXT,
      })
    );
    await expect(
      extractDocumentText({ kind: 'fs', path: '/tmp/a.cbz' }, TEXT_OUT)
    ).rejects.toMatchObject({ code: DocumentErrorCode.NO_TEXT });
  });

  it('extractDocumentText returns sections on success', async () => {
    mockNative.extractDocumentText.mockResolvedValue({
      format: 'epub',
      sectionCount: 2,
      sections: [
        { sectionIndex: 0, href: 'ch1.xhtml', kind: 'text' },
        { sectionIndex: 1, href: 'scan.xhtml', kind: 'image' },
      ],
      imageOnlySections: [
        { sectionIndex: 1, href: 'scan.xhtml', kind: 'image' },
      ],
      spatialSpanCount: 4,
    });
    const r = await extractDocumentText(
      { kind: 'fs', path: '/tmp/mixed.epub' },
      TEXT_OUT
    );
    expect(r.buffer).toBe(TEXT_OUT);
    expect(r.format).toBe('epub');
    expect(r.sectionCount).toBe(2);
    expect(r.imageOnlySections).toHaveLength(1);
    expect(r.spatialSpanCount).toBe(4);
    expect(mockNative.extractDocumentText).toHaveBeenCalledWith(
      { kind: 'fs', path: '/tmp/mixed.epub' },
      TEXT_OUT,
      {}
    );
  });

  it('extractDocumentImages returns buffer id', async () => {
    mockNative.extractDocumentImages.mockResolvedValue({
      bufferId: 'img_off_00000000-0000-0000-0000-0000000000aa',
      format: 'cbz',
      frameCount: 3,
    });
    const r = await extractDocumentImages(
      { kind: 'fs', path: '/tmp/a.cbz' },
      { maxSide: 2048 }
    );
    expect(r.buffer).toBe('img_off_00000000-0000-0000-0000-0000000000aa');
    expect(r.format).toBe('cbz');
    expect(r.frameCount).toBe(3);
    expect(mockNative.extractDocumentImages).toHaveBeenCalledWith(
      { kind: 'fs', path: '/tmp/a.cbz' },
      { maxSide: 2048 }
    );
  });

  it('maps no-images native error', async () => {
    mockNative.extractDocumentImages.mockRejectedValue(
      new Error('ERR_DOC_NO_IMAGES: no image-only sections')
    );
    await expect(
      extractDocumentImages({ kind: 'fs', path: '/tmp/text.epub' })
    ).rejects.toMatchObject({ code: DocumentErrorCode.NO_IMAGES });
  });

  it('does not export detectDocumentFormat', async () => {
    const mod = await import('../index');
    expect('detectDocumentFormat' in mod).toBe(false);
    expect('isLibarchiveEnabled' in mod).toBe(false);
  });
});
