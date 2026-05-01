jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    alignOfflineTextToAudio: jest.fn().mockResolvedValue({
      outputSegmentBufferId: 'seg_out',
      segmentsWritten: 1,
    }),
  },
}));

jest.mock('../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: (source: unknown) =>
    typeof source === 'string'
      ? source
      : (source as { bufferId?: string })?.bufferId ?? 'off_audio',
}));

jest.mock('../../textbuffer', () => ({
  resolvePipelineTextBufferId: (source: unknown) =>
    typeof source === 'string'
      ? source
      : (source as { bufferId?: string })?.bufferId ?? 'txt_off',
}));

jest.mock('../../segmentbuffer', () => ({
  getOfflineSegmentBufferSegments: jest.fn().mockResolvedValue([
    {
      segmentId: 'seg_anchor_0',
      kind: 'speech',
      startSample: 0,
      endSample: 3200,
      sampleRate: 16000,
      startMs: 0,
      endMs: 200,
    },
  ]),
  resolveOfflineSegmentBufferId: (source: unknown) =>
    typeof source === 'string'
      ? source
      : (source as { bufferId?: string })?.bufferId ?? 'seg_off',
}));

jest.mock('../../utils', () => ({
  resolveModelPath: jest.fn().mockResolvedValue('/tmp/alignment-model'),
}));

import { createAlignment } from '../engine';

describe('createAlignment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an engine with the required methods', () => {
    const engine = createAlignment();

    expect(typeof engine.alignTextToAudio).toBe('function');
    expect(typeof engine.destroy).toBe('function');
  });

  it('destroy is idempotent', async () => {
    const engine = createAlignment();

    await expect(engine.destroy()).resolves.toBeUndefined();
    await expect(engine.destroy()).resolves.toBeUndefined();
  });
});
