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
  it('returns the same object on repeated getSnapshot calls', () => {
    const base = snap({ state: 'paused', positionMs: 1200 });
    const cache = { base: null, out: null };
    const a = snapshotForStatusHook(base, 0, 10_000, true, cache);
    const b = snapshotForStatusHook(base, 0, 10_016, true, cache);
    expect(a).toBe(base);
    expect(b).toBe(a);
  });

  it('returns a new identity when the event-sourced snap reference changes', () => {
    const first = snap({ state: 'playing', positionMs: 100 });
    const second = snap({ state: 'paused', positionMs: 100 });
    const cache = { base: null, out: null };
    const a = snapshotForStatusHook(first, 1000, 1100, true, cache);
    const b = snapshotForStatusHook(second, 1000, 1500, true, cache);
    expect(a).toBe(first);
    expect(b).toBe(second);
    expect(b).not.toBe(a);
  });
});
