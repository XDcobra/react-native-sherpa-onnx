import { ModelCategory } from '../../types';
import {
  getAssetExtension,
  isAssetSupportedForCategory,
  stripAssetExtension,
} from '../github-asset-rules';

describe('github-asset-rules — Separation', () => {
  it('accepts Spleeter archives and UVR ONNX files', () => {
    expect(
      isAssetSupportedForCategory(
        ModelCategory.Separation,
        'sherpa-onnx-spleeter-2stems-fp16.tar.bz2',
        'tar.bz2'
      )
    ).toBe(true);
    expect(
      isAssetSupportedForCategory(
        ModelCategory.Separation,
        'UVR-MDX-NET-Inst_1.onnx',
        'onnx'
      )
    ).toBe(true);
  });

  it('does not accept ONNX for archive-only Diarization (contrast)', () => {
    expect(
      isAssetSupportedForCategory(
        ModelCategory.Diarization,
        'model.onnx',
        'onnx'
      )
    ).toBe(false);
  });

  it('strips extensions for model ids', () => {
    expect(
      stripAssetExtension('sherpa-onnx-spleeter-2stems-fp16.tar.bz2', 'tar.bz2')
    ).toBe('sherpa-onnx-spleeter-2stems-fp16');
    expect(getAssetExtension('UVR-MDX-NET-Inst_1.onnx')).toBe('onnx');
    expect(stripAssetExtension('UVR-MDX-NET-Inst_1.onnx', 'onnx')).toBe(
      'UVR-MDX-NET-Inst_1'
    );
  });
});

describe('github-asset-rules — Enhancement contrast', () => {
  it('allows only ONNX for Enhancement', () => {
    expect(
      isAssetSupportedForCategory(
        ModelCategory.Enhancement,
        'gtcrn_simple.onnx',
        'onnx'
      )
    ).toBe(true);
    expect(
      isAssetSupportedForCategory(
        ModelCategory.Enhancement,
        'model.tar.bz2',
        'tar.bz2'
      )
    ).toBe(false);
  });
});
