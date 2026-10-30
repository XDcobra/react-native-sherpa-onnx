import type { VideoPreviewSnapshot } from '../types';
import { snapshotForStatusHook } from '../statusSnapshot';

function snap(over: Partial<VideoPreviewSnapshot> = {}): VideoPreviewSnapshot {
  return {
    playerId: 'vprev_1' as VideoPreviewSnapshot['playerId'],
    bufferId: 'vid_off_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    bufferKind: 'offlineVideoBuffer',
    state: 'ready',
    positionMs: 0,
    durationMs: 5000,
    seekableRange: { startMs: 0, endMs: 5000 },
    liveEdgeMs: null,
    atLiveEdge: false,
    playbackRate: 1,
    videoAttached: false,
    audio: { status: 'playing', codec: 'aac', sampleRate: 48000, channels: 2 },
    stats: {
      framesRendered: 0,
      framesDropped: 0,
      audioUnderruns: 0,
      avOffsetMs: 0,
    },
    ...over,
  };
}

describe('snapshotForStatusHook', () => {
  it('returns the same object on repeated paused getSnapshot calls', () => {
    const base = snap({ state: 'paused', positionMs: 1200 });
    const cache = { base: null, out: null };
    const a = snapshotForStatusHook(base, 0, 10_000, true, cache);
    const b = snapshotForStatusHook(base, 0, 10_016, true, cache);
    expect(a).toBe(base);
    expect(b).toBe(a);
  });

  it('returns the same interpolated object when now is unchanged', () => {
    const base = snap({ state: 'playing', positionMs: 100 });
    const cache = { base: null, out: null };
    const a = snapshotForStatusHook(base, 1000, 1100, true, cache);
    const b = snapshotForStatusHook(base, 1000, 1100, true, cache);
    expect(a).not.toBe(base);
    expect(a?.positionMs).toBe(200);
    expect(b).toBe(a);
  });

  it('emits a new object when interpolated position advances', () => {
    const base = snap({ state: 'playing', positionMs: 100 });
    const cache = { base: null, out: null };
    const a = snapshotForStatusHook(base, 1000, 1100, true, cache);
    const b = snapshotForStatusHook(base, 1000, 1116, true, cache);
    expect(b).not.toBe(a);
    expect(b?.positionMs).toBe(216);
  });
});
