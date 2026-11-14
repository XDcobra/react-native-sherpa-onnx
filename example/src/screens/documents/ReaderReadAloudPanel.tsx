import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import {
  createEmptyOfflineAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  DocumentErrorCode,
  extractDocumentImages,
} from 'react-native-sherpa-onnx/document';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { releaseOfflineImageBuffer } from 'react-native-sherpa-onnx/imagebuffer';
import { createPcmPlayer, type PcmPlayer } from 'react-native-sherpa-onnx/pcm';
import {
  computeDocumentKey,
  createReadAloudTimeline,
  createReaderDocument,
  getReaderBlocks,
  ReaderView,
  releaseReaderDocument,
  useReadAloudHighlights,
  type ReadAloudTimeline,
  type ReaderDocument,
  type ReaderHighlight,
  type ReaderHighlightStyle,
  type ReaderViewHandle,
} from 'react-native-sherpa-onnx/reader';
import {
  createOfflineTextBufferFromText,
  getOfflineTextBufferTextSlice,
  releasePipelineTextBuffer,
  type OfflineTextBufferRef,
} from 'react-native-sherpa-onnx/textbuffer';
import type { TtsEngine } from 'react-native-sherpa-onnx/tts';
import { OcrChoiceRow } from '../../components/ocr/OcrChoiceRow';
import { styles } from './DocumentsScreen.styles';

/** A paragraph / heading with its range in the extraction text buffer. */
type TextBlock = { id: string; sectionId: string; start: number; end: number };

type Chunk = { start: number; end: number; firstBlock: number; next: number };

type Prepared = {
  chunk: Chunk;
  audioBufferId: string;
  timeline: ReadAloudTimeline;
};

type Props = {
  /** Extraction buffer with the EPUB reading structure (kept by the screen). */
  textBuffer: OfflineTextBufferRef;
  source: FileSource;
  getEngine: () => TtsEngine | null;
  sampleRate: number;
  speakerId: number;
  speed: number;
  ttsReady: boolean;
  onError: (message: string | null) => void;
};

/** Characters per synthesis chunk (whole paragraphs, within one section). */
const CHUNK_CHARS = 1500;
const STYLES = ['background', 'underline', 'textColor'] as const;

/**
 * EPUB read-aloud in the native ReaderView: synthesis runs chunk by chunk from
 * the chosen paragraph, and the spoken sentence / word is highlighted and
 * followed (react-native-sherpa-onnx/reader read-aloud helpers).
 */
export function ReaderReadAloudPanel({
  textBuffer,
  source,
  getEngine,
  sampleRate,
  speakerId,
  speed,
  ttsReady,
  onError,
}: Props) {
  const readerRef = useRef<ReaderViewHandle>(null);
  const [doc, setDoc] = useState<ReaderDocument | null>(null);
  const [blocks, setBlocks] = useState<TextBlock[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [startBlockId, setStartBlockId] = useState<string | null>(null);
  const [firstVisibleId, setFirstVisibleId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [timeline, setTimeline] = useState<ReadAloudTimeline | null>(null);
  const [positionMs, setPositionMs] = useState<number | null>(null);
  const [followPaused, setFollowPaused] = useState(false);
  const [show, setShow] = useState<'sentence' | 'word' | 'both'>('both');
  const [sentenceStyle, setSentenceStyle] =
    useState<ReaderHighlightStyle>('background');
  const [wordStyle, setWordStyle] = useState<ReaderHighlightStyle>('underline');
  const [followMode, setFollowMode] = useState<
    'keepVisible' | 'center' | 'off'
  >('keepVisible');

  const playerRef = useRef<PcmPlayer | null>(null);
  const currentRef = useRef<Prepared | null>(null);
  const nextRef = useRef<Promise<Prepared | null> | null>(null);
  const runRef = useRef(0);
  const imagesRef = useRef<string | null>(null);
  const docRef = useRef<ReaderDocument | null>(null);

  // ---- Reader document over the extraction buffer ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let images: string | undefined;
        try {
          const r = await extractDocumentImages(source, {
            scope: 'all',
            maxSide: 2048,
          });
          images = r.buffer;
        } catch (e) {
          const code = (e as { code?: string })?.code ?? '';
          if (
            code !== DocumentErrorCode.NO_IMAGES &&
            !String(e).includes(DocumentErrorCode.NO_IMAGES)
          ) {
            throw e;
          }
        }
        if (cancelled) {
          if (images) releaseOfflineImageBuffer(images).catch(() => {});
          return;
        }
        imagesRef.current = images ?? null;
        const key = await computeDocumentKey(source);
        const d = await createReaderDocument({
          text: textBuffer,
          images,
          documentKey: key,
        });
        if (cancelled) {
          releaseReaderDocument(d).catch(() => {});
          return;
        }
        const all = await getReaderBlocks(d);
        const textBlocks = all
          .filter((b) => b.textRange)
          .map((b) => ({
            id: b.id,
            sectionId: b.sectionId,
            start: b.textRange!.start,
            end: b.textRange!.end,
          }));
        docRef.current = d;
        setDoc(d);
        setBlocks(textBlocks);
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
      runRef.current += 1;
      playerRef.current?.destroy().catch(() => {});
      playerRef.current = null;
      const d = docRef.current;
      docRef.current = null;
      if (d) releaseReaderDocument(d).catch(() => {});
      const img = imagesRef.current;
      imagesRef.current = null;
      if (img) releaseOfflineImageBuffer(img).catch(() => {});
    };
  }, [source, textBuffer]);

  // ---- Chunked synthesis ----
  const chunkFrom = useCallback(
    (index: number): Chunk | null => {
      const first = blocks[index];
      if (!first) return null;
      let end = first.end;
      let i = index + 1;
      while (
        i < blocks.length &&
        blocks[i]!.sectionId === first.sectionId &&
        blocks[i]!.end - first.start <= CHUNK_CHARS
      ) {
        end = blocks[i]!.end;
        i += 1;
      }
      return { start: first.start, end, firstBlock: index, next: i };
    },
    [blocks]
  );

  const prepare = useCallback(
    async (chunk: Chunk, run: number): Promise<Prepared | null> => {
      const engine = getEngine();
      const d = docRef.current;
      if (!engine || !d) return null;
      const slice = await getOfflineTextBufferTextSlice(
        textBuffer,
        chunk.start,
        chunk.end - chunk.start
      );
      const textIn = await createOfflineTextBufferFromText(slice);
      const audio = await createEmptyOfflineAudioBuffer(sampleRate);
      try {
        const result = await engine.synthesize(textIn, audio, {
          sid: speakerId,
          speed,
          segmentation: { mode: 'auto' },
          timeline: true,
        });
        if (run !== runRef.current || !result.timeline) {
          await releasePipelineAudioBuffer(audio.bufferId).catch(() => {});
          return null;
        }
        const tl = await createReadAloudTimeline(d, {
          text: textIn,
          tts: result.timeline,
          textOffset: chunk.start,
        });
        return { chunk, audioBufferId: audio.bufferId, timeline: tl };
      } finally {
        await releasePipelineTextBuffer(textIn.bufferId).catch(() => {});
      }
    },
    [getEngine, sampleRate, speakerId, speed, textBuffer]
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
      const nextChunk = chunkFrom(prepared.chunk.next);
      nextRef.current = nextChunk ? prepare(nextChunk, run) : null;
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
            .then((p) => {
              if (p) return playPrepared(p, run);
              return stop();
            })
            .catch((e) => onError(e instanceof Error ? e.message : String(e)));
        },
      });
      const prev = playerRef.current;
      playerRef.current = player;
      if (prev) prev.destroy().catch(() => {});
      if (old) releasePipelineAudioBuffer(old.audioBufferId).catch(() => {});
    },
    [chunkFrom, onError, prepare, stop]
  );

  const play = useCallback(async () => {
    if (!getEngine()) {
      onError('Initialize a TTS model first.');
      return;
    }
    const fromId = startBlockId ?? firstVisibleId ?? blocks[0]?.id;
    const index = Math.max(
      0,
      blocks.findIndex((b) => b.id === fromId)
    );
    const chunk = chunkFrom(index);
    if (!chunk) return;
    await stop();
    const run = runRef.current;
    onError(null);
    setBusy(true);
    setPlaying(true);
    try {
      const prepared = await prepare(chunk, run);
      if (prepared) await playPrepared(prepared, run);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      await stop();
    } finally {
      setBusy(false);
    }
  }, [
    blocks,
    chunkFrom,
    firstVisibleId,
    getEngine,
    onError,
    playPrepared,
    prepare,
    startBlockId,
    stop,
  ]);

  // ---- Highlights: the chosen start paragraph, then sentence and word ----
  const readAloud = useReadAloudHighlights(timeline, positionMs, {
    show,
    sentenceStyle: { style: sentenceStyle },
    wordStyle: { style: wordStyle },
  });
  const startBlock = blocks.find((b) => b.id === startBlockId);
  const highlights = useMemo<ReaderHighlight[]>(() => {
    if (playing || !startBlock) return readAloud;
    const at = { sectionId: startBlock.sectionId, blockId: startBlock.id };
    return [{ id: 'start', from: at, to: at, style: 'underline' }];
  }, [playing, readAloud, startBlock]);

  if (loadError) {
    return <Text style={styles.errorText}>{loadError}</Text>;
  }
  if (!doc) {
    return <ActivityIndicator color="#007AFF" />;
  }

  return (
    <View style={styles.readerPanel}>
      <View style={styles.readerBox}>
        <ReaderView
          ref={readerRef}
          document={doc}
          testID="readaloud-reader"
          style={styles.readerView}
          theme={{
            fontSize: 17,
            colors: {
              background: '#FBF8F1',
              text: '#2A2724',
              accent: '#2563EB',
            },
          }}
          highlights={highlights}
          follow={{ mode: followMode }}
          onTap={({ blockId }) => setStartBlockId(blockId)}
          onVisibleRangeChange={(r) => {
            if (r.settled) setFirstVisibleId(r.first.blockId);
          }}
          onFollowChange={(c) => setFollowPaused(!c.following)}
          onError={(e) => onError(`${e.code}: ${e.message}`)}
        />
        {followPaused && playing ? (
          <TouchableOpacity
            style={styles.followButton}
            accessibilityLabel="Back to the reading position"
            testID="readaloud-resume-follow"
            onPress={() => readerRef.current?.resumeFollow()}
          >
            <Text style={styles.followButtonText}>
              Back to reading position
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <Text style={styles.meta}>
        {playing
          ? 'The sentence and the word being spoken are highlighted and kept in view.'
          : startBlockId
          ? 'Reading starts at the underlined paragraph. Tap another one to change it.'
          : 'Tap a paragraph to start there; otherwise reading starts at the top of the view.'}
      </Text>
      <View style={styles.actionRow}>
        <TouchableOpacity
          style={[
            styles.primaryButton,
            styles.actionButtonFlex,
            (!ttsReady || busy) && styles.buttonDisabled,
          ]}
          disabled={!ttsReady || busy}
          testID="readaloud-play"
          accessibilityLabel="Read aloud"
          onPress={() => {
            play().catch(() => {});
          }}
        >
          {busy ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.primaryButtonText}>
              {playing ? 'Restart here' : 'Read aloud'}
            </Text>
          )}
        </TouchableOpacity>
        {playing ? (
          <TouchableOpacity
            style={[styles.secondaryButton, styles.actionButtonFlex]}
            testID="readaloud-stop"
            accessibilityLabel="Stop reading"
            onPress={() => {
              stop().catch(() => {});
            }}
          >
            <Text style={styles.secondaryButtonText}>Stop</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <OcrChoiceRow
        label="Highlight"
        options={['sentence', 'word', 'both'] as const}
        value={show}
        onChange={setShow}
      />
      <OcrChoiceRow
        label="Sentence style"
        options={STYLES}
        value={sentenceStyle}
        onChange={setSentenceStyle}
      />
      <OcrChoiceRow
        label="Word style"
        options={STYLES}
        value={wordStyle}
        onChange={setWordStyle}
      />
      <OcrChoiceRow
        label="Follow"
        options={['keepVisible', 'center', 'off'] as const}
        value={followMode}
        onChange={setFollowMode}
      />
    </View>
  );
}
