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

describe('github-asset-rules — Language Identification', () => {
  it('accepts multilingual Whisper archives from asr-models', () => {
    expect(
      isAssetSupportedForCategory(
        ModelCategory.LanguageId,
        'sherpa-onnx-whisper-tiny.tar.bz2',
        'tar.bz2'
      )
    ).toBe(true);
    expect(
      isAssetSupportedForCategory(
        ModelCategory.LanguageId,
        'sherpa-onnx-whisper-base.tar.bz2',
        'tar.bz2'
      )
    ).toBe(true);
    expect(
      isAssetSupportedForCategory(
        ModelCategory.LanguageId,
        'sherpa-onnx-whisper-large-v3.tar.bz2',
        'tar.bz2'
      )
    ).toBe(true);
  });

  it('rejects English-only or non-multilingual whisper models and non-whisper models', () => {
    expect(
      isAssetSupportedForCategory(
        ModelCategory.LanguageId,
        'sherpa-onnx-whisper-tiny.en.tar.bz2',
        'tar.bz2'
      )
    ).toBe(false);
    expect(
      isAssetSupportedForCategory(
        ModelCategory.LanguageId,
        'sherpa-onnx-whisper-small.en.tar.bz2',
        'tar.bz2'
      )
    ).toBe(false);
    expect(
      isAssetSupportedForCategory(
        ModelCategory.LanguageId,
        'sherpa-onnx-whisper-medium-aishell.tar.bz2',
        'tar.bz2'
      )
    ).toBe(false);
    expect(
      isAssetSupportedForCategory(
        ModelCategory.LanguageId,
        'sherpa-onnx-streaming-zipformer-en-2023-06-26.tar.bz2',
        'tar.bz2'
      )
    ).toBe(false);
    expect(
      isAssetSupportedForCategory(
        ModelCategory.LanguageId,
        'whisper-tiny.onnx',
        'onnx'
      )
    ).toBe(false);
  });
});
