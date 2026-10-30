import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { PipelineVideoBufferIdSource } from '../videobuffer/types';
import { createVideoPreviewPlayer } from './player';
import { snapshotForStatusHook } from './statusSnapshot';
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

export function useVideoPreviewStatus(
  player: VideoPreviewPlayer | null,
  options?: { smoothPosition?: boolean }
): VideoPreviewSnapshot | null {
  const smoothPosition = options?.smoothPosition === true;
  const snapRef = useRef<VideoPreviewSnapshot | null>(
    player?.initialSnapshot ?? null
  );
  const nativeTsRef = useRef(Date.now());
  const nowRef = useRef(nativeTsRef.current);
  const cacheRef = useRef<{
    base: VideoPreviewSnapshot | null;
    out: VideoPreviewSnapshot | null;
  }>({ base: null, out: null });

  if (player == null) {
    if (snapRef.current != null) {
      snapRef.current = null;
      cacheRef.current = { base: null, out: null };
    }
  } else if (snapRef.current?.playerId !== player.playerId) {
    snapRef.current = player.initialSnapshot;
    nativeTsRef.current = Date.now();
    nowRef.current = nativeTsRef.current;
    cacheRef.current = { base: null, out: null };
  }

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!player) {
        snapRef.current = null;
        cacheRef.current = { base: null, out: null };
        return () => undefined;
      }
      if (!snapRef.current || snapRef.current.playerId !== player.playerId) {
        snapRef.current = player.initialSnapshot;
      }
      const notify = () => {
        nowRef.current = Date.now();
        onStoreChange();
      };
      const patchSnap = (patch: Partial<VideoPreviewSnapshot>) => {
        if (!snapRef.current) return;
        snapRef.current = { ...snapRef.current, ...patch };
        nativeTsRef.current = Date.now();
        notify();
      };
      const offs = [
        player.addListener('stateChanged', (e) => {
          patchSnap({
            state: e.state,
            positionMs: e.positionMs,
          });
        }),
        player.addListener('progress', (e) => {
          patchSnap({
            positionMs: e.positionMs,
            seekableRange: e.seekableRange,
            liveEdgeMs: e.liveEdgeMs,
          });
        }),
        player.addListener('firstFrameRendered', (e) => {
          patchSnap({ positionMs: e.positionMs });
        }),
        player.addListener('seekCompleted', (e) => {
          if (e.result?.actualMs != null) {
            patchSnap({ positionMs: e.result.actualMs });
          }
        }),
        player.addListener('ended', () => {
          patchSnap({ state: 'ended' });
        }),
      ];
      return () => {
        for (const off of offs) off();
      };
    },
    [player]
  );

  return useSyncExternalStore(
    subscribe,
    () =>
      snapshotForStatusHook(
        snapRef.current,
        nativeTsRef.current,
        nowRef.current,
        smoothPosition,
        cacheRef.current
      ),
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
