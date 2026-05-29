import { ModelCategory } from '../../../types';
import {
  configureHuggingFaceSource,
  getHuggingFaceSourceConfig,
  huggingfaceProvider,
} from '../huggingface';

describe('huggingface provider config', () => {
  it('stores per-category repo configuration', () => {
    configureHuggingFaceSource({
      repos: {
        [ModelCategory.Stt]: [
          {
            repo: 'org/repo',
            revision: 'main',
          },
        ],
      },
    });

    const config = getHuggingFaceSourceConfig();
    expect(config.repos?.[ModelCategory.Stt]?.[0]?.repo).toBe('org/repo');
    expect(huggingfaceProvider.supportsCategory(ModelCategory.Stt)).toBe(true);
  });
});
