import { ModelCategory } from '../types';
import {
  filterHfRepoNamesForCategory,
  isHfRepoNameSupportedForCategory,
} from '../sources/hf-author-filter';

describe('isHfRepoNameSupportedForCategory', () => {
  it('accepts sherpa-onnx archive-style STT repo names for STT', () => {
    expect(
      isHfRepoNameSupportedForCategory(
        ModelCategory.Stt,
        'sherpa-onnx-paraformer-zh-int8-2025-10-07'
      )
    ).toBe(true);
  });

  it('rejects VAD onnx names for STT', () => {
    expect(
      isHfRepoNameSupportedForCategory(ModelCategory.Stt, 'silero-vad-onnx')
    ).toBe(false);
  });

  it('accepts tar.bz2-style TTS repo names for TTS', () => {
    expect(
      isHfRepoNameSupportedForCategory(ModelCategory.Tts, 'vits-melo-tts-zh_en')
    ).toBe(true);
  });

  it('name filter keeps tar.bz2 repos for STT and drops onnx-only VAD', () => {
    const names = [
      'sherpa-onnx-paraformer-zh-int8-2025-10-07',
      'vits-melo-tts-zh_en',
      'silero-vad-onnx',
    ];
    expect(filterHfRepoNamesForCategory(ModelCategory.Stt, names)).toEqual([
      'sherpa-onnx-paraformer-zh-int8-2025-10-07',
      'vits-melo-tts-zh_en',
    ]);
    expect(filterHfRepoNamesForCategory(ModelCategory.Vad, names)).toEqual([
      'silero-vad-onnx',
    ]);
  });
});
