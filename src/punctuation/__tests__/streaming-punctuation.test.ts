jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectPunctuationModel: jest.fn(),
    initializeOnlinePunctuation: jest.fn(),
    startStreamingPunctuationPipeline: jest.fn(),
    unloadOnlinePunctuation: jest.fn(),
    stopStreamingPipeline: jest.fn(),
    flushStreamingPipeline: jest.fn(),
    resetStreamingPipeline: jest.fn(),
    getStreamingPipelineStatus: jest.fn(),
  },
}));

jest.mock('../../detect', () => ({
  resolveFileSourceForModelInit: jest.fn(
    async () => '/models/punctuation-online'
  ),
}));

jest.mock('../../audiobuffer/streamingPipelineCompletion', () => ({
  createStreamingPipelineCompletionPromise: jest.fn(() => Promise.resolve({})),
}));

jest.mock('../../segment', () => ({
  attachSegmentationEngine: jest.fn(),
  detachSegmentationEngine: jest.fn(),
}));

jest.mock('../../textbuffer', () => ({
  getPipelineTextBufferInfo: jest.fn(),
  getLiveTextBufferSegments: jest.fn(),
  resolvePipelineTextBufferId: jest.fn((value: unknown) => String(value)),
}));

jest.mock('../detect', () => ({
  createOnlinePunctuationConfig: jest.fn(),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import {
  attachSegmentationEngine,
  detachSegmentationEngine,
} from '../../segment';
import {
  getLiveTextBufferSegments,
  getPipelineTextBufferInfo,
} from '../../textbuffer';
import { createOnlinePunctuationConfig } from '../detect';
import { createStreamingPunctuation } from '../streaming';

describe('streaming punctuation', () => {
  const native = SherpaOnnx as unknown as {
    detectPunctuationModel: jest.Mock;
    initializeOnlinePunctuation: jest.Mock;
    startStreamingPunctuationPipeline: jest.Mock;
    unloadOnlinePunctuation: jest.Mock;
    stopStreamingPipeline: jest.Mock;
    flushStreamingPipeline: jest.Mock;
    resetStreamingPipeline: jest.Mock;
    getStreamingPipelineStatus: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (createOnlinePunctuationConfig as jest.Mock).mockResolvedValue({
      success: true,
      modelType: 'cnn_bilstm',
      isStreaming: true,
      detectedModels: [],
      paths: {
        cnn_bilstm: '/models/punctuation-online/model.onnx',
        bpe_vocab: '/models/punctuation-online/bpe.vocab',
      },
    });
    native.initializeOnlinePunctuation.mockResolvedValue({
      success: true,
      modelType: 'cnn_bilstm',
      detectedModels: [],
    });
    native.startStreamingPunctuationPipeline.mockResolvedValue({
      pipelineId: 'punct_pipeline_1',
    });
    native.unloadOnlinePunctuation.mockResolvedValue(null);
    native.stopStreamingPipeline.mockResolvedValue(null);
    native.flushStreamingPipeline.mockResolvedValue(null);
    native.resetStreamingPipeline.mockResolvedValue(null);
    native.getStreamingPipelineStatus.mockResolvedValue({
      pipelineId: 'punct_pipeline_1',
      isRunning: true,
      chunksProcessed: 1,
      unitsRead: 10,
      unitsWritten: 11,
      error: null,
    });
    (attachSegmentationEngine as jest.Mock).mockResolvedValue({
      engineId: 'seg_engine_1',
    });
    (detachSegmentationEngine as jest.Mock).mockResolvedValue(undefined);
    (getLiveTextBufferSegments as jest.Mock).mockResolvedValue([
      {
        text: 'Hello, world.',
        source: 'stt_stream',
        segmentIndex: 0,
        meta: {
          __segmentReason: 'punctuation',
          __segmentSource: 'segmentation_engine',
        },
      },
    ]);
    (getPipelineTextBufferInfo as jest.Mock).mockImplementation((id: string) =>
      Promise.resolve({
        bufferId: id,
        kind: id.startsWith('txt_live_')
          ? 'liveTextBuffer'
          : 'offlineTextBuffer',
        state: 'recording',
      })
    );
  });

  it('uses OnlinePunctuation and starts a LiveTextBuffer pipeline', async () => {
    const punc = await createStreamingPunctuation({
      modelSource: { kind: 'fs', path: '/models/punctuation-online' },
    });

    const handle = await punc.punctuate(
      'txt_live_11111111-1111-1111-1111-111111111111',
      'txt_live_22222222-2222-2222-2222-222222222222'
    );

    expect(native.initializeOnlinePunctuation).toHaveBeenCalledWith(
      expect.stringMatching(/^punc_on_/),
      '/models/punctuation-online',
      'auto',
      undefined,
      undefined,
      undefined
    );
    expect(native.startStreamingPunctuationPipeline).toHaveBeenCalledWith(
      punc.instanceId,
      'txt_live_11111111-1111-1111-1111-111111111111',
      'txt_live_22222222-2222-2222-2222-222222222222'
    );
    await handle.flush();
    await handle.reset();
    await handle.stop();
    expect(native.flushStreamingPipeline).toHaveBeenCalledWith(
      'punct_pipeline_1'
    );
    expect(native.resetStreamingPipeline).toHaveBeenCalledWith(
      'punct_pipeline_1'
    );
    expect(native.stopStreamingPipeline).toHaveBeenCalledWith(
      'punct_pipeline_1'
    );
  });

  it('rejects when detection reports a non-online model', async () => {
    (createOnlinePunctuationConfig as jest.Mock).mockRejectedValueOnce(
      new Error(
        'PUNCTUATION_INVALID_ARGUMENT: Streaming punctuation requires online cnn_bilstm'
      )
    );

    await expect(
      createStreamingPunctuation({
        modelSource: { kind: 'fs', path: '/models/punctuation-offline' },
      })
    ).rejects.toThrow('online cnn_bilstm');
    expect(native.initializeOnlinePunctuation).not.toHaveBeenCalled();
  });

  it('attaches text_punctuation_assisted segmentation by default in auto mode', async () => {
    const punc = await createStreamingPunctuation({
      modelSource: { kind: 'fs', path: '/models/punctuation-online' },
    });

    const handle = await punc.punctuate(
      'txt_live_11111111-1111-1111-1111-111111111111',
      'txt_live_22222222-2222-2222-2222-222222222222',
      { segmentation: { mode: 'auto' } }
    );
    await handle.completed;

    expect(attachSegmentationEngine).toHaveBeenCalledWith(
      'txt_live_11111111-1111-1111-1111-111111111111',
      {
        policy: expect.objectContaining({
          evaluator: 'text_punctuation_assisted',
          punctuationInstanceId: punc.instanceId,
        }),
      }
    );
    expect(detachSegmentationEngine).toHaveBeenCalledWith('seg_engine_1', {
      flushFinal: true,
    });
  });

  it('rejects offline buffers and continuous_frames policy', async () => {
    const punc = await createStreamingPunctuation({
      modelSource: { kind: 'fs', path: '/models/punctuation-online' },
    });

    await expect(
      punc.punctuate(
        'txt_off_11111111-1111-1111-1111-111111111111',
        'txt_live_22222222-2222-2222-2222-222222222222'
      )
    ).rejects.toThrow('streaming punctuation input buffer must be txt_live');

    await expect(
      punc.punctuate(
        'txt_live_11111111-1111-1111-1111-111111111111',
        'txt_live_22222222-2222-2222-2222-222222222222',
        {
          segmentation: {
            mode: 'auto',
            policy: { evaluator: 'continuous_frames' },
          },
        }
      )
    ).rejects.toThrow('requires a text segmentation evaluator');
  });

  it('allows pull API reads from streaming punctuation output segments', async () => {
    const punc = await createStreamingPunctuation({
      modelSource: { kind: 'fs', path: '/models/punctuation-online' },
    });

    const outputId = 'txt_live_22222222-2222-2222-2222-222222222222';
    const handle = await punc.punctuate(
      'txt_live_11111111-1111-1111-1111-111111111111',
      outputId,
      { segmentation: { mode: 'auto' } }
    );
    await handle.completed;

    const segments = await getLiveTextBufferSegments(outputId, 0, 10, {
      includeMeta: true,
    });

    expect(getLiveTextBufferSegments).toHaveBeenCalledWith(outputId, 0, 10, {
      includeMeta: true,
    });
    expect(segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'Hello, world.',
          meta: expect.objectContaining({
            __segmentReason: 'punctuation',
          }),
        }),
      ])
    );
  });
});
