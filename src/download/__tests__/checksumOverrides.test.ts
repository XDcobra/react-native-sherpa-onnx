import {
  applyKnownChecksumOverrides,
  knownArchiveChecksumOverride,
  resolveArchiveChecksum,
} from '../checksumOverrides';

describe('checksumOverrides', () => {
  it('overrides stale spleeter release checksums', () => {
    expect(
      knownArchiveChecksumOverride('sherpa-onnx-spleeter-2stems.tar.bz2')
    ).toBe('e26401d9c1801f43c0229731d78d32c2e80085e3aceedeb25f29d2de5fa68ca2');
    expect(
      knownArchiveChecksumOverride(
        '/data/models/sherpa-onnx-spleeter-2stems-fp16.tar.bz2'
      )
    ).toBe('d54561979bd2e08a51e7dbd99ac36bb47564e089eefd403636dbca93e811bba2');
  });

  it('prefers override over stale published checksum', () => {
    expect(
      resolveArchiveChecksum(
        'sherpa-onnx-spleeter-2stems-int8.tar.bz2',
        'a04f196c07454657e2a6bd705f932e1cc0f7c249d469c4695caded46f8599c96'
      )
    ).toBe('c5dc8edfa08cc9a6d82670fcca15cfe671e446385e1a28c9da8c1816d238ea17');
  });

  it('keeps unrelated published checksums', () => {
    expect(resolveArchiveChecksum('other-model.tar.bz2', 'Aa'.repeat(32))).toBe(
      'aa'.repeat(32)
    );
  });

  it('applies overrides onto a checksum map', () => {
    const map = applyKnownChecksumOverrides(
      new Map([
        [
          'sherpa-onnx-spleeter-2stems.tar.bz2',
          '69b43d35b4cfed03b14c3da6bc64b1cd9e2f75a993f064d953e83d98747828c7',
        ],
      ])
    );
    expect(map.get('sherpa-onnx-spleeter-2stems.tar.bz2')).toBe(
      'e26401d9c1801f43c0229731d78d32c2e80085e3aceedeb25f29d2de5fa68ca2'
    );
  });
});
