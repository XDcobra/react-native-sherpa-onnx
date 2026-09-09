jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeKeywordSpotting: jest.fn(),
    unloadKeywordSpotting: jest.fn(),
    startKeywordSpottingPipeline: jest.fn(),
    stopStreamingPipeline: jest.fn(),
    flushStreamingPipeline: jest.fn(),
    resetStreamingPipeline: jest.fn(),
    getStreamingPipelineStatus: jest.fn(),
  },
}));

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForModelInit: jest.fn(),
}));

jest.mock('../detectKwsModel', () => ({
  detectKwsModel: jest.fn(),
}));

jest.mock('../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: jest.fn((v) =>
    typeof v === 'string' ? v : v.bufferId
  ),
}));

jest.mock('../../textbuffer', () => ({
  resolvePipelineTextBufferId: jest.fn((v) =>
    typeof v === 'string' ? v : v.bufferId
  ),
  subscribeLiveTextBufferEvents: jest.fn(),
}));

jest.mock('../../audiobuffer/streamingPipelineCompletion', () => {
  const unsettled = () =>
    new Promise(() => {
      /* intentionally unsettled until test teardown */
    });
  return {
    createStreamingPipelineCompletionPromise: jest.fn(() => unsettled()),
  };
});

import SherpaOnnx from '../../NativeSherpaOnnx';
import { resolveFileSourceForModelInit } from '../../detect/resolveModelInput';
import { subscribeLiveTextBufferEvents } from '../../textbuffer';
import { createKeywordSpotting } from '../createKeywordSpotting';
import { detectKwsModel } from '../detectKwsModel';

describe('KeywordSpottingEngine.spot', () => {
  const native = SherpaOnnx as unknown as {
    initializeKeywordSpotting: jest.Mock;
    unloadKeywordSpotting: jest.Mock;
    startKeywordSpottingPipeline: jest.Mock;
    stopStreamingPipeline: jest.Mock;
    getStreamingPipelineStatus: jest.Mock;
  };
  const resolveModel = resolveFileSourceForModelInit as jest.Mock;
  const detect = detectKwsModel as jest.Mock;
  const subscribe = subscribeLiveTextBufferEvents as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    resolveModel.mockResolvedValue('/models/kws');
    detect.mockResolvedValue({
      success: true,
      isStreaming: true,
      detectedModels: [],
      modelType: 'transducer',
      paths: {
        encoder: '/models/kws/encoder.onnx',
        decoder: '/models/kws/decoder.onnx',
        joiner: '/models/kws/joiner.onnx',
        tokens: '/models/kws/tokens.txt',
        keywords: '/models/kws/keywords.txt',
      },
    });
    native.initializeKeywordSpotting.mockResolvedValue({ success: true });
    native.unloadKeywordSpotting.mockResolvedValue(undefined);
    native.startKeywordSpottingPipeline.mockResolvedValue({
      pipelineId: 'pipe-1',
    });
    native.stopStreamingPipeline.mockResolvedValue(undefined);
    native.getStreamingPipelineStatus.mockResolvedValue({
      pipelineId: 'pipe-1',
      isRunning: false,
      chunksProcessed: 0,
      unitsRead: 0,
      unitsWritten: 0,
      error: null,
    });
    subscribe.mockReturnValue(jest.fn());
  });

  async function createEngine() {
    return createKeywordSpotting({
      modelSource: { kind: 'fs', path: '/models/kws' },
    });
  }

  it('starts the native pipeline and returns a streaming handle', async () => {
    const engine = await createEngine();
    const handle = await engine.spot('live_audio', 'live_text', {
      chunkSize: 3200,
      keywords: '你好',
    });

    expect(native.startKeywordSpottingPipeline).toHaveBeenCalledWith(
      engine.instanceId,
      'live_audio',
      'live_text',
      3200,
      '你好'
    );
    expect(handle.pipelineId).toBe('pipe-1');
    expect(handle.instanceId).toBe(engine.instanceId);
  });

  it('rejects a second spot while a pipeline is running', async () => {
    native.getStreamingPipelineStatus.mockResolvedValue({
      pipelineId: 'pipe-1',
      isRunning: true,
      chunksProcessed: 1,
      unitsRead: 1,
      unitsWritten: 0,
      error: null,
    });
    const engine = await createEngine();
    await engine.spot('live_audio', 'live_text');

    await expect(engine.spot('live_audio2', 'live_text2')).rejects.toThrow(
      'already running'
    );
  });

  it('wires onKeyword via live text segment subscription', async () => {
    let onSegment: ((event: unknown) => void) | undefined;
    subscribe.mockImplementation((_id, callbacks) => {
      onSegment = callbacks.onSegment;
      return jest.fn();
    });
    const onKeyword = jest.fn();
    const engine = await createEngine();
    await engine.spot('live_audio', 'live_text', { onKeyword });

    expect(subscribe).toHaveBeenCalledWith(
      'live_text',
      expect.objectContaining({ onSegment: expect.any(Function) })
    );

    onSegment?.({
      bufferId: 'live_text',
      totalSegments: 1,
      segment: {
        domain: 'text',
        text: 'hi',
        reason: 'endpoint',
        segmentIndex: 0,
        tokens: ['h', 'i'],
        timestamps: [0.1, 0.2],
        meta: { source: 'kws_stream', keyword: 'hi', startTime: 0.05 },
      },
    });

    expect(onKeyword).toHaveBeenCalledWith({
      keyword: 'hi',
      tokens: ['h', 'i'],
      timestamps: [0.1, 0.2],
      startTime: 0.05,
      segmentIndex: 0,
    });
  });

  it('ignores non-kws_stream segments for onKeyword', async () => {
    let onSegment: ((event: unknown) => void) | undefined;
    subscribe.mockImplementation((_id, callbacks) => {
      onSegment = callbacks.onSegment;
      return jest.fn();
    });
    const onKeyword = jest.fn();
    const engine = await createEngine();
    await engine.spot('live_audio', 'live_text', { onKeyword });

    onSegment?.({
      bufferId: 'live_text',
      totalSegments: 1,
      segment: {
        domain: 'text',
        text: 'hello from stt',
        reason: 'endpoint',
        segmentIndex: 0,
        meta: { source: 'stt_stream' },
      },
    });

    expect(onKeyword).not.toHaveBeenCalled();
  });

  it('stops an active pipeline on destroy', async () => {
    native.getStreamingPipelineStatus.mockResolvedValue({
      pipelineId: 'pipe-1',
      isRunning: true,
      chunksProcessed: 1,
      unitsRead: 1,
      unitsWritten: 0,
      error: null,
    });
    const engine = await createEngine();
    await engine.spot('live_audio', 'live_text');
    await engine.destroy();

    expect(native.stopStreamingPipeline).toHaveBeenCalledWith('pipe-1');
    expect(native.unloadKeywordSpotting).toHaveBeenCalledWith(
      engine.instanceId
    );
  });
});
