jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/mock/docs',
  exists: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
  mkdir: jest.fn(),
}));

jest.mock('../../../detect', () => ({
  detectModelsBatch: jest.fn(async () => []),
  detectModelResultMatchesCategory: jest.fn(() => true),
}));

import { exists, readFile } from '@dr.pogodin/react-native-fs';
import { ModelCategory } from '../../types';
import { getModelById, clearMemoryCacheForCategory } from '../../registry';
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

  it('falls back to secondary registered sources in getModelById when omitted or default', async () => {
    clearMemoryCacheForCategory(ModelCategory.Diarization);

    const mockExists = exists as unknown as jest.Mock;
    const mockReadFile = readFile as unknown as jest.Mock;

    mockExists.mockImplementation(async (path: string) => {
      if (path.includes('diarization-models')) {
        return true;
      }
      return false;
    });

    mockReadFile.mockImplementation(async (path: string) => {
      if (path.includes('diarization-models--github_xdcobra.json')) {
        return JSON.stringify({
          lastUpdated: new Date().toISOString(),
          models: [
            {
              id: 'diar_streaming_sortformer_4spk-v2.1',
              displayName: 'Streaming Sortformer 4-Speaker v2.1',
              category: ModelCategory.Diarization,
              sourceId: BUILTIN_SOURCE_IDS.GITHUB_XDCOBRA,
              layout: { kind: 'archive', format: 'tar.bz2', extract: true },
              assets: [
                {
                  relativePath: 'model.tar.bz2',
                  url: 'https://...',
                  bytes: 200,
                },
              ],
              bytes: 200,
              isStreaming: true,
              modelType: 'sortformer',
            },
          ],
        });
      }
      if (path.includes('diarization-models')) {
        return JSON.stringify({
          lastUpdated: new Date().toISOString(),
          models: [
            {
              id: 'sherpa-onnx-pyannote-segmentation-3-0',
              displayName: 'Pyannote Segmentation 3.0',
              category: ModelCategory.Diarization,
              sourceId: BUILTIN_SOURCE_IDS.GITHUB_K2_FSA,
              layout: { kind: 'archive', format: 'tar.bz2', extract: true },
              assets: [
                {
                  relativePath: 'model.tar.bz2',
                  url: 'https://...',
                  bytes: 100,
                },
              ],
              bytes: 100,
            },
          ],
        });
      }
      throw new Error(`File not found: ${path}`);
    });

    // 1. Model present in default source
    const pyannote = await getModelById(
      ModelCategory.Diarization,
      'sherpa-onnx-pyannote-segmentation-3-0'
    );
    expect(pyannote).not.toBeNull();
    expect(pyannote?.sourceId).toBe(BUILTIN_SOURCE_IDS.GITHUB_K2_FSA);

    // 2. Model in secondary source resolved when source is omitted or 'default'
    const sortformer = await getModelById(
      ModelCategory.Diarization,
      'diar_streaming_sortformer_4spk-v2.1'
    );
    expect(sortformer).not.toBeNull();
    expect(sortformer?.sourceId).toBe(BUILTIN_SOURCE_IDS.GITHUB_XDCOBRA);
    expect(sortformer?.isStreaming).toBe(true);

    const sortformerDefault = await getModelById(
      ModelCategory.Diarization,
      'diar_streaming_sortformer_4spk-v2.1',
      { source: 'default' }
    );
    expect(sortformerDefault).not.toBeNull();
    expect(sortformerDefault?.sourceId).toBe(BUILTIN_SOURCE_IDS.GITHUB_XDCOBRA);

    // 3. Unknown model returns null
    const unknown = await getModelById(
      ModelCategory.Diarization,
      'non-existent-model'
    );
    expect(unknown).toBeNull();

    // 4. If explicit non-matching source is given, secondary source is not searched
    const notInK2 = await getModelById(
      ModelCategory.Diarization,
      'diar_streaming_sortformer_4spk-v2.1',
      { source: BUILTIN_SOURCE_IDS.GITHUB_K2_FSA }
    );
    expect(notInK2).toBeNull();
  });
});
