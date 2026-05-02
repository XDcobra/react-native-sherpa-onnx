jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectAlignmentModel: jest.fn().mockResolvedValue({
      success: true,
      paths: { model: '/resolved/alignment/model.onnx' },
    }),
    alignOfflineTextToAudio: jest.fn().mockResolvedValue({
      outputSegmentBufferId: 'seg_out',
      segmentsWritten: 3,
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
  getOfflineSegmentBufferSegments: jest.fn(),
  resolveOfflineSegmentBufferId: (source: unknown) =>
    typeof source === 'string'
      ? source
      : (source as { bufferId?: string })?.bufferId ?? 'seg_off',
}));

jest.mock('../../utils', () => ({
  resolveModelPath: jest.fn().mockResolvedValue('/resolved/alignment'),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { createAlignment } from '../engine';

describe('AlignmentEngine rows 1/2/3/5 parity', () => {
  const native = SherpaOnnx as unknown as {
    alignOfflineTextToAudio: jest.Mock;
  };
  const segmentBuffer = jest.requireMock('../../segmentbuffer') as {
    getOfflineSegmentBufferSegments: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    segmentBuffer.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        segmentId: 'seg_anchor_0',
        kind: 'speech',
        startSample: 0,
        endSample: 3200,
        sampleRate: 16000,
        startMs: 0,
        endMs: 200,
      },
    ]);
  });

  it('routes proportional mode unchanged', async () => {
    const engine = createAlignment();

    await engine.alignTextToAudio('txt_off', 'off_audio', 'seg_out', {
      mode: 'proportional',
      granularity: 'word',
      language: 'en',
    });

    expect(native.alignOfflineTextToAudio).toHaveBeenCalledWith(
      'txt_off',
      'off_audio',
      'seg_out',
      'proportional',
      'word',
      { language: 'en' }
    );
  });

  it('routes estimated mode unchanged', async () => {
    const engine = createAlignment();

    await engine.alignTextToAudio('txt_off', 'off_audio', 'seg_out', {
      mode: 'estimated',
      granularity: 'sentence',
      chunks: {
        sampleRate: 16000,
        segmentSampleCounts: [3.2, -2, 7.1],
      },
    });

    expect(native.alignOfflineTextToAudio).toHaveBeenCalledWith(
      'txt_off',
      'off_audio',
      'seg_out',
      'estimated',
      'sentence',
      {
        segmentSampleCounts: [3, 0, 7],
        chunks: {
          sampleRate: 16000,
          segmentSampleCounts: [3, 0, 7],
        },
      }
    );
  });

  it('routes accurate mode without segmentation unchanged', async () => {
    const engine = createAlignment();

    await engine.alignTextToAudio('txt_off', 'off_audio', 'seg_out', {
      mode: 'accurate',
      granularity: 'character',
      language: 'en',
      modelPath: { type: 'file', path: '/models/alignment' },
    });

    expect(native.alignOfflineTextToAudio).toHaveBeenCalledWith(
      'txt_off',
      'off_audio',
      'seg_out',
      'accurate',
      'character',
      {
        modelPath: '/resolved/alignment/model.onnx',
        language: 'en',
      }
    );
  });

  it('routes vad mode unchanged', async () => {
    const engine = createAlignment();

    await engine.alignTextToAudio('txt_off', 'off_audio', 'seg_out', {
      mode: 'vad',
      granularity: 'word',
      segmentation: {
        source: 'vad',
        segmentBuffer: 'seg_anchor',
      },
    });

    expect(native.alignOfflineTextToAudio).toHaveBeenCalledWith(
      'txt_off',
      'off_audio',
      'seg_out',
      'vad',
      'word',
      {
        segmentationSource: 'vad',
        segmentationBufferId: 'seg_anchor',
      }
    );
  });
});
