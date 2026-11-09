import { digestFromHfLfs, mapHfSiblingsToDigests } from '../hfDigestResolve';

describe('hfDigestResolve', () => {
  it('prefers lfs.sha256 over oid', () => {
    expect(
      digestFromHfLfs({
        sha256: 'Aa'.repeat(32),
        oid: 'Bb'.repeat(32),
      })
    ).toBe('aa'.repeat(32));
  });

  it('falls back to lfs.oid when sha256 missing', () => {
    expect(digestFromHfLfs({ oid: 'Cc'.repeat(32) })).toBe('cc'.repeat(32));
  });

  it('maps blobs=true siblings with digests and sizes', () => {
    const map = mapHfSiblingsToDigests([
      {
        rfilename: 'model.onnx',
        size: 10,
        lfs: { sha256: 'Dd'.repeat(32), size: 99 },
      },
      {
        rfilename: 'tokens.txt',
        size: 12,
      },
    ]);

    expect(map.get('model.onnx')).toEqual({
      relativePath: 'model.onnx',
      sha256: 'dd'.repeat(32),
      bytes: 99,
    });
    expect(map.get('tokens.txt')).toEqual({
      relativePath: 'tokens.txt',
      sha256: undefined,
      bytes: 12,
    });
  });

  it('without lfs (no blobs) yields no digests', () => {
    const map = mapHfSiblingsToDigests([{ rfilename: 'model.onnx', size: 50 }]);
    expect(map.get('model.onnx')?.sha256).toBeUndefined();
    expect(map.get('model.onnx')?.bytes).toBe(50);
  });
});
