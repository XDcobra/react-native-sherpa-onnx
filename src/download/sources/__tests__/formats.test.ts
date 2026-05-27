import { DownloadError } from '../errors';
import {
  SUPPORTED_ARCHIVE_FORMATS,
  assertSupportedLayout,
  assertValidLayoutAssets,
  isSupportedArchiveFormat,
} from '../formats';

describe('archive format gates', () => {
  it('exposes supported archive formats', () => {
    expect(SUPPORTED_ARCHIVE_FORMATS).toEqual([
      'tar.bz2',
      'tar.gz',
      'tar.xz',
      'tar.zst',
    ]);

    for (const format of SUPPORTED_ARCHIVE_FORMATS) {
      expect(isSupportedArchiveFormat(format)).toBe(true);
    }
    expect(isSupportedArchiveFormat('zip')).toBe(false);
  });

  it('rejects unsupported archive layouts', () => {
    expect(() =>
      assertSupportedLayout({
        kind: 'archive',
        format: 'zip' as never,
        extract: true,
      })
    ).toThrow(DownloadError);
  });

  it('validates layout and asset count compatibility', () => {
    expect(() =>
      assertValidLayoutAssets({
        layout: {
          kind: 'archive',
          format: 'tar.bz2',
          extract: true,
        },
        assetCount: 2,
      })
    ).toThrow('Archive layout requires exactly one asset');

    expect(() =>
      assertValidLayoutAssets({
        layout: {
          kind: 'folder',
          format: 'none',
          extract: false,
        },
        assetCount: 0,
      })
    ).toThrow('Folder layout requires at least one asset');
  });
});
