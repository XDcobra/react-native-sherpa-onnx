import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createEmptyOfflineAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import { createPcmPlayer, type PcmPlayer } from 'react-native-sherpa-onnx/pcm';
import {
  createReadAloudTimeline,
  createReaderTextSlice,
  ReaderErrorCode,
  type ReadAloudTimeline,
  type ReaderDocument,
  type ReaderLocator,
} from 'react-native-sherpa-onnx/reader';
import { releasePipelineTextBuffer } from 'react-native-sherpa-onnx/textbuffer';
import type { TtsEngine } from 'react-native-sherpa-onnx/tts';

/** UTF-16 units per synthesis chunk (whole blocks; the first block always fits). */
const CHUNK_LENGTH = 1500;

type Prepared = {
  /** Where this chunk ends: the next chunk starts after it. */
  end: ReaderLocator;
  audioBufferId: string;
  timeline: ReadAloudTimeline;
};

type Options = {
  getEngine: () => TtsEngine | null;
  sampleRate: number;
  speakerId: number;
  speed: number;
  onError: (message: string | null) => void;
};

function errorCode(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' ? code : String(e);
}

/**
 * Reads a reader document aloud from a position: text slices
 * (`createReaderTextSlice`) of ~1500 characters are synthesized with a TTS
 * timeline, mapped onto the reader (`createReadAloudTimeline`) and played
 * one after the other; the next chunk is prepared while one plays. Works for
 * every format the reader shows, also OCR text on page images and across page
 * breaks. Pass `timeline` and `positionMs` to `useReadAloudHighlights`.
 */
export function useReaderReadAloud(
  doc: ReaderDocument | null,
  { getEngine, sampleRate, speakerId, speed, onError }: Options
) {
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [timeline, setTimeline] = useState<ReadAloudTimeline | null>(null);
  const [positionMs, setPositionMs] = useState<number | null>(null);

  // The latest document value: OCR may add text while reading.
  const docRef = useRef(doc);
  docRef.current = doc;
  const playerRef = useRef<PcmPlayer | null>(null);
  const currentRef = useRef<Prepared | null>(null);
  const nextRef = useRef<Promise<Prepared | null> | null>(null);
  const runRef = useRef(0);

  /** Synthesizes the text from `from` on; null at the end of the book. */
  const prepare = useCallback(
    async (from: ReaderLocator, run: number): Promise<Prepared | null> => {
      let at = from;
      for (;;) {
        const engine = getEngine();
        const d = docRef.current;
        if (!engine || !d || run !== runRef.current) return null;
        let slice;
        try {
          slice = await createReaderTextSlice(d, {
            from: at,
            maxLength: CHUNK_LENGTH,
          });
        } catch (e) {
          // No text from `at` on: the end of the book.
          if (errorCode(e).includes(ReaderErrorCode.INVALID_ARGUMENT)) {
            return null;
          }
          throw e;
        }
        const audio = await createEmptyOfflineAudioBuffer(sampleRate);
        let keep = false;
        try {
          const result = await engine.synthesize(slice.buffer, audio, {
            sid: speakerId,
            speed,
            segmentation: { mode: 'auto' },
            // OCR text can hold words a voice cannot speak: skip them (short
            // silence) instead of stopping.
            errorRecovery: 'skip',
            timeline: true,
          });
          if (run !== runRef.current) return null;
          if (result.status === 'failed') {
            throw new Error(
              result.failedSegment?.error ?? 'Speech synthesis failed.'
            );
          }
          const spoken = (result.timeline?.segments ?? []).some(
            (seg) => seg.numSamples > 0
          );
          if (result.timeline && spoken) {
            const tl = await createReadAloudTimeline(d, {
              slice,
              tts: result.timeline,
            });
            keep = true;
            return {
              end: slice.to,
              audioBufferId: audio.bufferId,
              timeline: tl,
            };
          }
          // Nothing to hear in this chunk: go on with the next one.
          at = slice.to;
        } finally {
          if (!keep) {
            await releasePipelineAudioBuffer(audio.bufferId).catch(() => {});
          }
          await releasePipelineTextBuffer(slice.buffer).catch(() => {});
        }
      }
    },
    [getEngine, sampleRate, speakerId, speed]
  );

  const stop = useCallback(async () => {
    runRef.current += 1;
    nextRef.current = null;
    const player = playerRef.current;
    playerRef.current = null;
    if (player) await player.destroy().catch(() => {});
    const cur = currentRef.current;
    currentRef.current = null;
    if (cur) releasePipelineAudioBuffer(cur.audioBufferId).catch(() => {});
    setPlaying(false);
    setPositionMs(null);
    setTimeline(null);
  }, []);

  const playPrepared = useCallback(
    async (prepared: Prepared, run: number) => {
      if (run !== runRef.current) return;
      const old = currentRef.current;
      currentRef.current = prepared;
      setTimeline(prepared.timeline);
      setPositionMs(0);
      // Prepare the next chunk while this one plays.
      nextRef.current = prepare(prepared.end, run);
      nextRef.current.catch(() => {});
      const player = await createPcmPlayer(prepared.audioBufferId, {
        onPosition: (e) => {
          if (run === runRef.current) setPositionMs(e.positionMs);
        },
        onEnded: () => {
          if (run !== runRef.current) return;
          const pending = nextRef.current;
          nextRef.current = null;
          if (!pending) {
            stop().catch(() => {});
            return;
          }
          pending
            .then((p) => (p ? playPrepared(p, run) : stop()))
            .catch((e) => {
              onError(e instanceof Error ? e.message : String(e));
              stop().catch(() => {});
            });
        },
      });
      const prev = playerRef.current;
      playerRef.current = player;
      if (prev) prev.destroy().catch(() => {});
      if (old) releasePipelineAudioBuffer(old.audioBufferId).catch(() => {});
    },
    [onError, prepare, stop]
  );

  /** Starts reading at `from` (a block, optionally with an offset). */
  const play = useCallback(
    async (from: ReaderLocator) => {
      if (!getEngine()) {
        onError('Load a voice first.');
        return;
      }
      await stop();
      const run = runRef.current;
      onError(null);
      setBusy(true);
      setPlaying(true);
      try {
        const prepared = await prepare(from, run);
        if (prepared) await playPrepared(prepared, run);
        else if (run === runRef.current) await stop();
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
        await stop();
      } finally {
        setBusy(false);
      }
    },
    [getEngine, onError, playPrepared, prepare, stop]
  );

  // Stop with the document (a new book) and on unmount.
  const docId = doc?.id ?? null;
  useEffect(
    () => () => {
      stop().catch(() => {});
    },
    [docId, stop]
  );

  return { play, stop, busy, playing, timeline, positionMs };
}
