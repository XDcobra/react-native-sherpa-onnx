jest.mock('../../../detect', () => ({
  detectModelsBatch: jest.fn(async () => []),
  detectModelResultMatchesCategory: jest.fn(() => true),
}));

import { ModelCategory } from '../../types';
import {
  BUILTIN_SOURCE_IDS,
  buildSourceFetchContext,
  configureSource,
  ensureBuiltinSourcesRegistered,
  getDefaultSourceForCategory,
  getSource,
  listBuiltinSources,
  registerSource,
  setDefaultSourceForCategory,
  unregisterSource,
  type SourceProvider,
} from '../index';

describe('source registry', () => {
  beforeEach(() => {
    ensureBuiltinSourcesRegistered();
  });

  it('registers builtin providers with expected defaults', () => {
    const builtins = listBuiltinSources().map((s) => s.id);

    expect(builtins).toContain(BUILTIN_SOURCE_IDS.GITHUB_K2_FSA);
    expect(builtins).toContain(BUILTIN_SOURCE_IDS.GITHUB_XDCOBRA);

    expect(getDefaultSourceForCategory(ModelCategory.Tts)).toBe(
      BUILTIN_SOURCE_IDS.GITHUB_K2_FSA
    );
    expect(getDefaultSourceForCategory(ModelCategory.Alignment)).toBe(
      BUILTIN_SOURCE_IDS.GITHUB_XDCOBRA
    );
  });

  it('supports registering a custom source and configuring headers', () => {
    const sourceId = 'custom_registry_test';
    const provider: SourceProvider = {
      id: sourceId,
      label: 'Custom',
      supportsCategory: () => true,
      async listModels() {
        return [];
      },
      defaultHeaders() {
        return {
          Accept: 'application/json',
        };
      },
    };

    registerSource(provider);
    configureSource(sourceId, {
      headers: {
        'X-Test': '1',
      },
      token: 'abc',
      tokenScheme: 'Bearer',
    });

    const context = buildSourceFetchContext(sourceId, getSource(sourceId));
    expect(context.headers.Accept).toBe('application/json');
    expect(context.headers['X-Test']).toBe('1');
    expect(context.token).toBe('abc');

    setDefaultSourceForCategory(ModelCategory.Stt, sourceId);
    expect(getDefaultSourceForCategory(ModelCategory.Stt)).toBe(sourceId);

    unregisterSource(sourceId);
  });
});
