import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PipelineVideoBufferIdSource } from '../videobuffer/types';
import { createVideoPreviewPlayer } from './player';
import type {
  VideoPreviewPlayer,
  VideoPreviewPlayerOptions,
  VideoPreviewSnapshot,
} from './types';

export function useVideoPreviewPlayer(
  source: PipelineVideoBufferIdSource | null,
  options?: VideoPreviewPlayerOptions
): VideoPreviewPlayer | null {
  const [player, setPlayer] = useState<VideoPreviewPlayer | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const sourceKey =
    source == null
      ? null
      : typeof source === 'string'
      ? source
      : JSON.stringify(source);

  useEffect(() => {
    let cancelled = false;
    let created: VideoPreviewPlayer | null = null;
    if (sourceKey == null) {
      setPlayer(null);
      return;
    }
    const resolved: PipelineVideoBufferIdSource = sourceKey.startsWith('{')
      ? (JSON.parse(sourceKey) as PipelineVideoBufferIdSource)
      : sourceKey;
    void createVideoPreviewPlayer(resolved, optionsRef.current)
      .then((p) => {
        if (cancelled) {
          void p.release();
          return;
        }
        created = p;
        setPlayer(p);
      })
      .catch((e) => {
        optionsRef.current?.onError?.(e);
        if (!cancelled) setPlayer(null);
      });
    return () => {
      cancelled = true;
      if (created) {
        void created.release();
      }
      setPlayer(null);
    };
  }, [sourceKey]);

  return player;
}

function interpolate(snap: VideoPreviewSnapshot, nativeTs: number): number {
  if (snap.state !== 'playing') return snap.positionMs;
  const elapsed = Date.now() - nativeTs;
  return snap.positionMs + Math.max(0, elapsed);
}

export function useVideoPreviewStatus(
  player: VideoPreviewPlayer | null,
  options?: { smoothPosition?: boolean }
): VideoPreviewSnapshot | null {
  const snapRef = useRef<VideoPreviewSnapshot | null>(
    player?.initialSnapshot ?? null
  );
  const nativeTsRef = useRef(Date.now());
  const [, bump] = useState(0);

  useEffect(() => {
    if (!player) {
      snapRef.current = null;
      bump((n) => n + 1);
      return;
    }
    snapRef.current = player.initialSnapshot;
    const offs = [
      player.addListener('stateChanged', () => {
        void player.getSnapshot().then((s) => {
          snapRef.current = s;
          nativeTsRef.current = Date.now();
          bump((n) => n + 1);
        });
      }),
      player.addListener('progress', (e) => {
        if (snapRef.current) {
          snapRef.current = {
            ...snapRef.current,
            positionMs: e.positionMs,
            seekableRange: e.seekableRange,
            liveEdgeMs: e.liveEdgeMs,
          };
          nativeTsRef.current = e.nativeTimestampMs || Date.now();
          bump((n) => n + 1);
        }
      }),
      player.addListener('ended', () => {
        void player.getSnapshot().then((s) => {
          snapRef.current = s;
          bump((n) => n + 1);
        });
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [player]);

  return useSyncExternalStore(
    (onStoreChange) => {
      if (!options?.smoothPosition || !player) return () => undefined;
      let raf = 0;
      const loop = () => {
        onStoreChange();
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(raf);
    },
    () => {
      const s = snapRef.current;
      if (!s) return null;
      if (!options?.smoothPosition) return s;
      return { ...s, positionMs: interpolate(s, nativeTsRef.current) };
    },
    () => snapRef.current
  );
}

export function useVideoPreviewProgress(player: VideoPreviewPlayer | null): {
  positionMs: number;
  durationMs: number | null;
} {
  const snap = useVideoPreviewStatus(player);
  return {
    positionMs: snap?.positionMs ?? 0,
    durationMs: snap?.durationMs ?? null,
  };
}
