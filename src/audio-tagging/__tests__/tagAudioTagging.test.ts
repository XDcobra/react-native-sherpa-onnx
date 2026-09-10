jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeAudioTagging: jest.fn(),
    tagAudioOffline: jest.fn(),
    unloadAudioTagging: jest.fn(),
    getCustomModelPathRequirements: jest.fn(async () => ({
      category: 'audiotagging',
      modelType: 'ced',
      fields: [
        { key: 'model', required: true },
        { key: 'labels', required: true },
      ],
    })),
    validateCustomModelPaths: jest.fn(async () => ({
      ok: true,
      category: 'audiotagging',
      modelType: 'ced',
      errors: [],
      missingRequired: [],
      unknownFields: [],
      fields: {},
    })),
  },
}));

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForModelInit: jest.fn(async () => '/models/ced-mini'),
  resolveModelFileSources: jest.fn(async (map: Record<string, any>) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
      out[k] = v.path ?? `/resolved/${k}`;
    }
    return out;
  }),
}));

jest.mock('../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: jest.fn((source: any) => {
    if (typeof source === 'string') return source;
    if (source?.id) return source.id;
    throw new Error('invalid buffer source');
  }),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { createAudioTagging, AudioTaggingErrorCode } from '../index';

describe('tagAudioTagging oneshot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (SherpaOnnx.initializeAudioTagging as jest.Mock).mockResolvedValue({
      success: true,
      modelType: 'ced',
    });
  });

  async function makeEngine() {
    return createAudioTagging({
      modelSource: { kind: 'fs', path: '/models/ced-mini' },
      topK: 5,
    });
  }

  it('maps native events to AudioTaggingResult with primary', async () => {
    (SherpaOnnx.tagAudioOffline as jest.Mock).mockResolvedValue({
      events: [
        { name: 'Speech', index: 0, prob: 0.9 },
        { name: 'Music', index: 1, prob: 0.4 },
      ],
      audioDuration: 1.5,
      elapsedMs: 12,
      topK: 5,
    });

    const engine = await makeEngine();
    const result = await engine.tag('off_test_buffer');

    expect(SherpaOnnx.tagAudioOffline).toHaveBeenCalledWith(
      engine.instanceId,
      'off_test_buffer',
      null,
      null,
      null
    );
    expect(result).toMatchObject({
      events: [
        { name: 'Speech', index: 0, prob: 0.9 },
        { name: 'Music', index: 1, prob: 0.4 },
      ],
      primary: { name: 'Speech', index: 0, prob: 0.9 },
      audioDuration: 1.5,
      elapsedMs: 12,
      topK: 5,
    });
  });

  it('passes topK override to native', async () => {
    (SherpaOnnx.tagAudioOffline as jest.Mock).mockResolvedValue({
      events: [],
      audioDuration: 0,
      elapsedMs: 1,
      topK: 2,
    });

    const engine = await makeEngine();
    await engine.tag({ id: 'off_clip' } as any, { topK: 2 });

    expect(SherpaOnnx.tagAudioOffline).toHaveBeenCalledWith(
      engine.instanceId,
      'off_clip',
      2,
      null,
      null
    );
  });

  it('rejects non-offline buffer ids', async () => {
    const engine = await makeEngine();
    await expect(engine.tag('live_abc')).rejects.toThrow(
      AudioTaggingErrorCode.INVALID_ARGUMENT
    );
    expect(SherpaOnnx.tagAudioOffline).not.toHaveBeenCalled();
  });

  it('rejects tag after destroy', async () => {
    (SherpaOnnx.unloadAudioTagging as jest.Mock).mockResolvedValue(undefined);
    const engine = await makeEngine();
    await engine.destroy();
    await expect(engine.tag('off_clip')).rejects.toThrow(
      AudioTaggingErrorCode.DESTROYED
    );
  });
});
