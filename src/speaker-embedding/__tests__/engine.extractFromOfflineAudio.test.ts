jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeSpeakerEmbeddingExtractor: jest.fn(),
    unloadSpeakerEmbeddingExtractor: jest.fn(),
    computeSpeakerEmbeddingOffline: jest.fn(),
  },
}));

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForModelInit: jest.fn(
    async () => '/models/speaker-embedding'
  ),
}));

const mockCreateOfflineAudioBufferFromSamples = jest.fn();
const mockGetOfflineAudioBufferSamplesSlice = jest.fn();
const mockGetPipelineAudioBufferInfo = jest.fn();
const mockReleasePipelineAudioBuffer = jest.fn();

jest.mock('../../audiobuffer', () => ({
  createOfflineAudioBufferFromSamples: (...args: unknown[]) =>
    mockCreateOfflineAudioBufferFromSamples(...args),
  getOfflineAudioBufferSamplesSlice: (...args: unknown[]) =>
    mockGetOfflineAudioBufferSamplesSlice(...args),
  getPipelineAudioBufferInfo: (...args: unknown[]) =>
    mockGetPipelineAudioBufferInfo(...args),
  releasePipelineAudioBuffer: (...args: unknown[]) =>
    mockReleasePipelineAudioBuffer(...args),
  resolvePipelineAudioBufferId: jest.fn((value: unknown) => String(value)),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { createSpeakerEmbeddingEngine } from '../engine';

describe('createSpeakerEmbeddingEngine extractFromOfflineAudio', () => {
  const native = SherpaOnnx as unknown as {
    initializeSpeakerEmbeddingExtractor: jest.Mock;
    unloadSpeakerEmbeddingExtractor: jest.Mock;
    computeSpeakerEmbeddingOffline: jest.Mock;
  };

  const emb = [0.1, 0.2, 0.3, 0.4];

  beforeEach(() => {
    jest.clearAllMocks();
    native.initializeSpeakerEmbeddingExtractor.mockResolvedValue({
      success: true,
      dim: 4,
      modelType: 'wespeaker',
    });
    native.unloadSpeakerEmbeddingExtractor.mockResolvedValue(null);
    native.computeSpeakerEmbeddingOffline.mockResolvedValue({ embedding: emb });
  });

  it('full extract calls compute without range args', async () => {
    const engine = await createSpeakerEmbeddingEngine({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    const result = await engine.extractFromOfflineAudio('off_audio');
    expect(result).toEqual(Float32Array.from(emb));
    expect(native.computeSpeakerEmbeddingOffline).toHaveBeenCalledWith(
      engine.instanceId,
      'off_audio'
    );
    expect(mockGetOfflineAudioBufferSamplesSlice).not.toHaveBeenCalled();
    expect(mockCreateOfflineAudioBufferFromSamples).not.toHaveBeenCalled();
  });

  it('range extract passes start/end to native compute (no JS staging)', async () => {
    const engine = await createSpeakerEmbeddingEngine({
      modelSource: { kind: 'fs', path: '/models/speaker-embedding' },
    });

    const result = await engine.extractFromOfflineAudio('off_audio', {
      startSample: 100.7,
      endSample: 1600.2,
    });
    expect(result).toEqual(Float32Array.from(emb));
    expect(native.computeSpeakerEmbeddingOffline).toHaveBeenCalledWith(
      engine.instanceId,
      'off_audio',
      100,
      1600
    );
    expect(mockGetOfflineAudioBufferSamplesSlice).not.toHaveBeenCalled();
    expect(mockCreateOfflineAudioBufferFromSamples).not.toHaveBeenCalled();
    expect(mockGetPipelineAudioBufferInfo).not.toHaveBeenCalled();
    expect(mockReleasePipelineAudioBuffer).not.toHaveBeenCalled();
  });
});
