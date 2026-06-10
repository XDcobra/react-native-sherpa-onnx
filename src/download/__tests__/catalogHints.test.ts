import { ModelCategory } from '../types';
import { categoryUsesCatalogDetect } from '../catalogDetectCategories';

describe('categoryUsesCatalogDetect', () => {
  it('includes detect-backed download categories', () => {
    expect(categoryUsesCatalogDetect(ModelCategory.Tts)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.Stt)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.Qnn)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.Vad)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.Punctuation)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.Enhancement)).toBe(true);
    expect(categoryUsesCatalogDetect(ModelCategory.Alignment)).toBe(true);
  });

  it('excludes diarization and separation', () => {
    expect(categoryUsesCatalogDetect(ModelCategory.Diarization)).toBe(false);
    expect(categoryUsesCatalogDetect(ModelCategory.Separation)).toBe(false);
  });
});
