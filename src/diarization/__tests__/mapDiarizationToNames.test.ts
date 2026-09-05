jest.mock('../../segmentbuffer', () => ({
  resolveOfflineSegmentBufferId: jest.fn((value: unknown) => String(value)),
  getOfflineSegmentBufferSegments: jest.fn(),
}));

import {
  getOfflineSegmentBufferSegments,
  resolveOfflineSegmentBufferId,
} from '../../segmentbuffer';
import { mapDiarizationToNames } from '../mapDiarizationToNames';
import type { DiarizationEngine, DiarizationNameSearch } from '../types';

const segs = {
  getOfflineSegmentBufferSegments: getOfflineSegmentBufferSegments as jest.Mock,
  resolveOfflineSegmentBufferId: resolveOfflineSegmentBufferId as jest.Mock,
};

describe('mapDiarizationToNames', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    segs.resolveOfflineSegmentBufferId.mockImplementation((v: unknown) =>
      String(v)
    );
  });

  it('maps cluster centroids via sid.search and builds a named timeline', async () => {
    const emb0 = new Float32Array([1, 0]);
    const emb1 = new Float32Array([0, 1]);
    const diar: DiarizationEngine = {
      instanceId: 'diar_1',
      sampleRate: 16000,
      diarize: jest.fn(),
      recluster: jest.fn(),
      getClusterEmbeddings: jest.fn(async () => [
        { speaker: 0, embedding: emb0 },
        { speaker: 1, embedding: emb1 },
      ]),
      destroy: jest.fn(),
    };
    const search = jest.fn(async (emb: Float32Array) => {
      if (emb === emb0) return 'alice';
      if (emb === emb1) return null;
      return null;
    });
    const sid: DiarizationNameSearch = { search };

    segs.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'a',
        kind: 'diarization',
        sourceAudioBufferId: 'off_m',
        startSample: 0,
        endSample: 16000,
        sampleRate: 16000,
        durationMs: 1000,
        payload: { source: 'diarization', speaker: 0 },
      },
      {
        id: 'b',
        kind: 'diarization',
        sourceAudioBufferId: 'off_m',
        startSample: 16000,
        endSample: 32000,
        sampleRate: 16000,
        durationMs: 1000,
        payload: { source: 'diarization', speaker: 1 },
      },
      {
        id: 'c',
        kind: 'speech',
        sourceAudioBufferId: 'off_m',
        startSample: 0,
        endSample: 100,
        sampleRate: 16000,
        durationMs: 6,
        payload: { source: 'vad' },
      },
    ]);

    const result = await mapDiarizationToNames(diar, sid, 'seg_off_out', {
      threshold: 0.6,
    });

    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenNthCalledWith(1, emb0, { threshold: 0.6 });
    expect(search).toHaveBeenNthCalledWith(2, emb1, { threshold: 0.6 });
    expect(result.clusterToName.get(0)).toBe('alice');
    expect(result.clusterToName.get(1)).toBeNull();
    expect(result.timeline).toEqual([
      {
        startSample: 0,
        endSample: 16000,
        sampleRate: 16000,
        startSec: 0,
        endSec: 1,
        clusterId: 0,
        name: 'alice',
      },
      {
        startSample: 16000,
        endSample: 32000,
        sampleRate: 16000,
        startSec: 1,
        endSec: 2,
        clusterId: 1,
        name: null,
      },
    ]);
  });

  it('rejects missing search / getClusterEmbeddings', async () => {
    await expect(
      mapDiarizationToNames(
        { getClusterEmbeddings: async () => [] } as unknown as DiarizationEngine,
        {} as DiarizationNameSearch,
        'seg_off_out'
      )
    ).rejects.toThrow(/sid must expose search/);
  });
});
