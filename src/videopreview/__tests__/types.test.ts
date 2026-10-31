import type { VideoPreviewPlayer, VideoPreviewEvent } from '../types';

describe('videopreview types', () => {
  it('rejects invalid stepFrame direction at the type level', () => {
    const player = null as unknown as VideoPreviewPlayer;
    void player;
    // @ts-expect-error direction must be 1 | -1
    const _bad: Parameters<VideoPreviewPlayer['stepFrame']>[0] = 2;
    void _bad;
  });

  it('event type narrowing requires a known type', () => {
    const ev = { type: 'ended' } as VideoPreviewEvent;
    if (ev.type === 'ended') {
      expect(ev.type).toBe('ended');
    }
    // @ts-expect-error unknown event type is not in the union
    const _t: VideoPreviewEvent['type'] = 'not-an-event';
    void _t;
  });
});
