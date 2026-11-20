jest.mock('../index', () => ({
  appendSamplesToLiveAudioBuffer: jest.fn(),
  createEmptyLiveAudioBuffer: jest.fn(),
  createOfflineAudioBufferFromOffline: jest.fn(),
  finalizeLiveAudioBuffer: jest.fn(),
  getOfflineAudioBufferSamplesSlice: jest.fn(),
  getPipelineAudioBufferInfo: jest.fn(),
  releasePipelineAudioBuffer: jest.fn(),
  transferOfflineAudioBufferFromLive: jest.fn(),
}));

jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    resolveAppBaseDir: jest.fn(),
  },
}));

import { createOfflineAudioBufferFromRanges } from '../ranges';
import SherpaOnnx from '../../NativeSherpaOnnx';

const SOURCE = 'off_11111111-1111-1111-1111-111111111111';
const RATE = 1000; // 1 frame per ms keeps the numbers readable.
const SOURCE_FRAMES = 60_000;
const CHUNK = 5 * RATE;

describe('createOfflineAudioBufferFromRanges', () => {
  const audio = jest.requireMock('../index') as Record<string, jest.Mock>;
  const native = SherpaOnnx as unknown as { resolveAppBaseDir: jest.Mock };
  const fs = jest.requireMock('@dr.pogodin/react-native-fs') as {
    unlink: jest.Mock;
  };
  const spoolPath = (): string =>
    (
      audio.createEmptyLiveAudioBuffer!.mock.calls[0]![0] as {
        retention: { path: string };
      }
    ).retention.path;

  const appendedLengths = (): number[] =>
    audio.appendSamplesToLiveAudioBuffer!.mock.calls.map(
      (call) => (call[1] as Float32Array).length
    );

  const sliceCalls = (): Array<[number, number]> =>
    audio.getOfflineAudioBufferSamplesSlice!.mock.calls.map((call) => [
      call[1] as number,
      call[2] as number,
    ]);

  beforeEach(() => {
    jest.clearAllMocks();
    native.resolveAppBaseDir.mockResolvedValue('/tmp/');
    audio.getPipelineAudioBufferInfo!.mockResolvedValue({
      bufferId: SOURCE,
      kind: 'offlinePcmBuffer',
      state: 'immutable',
      sampleRate: RATE,
      channelCount: 1,
      numSamples: SOURCE_FRAMES,
      durationMs: SOURCE_FRAMES,
    });
    audio.createEmptyLiveAudioBuffer!.mockResolvedValue({
      bufferId: 'live_acc',
      info: { bufferId: 'live_acc', hasActiveSpool: true },
      unsubscribeEvents: jest.fn(),
    });
    audio.getOfflineAudioBufferSamplesSlice!.mockImplementation(
      (_id: string, start: number, count: number) =>
        new Float32Array(Math.max(0, Math.min(count, SOURCE_FRAMES - start)))
    );
    audio.finalizeLiveAudioBuffer!.mockResolvedValue({ bufferId: 'live_acc' });
    audio.releasePipelineAudioBuffer!.mockResolvedValue(undefined);
    audio.transferOfflineAudioBufferFromLive!.mockResolvedValue({
      bufferId: 'off_result',
      info: { bufferId: 'off_result', sampleRate: RATE, channelCount: 1 },
    });
    audio.createOfflineAudioBufferFromOffline!.mockResolvedValue({
      bufferId: 'off_resampled',
      info: { bufferId: 'off_resampled', sampleRate: 16000, channelCount: 1 },
    });
  });

  it('clamps, sorts, merges and drops empty ranges', async () => {
    const result = await createOfflineAudioBufferFromRanges(SOURCE, [
      { startMs: 30_000, endMs: 31_000 },
      { startMs: -500, endMs: 1000 }, // clamped to 0
      { startMs: 500, endMs: 2000 }, // overlaps the previous one
      { startMs: 2000, endMs: 2500 }, // touches it
      { startMs: 4000, endMs: 4000 }, // empty
      { startMs: 7000, endMs: 6000 }, // reversed, empty
      { startMs: 59_000, endMs: 90_000 }, // clamped to the end
      { startMs: 70_000, endMs: 80_000 }, // past the end
    ]);

    expect(result.mapping).toEqual([
      {
        sourceStartMs: 0,
        sourceEndMs: 2500,
        outputStartMs: 0,
        outputEndMs: 2500,
      },
      {
        sourceStartMs: 30_000,
        sourceEndMs: 31_000,
        outputStartMs: 2500,
        outputEndMs: 3500,
      },
      {
        sourceStartMs: 59_000,
        sourceEndMs: 60_000,
        outputStartMs: 3500,
        outputEndMs: 4500,
      },
    ]);
    expect(result.bufferId).toBe('off_result');
    expect(audio.createEmptyLiveAudioBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        sampleRate: RATE,
        channelCount: 1,
        retention: expect.objectContaining({
          mode: 'path',
          path: expect.stringMatching(/^\/tmp\/orch_ranges_.+\.wav$/),
        }),
      })
    );
    expect(audio.transferOfflineAudioBufferFromLive).toHaveBeenCalledWith(
      'live_acc',
      'fullIfSpooled'
    );
    expect(audio.releasePipelineAudioBuffer).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('copies long ranges in bounded chunks that tile each range exactly', async () => {
    const onProgress = jest.fn();
    await createOfflineAudioBufferFromRanges(
      SOURCE,
      [
        { startMs: 1000, endMs: 13_500 },
        { startMs: 20_000, endMs: 25_000 },
      ],
      { onProgress }
    );

    expect(sliceCalls()).toEqual([
      [1000, CHUNK],
      [6000, CHUNK],
      [11_000, 2500],
      [20_000, CHUNK],
    ]);
    for (const [, count] of sliceCalls()) {
      expect(count).toBeLessThanOrEqual(CHUNK);
    }
    const total = appendedLengths().reduce((a, b) => a + b, 0);
    expect(total).toBe(12_500 + 5000);
    expect(audio.appendSamplesToLiveAudioBuffer).toHaveBeenCalledWith(
      'live_acc',
      expect.any(Float32Array),
      RATE
    );
    const fractions = onProgress.mock.calls.map((c) => c[0] as number);
    expect(fractions[fractions.length - 1]).toBe(1);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]!).toBeGreaterThanOrEqual(fractions[i - 1]!);
    }
  });

  it('inserts gapMs of silence between ranges and maps around it', async () => {
    const result = await createOfflineAudioBufferFromRanges(
      SOURCE,
      [
        { startMs: 10_000, endMs: 11_000 },
        { startMs: 0, endMs: 2000 },
      ],
      { gapMs: 300 }
    );

    expect(appendedLengths()).toEqual([2000, 300, 1000]);
    const gap = audio.appendSamplesToLiveAudioBuffer!.mock
      .calls[1]![1] as Float32Array;
    expect(gap.every((v) => v === 0)).toBe(true);
    expect(result.mapping).toEqual([
      {
        sourceStartMs: 0,
        sourceEndMs: 2000,
        outputStartMs: 0,
        outputEndMs: 2000,
      },
      {
        sourceStartMs: 10_000,
        sourceEndMs: 11_000,
        outputStartMs: 2300,
        outputEndMs: 3300,
      },
    ]);
  });

  it('resamples the result when targetSampleRateHz differs and releases the intermediate', async () => {
    const result = await createOfflineAudioBufferFromRanges(
      SOURCE,
      [{ startMs: 0, endMs: 1000 }],
      { targetSampleRateHz: 16000 }
    );

    expect(audio.createOfflineAudioBufferFromOffline).toHaveBeenCalledWith(
      expect.objectContaining({ bufferId: 'off_result' }),
      { targetSampleRateHz: 16000 }
    );
    expect(audio.releasePipelineAudioBuffer).toHaveBeenCalledWith('off_result');
    expect(result.bufferId).toBe('off_resampled');
    expect(result.mapping[0]).toEqual({
      sourceStartMs: 0,
      sourceEndMs: 1000,
      outputStartMs: 0,
      outputEndMs: 1000,
    });
  });

  it('rejects with the cancel error on abort and releases the accumulator', async () => {
    const controller = new AbortController();
    let calls = 0;
    audio.getOfflineAudioBufferSamplesSlice!.mockImplementation(
      (_id: string, _start: number, count: number) => {
        calls += 1;
        if (calls === 2) {
          controller.abort();
        }
        return new Float32Array(count);
      }
    );

    await expect(
      createOfflineAudioBufferFromRanges(
        SOURCE,
        [{ startMs: 0, endMs: 30_000 }],
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({
      name: 'AbortError',
      code: 'ORCHESTRATION_CANCELLED',
    });
    expect(calls).toBe(2);
    expect(audio.releasePipelineAudioBuffer).toHaveBeenCalledWith('live_acc');
    expect(fs.unlink).toHaveBeenCalledWith(spoolPath());
    expect(audio.finalizeLiveAudioBuffer).not.toHaveBeenCalled();
    expect(audio.transferOfflineAudioBufferFromLive).not.toHaveBeenCalled();
  });

  it('releases the accumulator when a copy step fails', async () => {
    audio.appendSamplesToLiveAudioBuffer!.mockImplementation(() => {
      throw new Error('AUDIO_INVALID_STATE: not recording');
    });

    await expect(
      createOfflineAudioBufferFromRanges(SOURCE, [{ startMs: 0, endMs: 100 }])
    ).rejects.toThrow('AUDIO_INVALID_STATE');
    expect(audio.releasePipelineAudioBuffer).toHaveBeenCalledWith('live_acc');
    expect(fs.unlink).toHaveBeenCalledWith(spoolPath());
  });

  it('rejects an already aborted signal before creating anything', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createOfflineAudioBufferFromRanges(SOURCE, [{ startMs: 0, endMs: 100 }], {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'ORCHESTRATION_CANCELLED' });
    expect(audio.createEmptyLiveAudioBuffer).not.toHaveBeenCalled();
  });

  it('rejects when no range is left after normalisation', async () => {
    await expect(
      createOfflineAudioBufferFromRanges(SOURCE, [
        { startMs: 5000, endMs: 5000 },
        { startMs: 61_000, endMs: 70_000 },
      ])
    ).rejects.toThrow(/^AUDIO_INVALID_ARGUMENT: no range/);
    await expect(
      createOfflineAudioBufferFromRanges(SOURCE, [])
    ).rejects.toThrow('AUDIO_INVALID_ARGUMENT');
    expect(audio.createEmptyLiveAudioBuffer).not.toHaveBeenCalled();
  });

  it('rejects invalid arguments and multi-channel sources', async () => {
    await expect(
      createOfflineAudioBufferFromRanges(SOURCE, [
        { startMs: Number.NaN, endMs: 100 },
      ])
    ).rejects.toThrow('AUDIO_INVALID_ARGUMENT');
    await expect(
      createOfflineAudioBufferFromRanges(SOURCE, [{ startMs: 0, endMs: 100 }], {
        gapMs: -1,
      })
    ).rejects.toThrow('AUDIO_INVALID_ARGUMENT');

    audio.getPipelineAudioBufferInfo!.mockResolvedValueOnce({
      kind: 'offlinePcmBuffer',
      sampleRate: RATE,
      channelCount: 2,
      numSamples: SOURCE_FRAMES,
    });
    await expect(
      createOfflineAudioBufferFromRanges(SOURCE, [{ startMs: 0, endMs: 100 }])
    ).rejects.toThrow(/AUDIO_INVALID_ARGUMENT: only mono/);

    audio.getPipelineAudioBufferInfo!.mockResolvedValueOnce({
      kind: 'livePcmBuffer',
      sampleRate: RATE,
      channelCount: 1,
      numSamples: SOURCE_FRAMES,
    });
    await expect(
      createOfflineAudioBufferFromRanges(SOURCE, [{ startMs: 0, endMs: 100 }])
    ).rejects.toThrow('AUDIO_BUFFER_KIND_MISMATCH');
    expect(audio.createEmptyLiveAudioBuffer).not.toHaveBeenCalled();
  });

  it('releases the accumulator and rejects when it has no spool', async () => {
    audio.createEmptyLiveAudioBuffer!.mockResolvedValueOnce({
      bufferId: 'live_acc',
      info: { bufferId: 'live_acc', hasActiveSpool: false },
      unsubscribeEvents: jest.fn(),
    });
    await expect(
      createOfflineAudioBufferFromRanges(SOURCE, [{ startMs: 0, endMs: 100 }])
    ).rejects.toThrow('AUDIO_SPOOL_NOT_AVAILABLE');
    expect(audio.releasePipelineAudioBuffer).toHaveBeenCalledWith('live_acc');
  });
});
