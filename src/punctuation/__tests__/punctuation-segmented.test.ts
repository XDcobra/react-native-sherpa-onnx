jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeOfflinePunctuation: jest.fn(),
    punctuateOfflineTextBuffers: jest.fn(),
    punctuateOfflineString: jest.fn(),
    populateOfflineTextBufferIfEmpty: jest.fn(),
    unloadOfflinePunctuation: jest.fn(),
  },
}));

jest.mock('../../utils', () => ({
  resolveModelPath: jest.fn(async () => '/models/punctuation-offline'),
}));

jest.mock('../../pipeline/offlineOrchestrator', () => ({
  runOfflineTextPipeline: jest.fn(),
}));

jest.mock('../../textbuffer', () => ({
  createEmptyOfflineTextBuffer: jest.fn(),
  createOfflineTextBufferFromText: jest.fn(),
  getOfflineTextBufferTextSlice: jest.fn(),
  getPipelineTextBufferInfo: jest.fn(),
  releasePipelineTextBuffer: jest.fn(),
  resolveOfflineTextBufferId: jest.fn((value: unknown) =>
    typeof value === 'object' && value != null && 'bufferId' in value
      ? String((value as { bufferId: string }).bufferId)
      : String(value)
  ),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { runOfflineTextPipeline } from '../../pipeline/offlineOrchestrator';
import {
  createEmptyOfflineTextBuffer,
  createOfflineTextBufferFromText,
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
} from '../../textbuffer';
import { createOfflinePunctuation } from '../offline';

describe('offline punctuation segmentation', () => {
  const native = SherpaOnnx as unknown as {
    initializeOfflinePunctuation: jest.Mock;
    punctuateOfflineTextBuffers: jest.Mock;
    punctuateOfflineString: jest.Mock;
    populateOfflineTextBufferIfEmpty: jest.Mock;
    unloadOfflinePunctuation: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    native.initializeOfflinePunctuation.mockResolvedValue({
      success: true,
      detectedModels: [],
      modelType: 'ct_transformer',
    });
    native.punctuateOfflineTextBuffers.mockResolvedValue({
      processingTimeMs: 4,
    });
    native.punctuateOfflineString.mockResolvedValue({ processingTimeMs: 5 });
    native.populateOfflineTextBufferIfEmpty.mockResolvedValue(null);
    native.unloadOfflinePunctuation.mockResolvedValue(null);
    (getPipelineTextBufferInfo as jest.Mock).mockResolvedValue({
      bufferId: 'txt_tmp',
      kind: 'offlineTextBuffer',
      state: 'immutable',
      utf16Length: 15,
    });
    (getOfflineTextBufferTextSlice as jest.Mock).mockResolvedValue(
      'hello world yes'
    );
    (releasePipelineTextBuffer as jest.Mock).mockResolvedValue(undefined);
  });

  it('keeps one-shot as the default path', async () => {
    const punc = await createOfflinePunctuation({
      modelPath: { type: 'file', path: '/models/punctuation-offline' },
    });

    const result = await punc.punctuate(
      'txt_off_11111111-1111-1111-1111-111111111111',
      'txt_off_22222222-2222-2222-2222-222222222222'
    );

    expect(result.processingTimeMs).toBe(4);
    expect(native.punctuateOfflineTextBuffers).toHaveBeenCalledWith(
      expect.stringMatching(/^punc_off_/),
      'txt_off_11111111-1111-1111-1111-111111111111',
      'txt_off_22222222-2222-2222-2222-222222222222'
    );
    expect(runOfflineTextPipeline).not.toHaveBeenCalled();
  });

  it('runs segmented orchestration and populates caller-owned textOut', async () => {
    (runOfflineTextPipeline as jest.Mock).mockResolvedValue({
      status: 'complete',
      totalSegments: 2,
      completedSegments: 2,
      skippedSegments: [],
      processingTimeMs: 11,
      outputBuffer: {
        bufferId: 'txt_tmp',
        info: {
          bufferId: 'txt_tmp',
          kind: 'offlineTextBuffer',
          state: 'immutable',
          utf16Length: 15,
          tokenCount: 0,
          timestampCount: 0,
          durationCount: 0,
          hasLang: false,
          hasEmotion: false,
          hasEvent: false,
        },
      },
    });

    const punc = await createOfflinePunctuation({
      modelPath: { type: 'file', path: '/models/punctuation-offline' },
    });

    const result = await punc.punctuate(
      'txt_off_11111111-1111-1111-1111-111111111111',
      'txt_off_22222222-2222-2222-2222-222222222222',
      {
        segmentation: {
          mode: 'auto',
          policy: { evaluator: 'text_synthetic_auto', maxLengthChars: 256 },
        },
        errorRecovery: 'retry',
        maxRetriesPerSegment: 1,
      }
    );

    expect(result).toMatchObject({
      status: 'complete',
      totalSegments: 2,
      completedSegments: 2,
      processingTimeMs: 11,
    });
    expect(runOfflineTextPipeline).toHaveBeenCalledWith(
      'txt_off_11111111-1111-1111-1111-111111111111',
      expect.any(Function),
      expect.objectContaining({
        segmentation: expect.objectContaining({
          mode: 'auto',
          policy: expect.objectContaining({ evaluator: 'text_synthetic_auto' }),
        }),
        errorRecovery: 'retry',
      })
    );
    expect(native.populateOfflineTextBufferIfEmpty).toHaveBeenCalledWith(
      'txt_off_22222222-2222-2222-2222-222222222222',
      'hello world yes',
      {}
    );
    expect(releasePipelineTextBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ bufferId: 'txt_tmp' })
    );
  });

  it('supports segmented punctuateString through an offline temp input', async () => {
    (createEmptyOfflineTextBuffer as jest.Mock).mockResolvedValue({
      bufferId: 'txt_off_temp',
      info: { bufferId: 'txt_off_temp', kind: 'offlineTextBuffer' },
    });
    (runOfflineTextPipeline as jest.Mock).mockResolvedValue({
      status: 'complete',
      totalSegments: 1,
      completedSegments: 1,
      skippedSegments: [],
      processingTimeMs: 7,
      outputBuffer: { bufferId: 'txt_tmp' },
    });

    const punc = await createOfflinePunctuation({
      modelPath: { type: 'file', path: '/models/punctuation-offline' },
    });

    await punc.punctuateString(
      'hello world',
      { bufferId: 'txt_off_out', info: {} } as any,
      { segmentation: { mode: 'auto' } }
    );

    expect(createOfflineTextBufferFromText).not.toHaveBeenCalled();
    expect(createEmptyOfflineTextBuffer).toHaveBeenCalled();
    expect(native.populateOfflineTextBufferIfEmpty).toHaveBeenCalledWith(
      'txt_off_temp',
      'hello world',
      {}
    );
    expect(runOfflineTextPipeline).toHaveBeenCalled();
    expect(releasePipelineTextBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ bufferId: 'txt_off_temp' })
    );
  });
});
