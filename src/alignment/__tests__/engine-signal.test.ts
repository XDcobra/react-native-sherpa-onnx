jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectAlignmentModel: jest.fn().mockResolvedValue({
      success: true,
      paths: { model: '/resolved/alignment/model.onnx' },
    }),
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
  resolveBundledAssetPath: jest.fn().mockResolvedValue('/tmp/alignment-model'),
}));

jest.mock('../asrMediated/driver', () => ({
  runAccurateAsrMediated: jest.fn().mockResolvedValue({
    outputSegmentBufferId: 'seg_out',
    segmentsWritten: 1,
  }),
}));

jest.mock('../chunkedForcedCtc/driver', () => ({
  runAccurateChunkedForcedCtc: jest.fn().mockResolvedValue({
    outputSegmentBufferId: 'seg_out',
    segmentsWritten: 1,
  }),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { getOfflineSegmentBufferSegments } from '../../segmentbuffer';
import { runAccurateChunkedForcedCtc } from '../chunkedForcedCtc/driver';
import { createAlignment } from '../engine';

const cancelled = { name: 'AbortError', code: 'ORCHESTRATION_CANCELLED' };

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

describe('alignTextToAudio signal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects before the single native pass when already aborted', async () => {
    const engine = createAlignment();
    const onProgress = jest.fn();

    await expect(
      engine.alignTextToAudio('txt_off', 'off_audio', 'seg_off', {
        mode: 'proportional',
        onProgress,
        signal: abortedSignal(),
      })
    ).rejects.toMatchObject(cancelled);
    expect(SherpaOnnx.alignOfflineTextToAudio).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('rejects vad mode before reading anchors when already aborted', async () => {
    const engine = createAlignment();

    await expect(
      engine.alignTextToAudio('txt_off', 'off_audio', 'seg_off', {
        mode: 'vad',
        segmentation: { source: 'vad', segmentBuffer: 'seg_anchor' },
        signal: abortedSignal(),
      })
    ).rejects.toMatchObject(cancelled);
    expect(getOfflineSegmentBufferSegments).not.toHaveBeenCalled();
    expect(SherpaOnnx.alignOfflineTextToAudio).not.toHaveBeenCalled();
  });

  it('passes the signal to the segmented accurate driver', async () => {
    const engine = createAlignment();
    const controller = new AbortController();

    await engine.alignTextToAudio('txt_off', 'off_audio', 'seg_off', {
      mode: 'accurate',
      modelSource: { kind: 'fs', path: '/models/alignment' },
      segmentation: {
        mode: 'auto',
        anchorSegmentBuffer: 'seg_anchor',
        mappingStrategy: 'chunked_forced_ctc',
      },
      signal: controller.signal,
    });

    expect(runAccurateChunkedForcedCtc).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal })
    );
  });
});
