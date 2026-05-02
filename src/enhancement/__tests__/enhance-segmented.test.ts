jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeEnhancement: jest.fn(),
    unloadEnhancement: jest.fn(),
    enhanceOfflineAudioBuffers: jest.fn(),
    populateOfflineAudioBufferIfEmpty: jest.fn(),
  },
}));

jest.mock('../../utils', () => ({
  resolveModelPath: jest.fn(async () => '/models/enhancement'),
}));

jest.mock('../../detect', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/enhancement',
    assetName: 'model.onnx',
  })),
}));

jest.mock('../../model-languages', () => ({
  resolvePublicLanguageHints: jest.fn(() => []),
}));

jest.mock('../../audiobuffer', () => ({
  releasePipelineAudioBuffer: jest.fn(),
  resolvePipelineAudioBufferId: jest.fn((value: unknown) => String(value)),
}));

jest.mock('../orchestrate', () => ({
  runOfflineEnhancementPipeline: jest.fn(),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { releasePipelineAudioBuffer } from '../../audiobuffer';
import { createEnhancement } from '../index';
import { runOfflineEnhancementPipeline } from '../orchestrate';

describe('enhancement segmented offline API', () => {
  const native = SherpaOnnx as unknown as {
    initializeEnhancement: jest.Mock;
    unloadEnhancement: jest.Mock;
    enhanceOfflineAudioBuffers: jest.Mock;
    populateOfflineAudioBufferIfEmpty: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    native.initializeEnhancement.mockResolvedValue({
      success: true,
      detectedModels: [],
    });
    native.unloadEnhancement.mockResolvedValue(null);
    native.enhanceOfflineAudioBuffers.mockResolvedValue(null);
    native.populateOfflineAudioBufferIfEmpty.mockResolvedValue(null);
    (releasePipelineAudioBuffer as jest.Mock).mockResolvedValue(undefined);
  });

  it('uses native single-shot path when segmentation is off', async () => {
    const enhancement = await createEnhancement({
      modelPath: { type: 'file', path: '/models/enhancement' },
    });

    const result = await enhancement.enhance('off_input', 'off_output');

    expect(result).toMatchObject({
      status: 'complete',
      totalSegments: 1,
      completedSegments: 1,
      skippedSegments: [],
    });
    expect(native.enhanceOfflineAudioBuffers).toHaveBeenCalledWith(
      expect.stringMatching(/^enhancement_/),
      'off_input',
      'off_output'
    );
    expect(runOfflineEnhancementPipeline).not.toHaveBeenCalled();
    expect(native.populateOfflineAudioBufferIfEmpty).not.toHaveBeenCalled();
  });

  it('runs segmented orchestration and populates caller-owned audioOut', async () => {
    (runOfflineEnhancementPipeline as jest.Mock).mockResolvedValue({
      status: 'complete',
      totalSegments: 2,
      completedSegments: 2,
      skippedSegments: [],
      processingTimeMs: 12,
      outputBuffer: { bufferId: 'off_orchestrated' },
    });

    const enhancement = await createEnhancement({
      modelPath: { type: 'file', path: '/models/enhancement' },
    });

    const result = await enhancement.enhance('off_input', 'off_output', {
      segmentation: { mode: 'auto' },
    });

    expect(result.status).toBe('complete');
    expect(runOfflineEnhancementPipeline).toHaveBeenCalledWith(
      'off_input',
      expect.stringMatching(/^enhancement_/),
      { segmentation: { mode: 'auto' } }
    );
    expect(native.populateOfflineAudioBufferIfEmpty).toHaveBeenCalledWith(
      'off_output',
      'off_orchestrated',
      undefined
    );
    expect(releasePipelineAudioBuffer).toHaveBeenCalledWith('off_orchestrated');
  });

  it('populates partial_result output when orchestration returns a partial buffer', async () => {
    (runOfflineEnhancementPipeline as jest.Mock).mockResolvedValue({
      status: 'partial',
      totalSegments: 3,
      completedSegments: 1,
      skippedSegments: [],
      failedSegment: {
        segmentIndex: 1,
        segmentId: 'speech_1',
        error: 'boom',
        retryCount: 0,
      },
      processingTimeMs: 20,
      outputBuffer: { bufferId: 'off_partial' },
    });

    const enhancement = await createEnhancement({
      modelPath: { type: 'file', path: '/models/enhancement' },
    });

    const result = await enhancement.enhance('off_input', 'off_output', {
      segmentation: { mode: 'auto' },
      errorRecovery: 'partial_result',
    });

    expect(result.status).toBe('partial');
    expect(result.failedSegment?.segmentId).toBe('speech_1');
    expect(native.populateOfflineAudioBufferIfEmpty).toHaveBeenCalledWith(
      'off_output',
      'off_partial',
      undefined
    );
  });

  it('does not populate audioOut when abort recovery fails without output', async () => {
    (runOfflineEnhancementPipeline as jest.Mock).mockResolvedValue({
      status: 'failed',
      totalSegments: 2,
      completedSegments: 0,
      skippedSegments: [],
      failedSegment: {
        segmentIndex: 0,
        segmentId: 'speech_0',
        error: 'boom',
        retryCount: 0,
      },
      processingTimeMs: 4,
    });

    const enhancement = await createEnhancement({
      modelPath: { type: 'file', path: '/models/enhancement' },
    });

    const result = await enhancement.enhance('off_input', 'off_output', {
      segmentation: { mode: 'auto' },
      errorRecovery: 'abort',
    });

    expect(result.status).toBe('failed');
    expect(native.populateOfflineAudioBufferIfEmpty).not.toHaveBeenCalled();
    expect(releasePipelineAudioBuffer).not.toHaveBeenCalled();
  });
});
