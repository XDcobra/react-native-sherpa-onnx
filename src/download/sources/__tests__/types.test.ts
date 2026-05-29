import { ModelCategory } from '../../types';
import { isArchiveLayout, isFolderLayout, type SourceModel } from '../types';

describe('download source contract types', () => {
  it('detects archive and folder layouts', () => {
    const archive: SourceModel = {
      id: 'tiny',
      displayName: 'Tiny',
      category: ModelCategory.Stt,
      layout: {
        kind: 'archive',
        format: 'tar.bz2',
        extract: true,
      },
      assets: [
        {
          relativePath: 'tiny.tar.bz2',
          url: 'https://example.invalid/tiny.tar.bz2',
          bytes: 100,
        },
      ],
      bytes: 100,
    };

    const folder: SourceModel = {
      id: 'vad',
      displayName: 'VAD',
      category: ModelCategory.Vad,
      layout: {
        kind: 'folder',
        format: 'none',
        extract: false,
      },
      assets: [
        {
          relativePath: 'vad.onnx',
          url: 'https://example.invalid/vad.onnx',
          bytes: 200,
        },
      ],
      bytes: 200,
    };

    expect(isArchiveLayout(archive.layout)).toBe(true);
    expect(isFolderLayout(archive.layout)).toBe(false);

    expect(isFolderLayout(folder.layout)).toBe(true);
    expect(isArchiveLayout(folder.layout)).toBe(false);
  });
});
