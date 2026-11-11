import { getModelsBaseDir } from '../paths';
import {
  filterLanguageIdWhisperModels,
  isLanguageIdWhisperModelId,
} from '../languageIdWhisper';
import { ModelCategory } from '../types';

describe('isLanguageIdWhisperModelId', () => {
  it('accepts multilingual Whisper ids', () => {
    expect(isLanguageIdWhisperModelId('sherpa-onnx-whisper-tiny')).toBe(true);
    expect(isLanguageIdWhisperModelId('sherpa-onnx-whisper-base')).toBe(true);
    expect(isLanguageIdWhisperModelId('sherpa-onnx-whisper-large-v3')).toBe(
      true
    );
  });

  it('rejects English-only, aishell, and non-whisper ids', () => {
    expect(isLanguageIdWhisperModelId('sherpa-onnx-whisper-tiny.en')).toBe(
      false
    );
    expect(isLanguageIdWhisperModelId('sherpa-onnx-whisper-small.en')).toBe(
      false
    );
    expect(
      isLanguageIdWhisperModelId('sherpa-onnx-whisper-medium-aishell')
    ).toBe(false);
    expect(
      isLanguageIdWhisperModelId(
        'sherpa-onnx-streaming-zipformer-en-2023-06-26'
      )
    ).toBe(false);
  });
});

describe('filterLanguageIdWhisperModels', () => {
  it('keeps only multilingual Whisper entries', () => {
    const filtered = filterLanguageIdWhisperModels([
      { id: 'sherpa-onnx-whisper-tiny' },
      { id: 'sherpa-onnx-whisper-tiny.en' },
      { id: 'sherpa-onnx-zipformer-en' },
    ]);
    expect(filtered.map((m) => m.id)).toEqual(['sherpa-onnx-whisper-tiny']);
  });
});

describe('LanguageId path alias', () => {
  it('shares the STT models base directory', () => {
    expect(getModelsBaseDir(ModelCategory.LanguageId)).toBe(
      getModelsBaseDir(ModelCategory.Stt)
    );
  });
});
