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
const SEARCH_WORD = 'the';

function smoke(ev: string, data: Record<string, unknown> = {}) {
  if (__DEV__) {
    console.log(`READER_SMOKE ${JSON.stringify({ ev, ...data })}`);
  }
}

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
  const [searchDemo, setSearchDemo] = useState(false);
  const [searchHits, setSearchHits] = useState<ReaderHighlight[]>([]);
  const [log, setLog] = useState<string[]>([]);

  const playerRef = useRef<PcmPlayer | null>(null);
  const currentRef = useRef<Prepared | null>(null);
  const nextRef = useRef<Promise<Prepared | null> | null>(null);
  const runRef = useRef(0);
  const imagesRef = useRef<string | null>(null);
  const docRef = useRef<ReaderDocument | null>(null);

  const push = useCallback(
    (line: string, ev: string, data: Record<string, unknown> = {}) => {
      setLog((l) => [line, ...l].slice(0, 6));
      smoke(ev, data);
    },
    []
  );

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
        smoke('readerLoaded', {
          blocks: d.blockCount,
          textBlocks: textBlocks.length,
        });
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

  // ---- Demo: several highlights at once (static "search hits") ----
  useEffect(() => {
    if (!searchDemo || !doc) {
      setSearchHits([]);
      return;
    }
    let cancelled = false;
    getReaderBlocks(doc, 0, 400, { includeText: true })
      .then((all) => {
        if (cancelled) return;
        const hits: ReaderHighlight[] = [];
        const re = new RegExp(`\\b${SEARCH_WORD}\\b`, 'gi');
        for (const b of all) {
          if (!b.text) continue;
          let m: RegExpExecArray | null;
          while ((m = re.exec(b.text)) !== null && hits.length < 200) {
            hits.push({
              id: `search:${b.id}:${m.index}`,
              from: { sectionId: b.sectionId, blockId: b.id, offset: m.index },
              to: {
                sectionId: b.sectionId,
                blockId: b.id,
                offset: m.index + m[0].length,
              },
              style: 'textColor',
              color: '#C2410C',
            });
          }
        }
        setSearchHits(hits);
        smoke('search', { hits: hits.length });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [doc, searchDemo]);

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
      push(
        `chunk ${blocks[prepared.chunk.firstBlock]?.id} · ${
          prepared.timeline.sentences.length
        } sentences`,
        'chunk',
        {
          firstBlock: blocks[prepared.chunk.firstBlock]?.id,
          start: prepared.chunk.start,
          end: prepared.chunk.end,
          sentences: prepared.timeline.sentences.length,
          words: prepared.timeline.words.length,
          durationMs: Math.round(prepared.timeline.durationMs),
        }
      );
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
            push('end of book', 'ended');
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
    [blocks, chunkFrom, onError, prepare, push, stop]
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
    push(`play from ${blocks[index]?.id}`, 'play', {
      blockId: blocks[index]?.id,
    });
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
    push,
    startBlockId,
    stop,
  ]);

  // ---- Highlights ----
  const readAloud = useReadAloudHighlights(timeline, positionMs, {
    show,
    sentenceStyle: { style: sentenceStyle },
    wordStyle: { style: wordStyle },
  });
  const highlights = useMemo(
    () => [...searchHits, ...readAloud],
    [readAloud, searchHits]
  );

  // Log unit changes (sentence / word) for smoke tests.
  const spoken =
    timeline && positionMs != null ? timeline.at(positionMs) : null;
  const sentenceIdx = spoken?.sentence?.index ?? -1;
  const wordIdx = spoken?.word?.index ?? -1;
  useEffect(() => {
    if (!spoken || (sentenceIdx < 0 && wordIdx < 0)) return;
    smoke('unit', {
      ms: Math.round(positionMs ?? 0),
      sentence: sentenceIdx,
      sentenceFrom: spoken.sentence?.range.from,
      word: wordIdx,
      wordText: spoken.word
        ? `${spoken.word.range.from.blockId}@${spoken.word.range.from.offset}`
        : null,
    });
    // Only on unit changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sentenceIdx, wordIdx]);

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
          onTap={({ blockId }) => {
            setStartBlockId(blockId);
            push(`start at ${blockId}`, 'tap', { blockId });
          }}
          onVisibleRangeChange={(r) => {
            if (r.settled) setFirstVisibleId(r.first.blockId);
          }}
          onFollowChange={(c) => {
            setFollowPaused(!c.following);
            push(
              `follow ${c.following ? 'on' : 'paused'} (${c.reason})`,
              'follow',
              c
            );
          }}
          onJump={(j) =>
            push(`jump ${j.cause} ${j.from.blockId}→${j.to.blockId}`, 'jump', {
              cause: j.cause,
              from: j.from.blockId,
              to: j.to.blockId,
              distance: j.distance,
            })
          }
          onFurthestPositionChange={(l) =>
            smoke('furthest', { blockId: l.blockId })
          }
          onSectionEnd={(e) =>
            push(`section end ${e.sectionId}`, 'sectionEnd', e)
          }
          onError={(e) => push(`error ${e.code}`, 'readerError', e)}
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
        {startBlockId
          ? `Start: ${startBlockId} (tap a paragraph to change)`
          : 'Tap a paragraph to start there; otherwise the first visible one.'}
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
              push('stop', 'stop');
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
        onChange={(v) => {
          setShow(v);
          smoke('setting', { show: v });
        }}
      />
      <OcrChoiceRow
        label="Sentence style"
        options={STYLES}
        value={sentenceStyle}
        onChange={(v) => {
          setSentenceStyle(v);
          smoke('setting', { sentenceStyle: v });
        }}
      />
      <OcrChoiceRow
        label="Word style"
        options={STYLES}
        value={wordStyle}
        onChange={(v) => {
          setWordStyle(v);
          smoke('setting', { wordStyle: v });
        }}
      />
      <OcrChoiceRow
        label="Follow"
        options={['keepVisible', 'center', 'off'] as const}
        value={followMode}
        onChange={(v) => {
          setFollowMode(v);
          smoke('setting', { follow: v });
        }}
      />
      <OcrChoiceRow
        label={`Also mark “${SEARCH_WORD}” (several highlights)`}
        options={['off', 'on'] as const}
        value={searchDemo ? 'on' : 'off'}
        onChange={(v) => setSearchDemo(v === 'on')}
      />
      <View style={styles.readerLog}>
        {log.map((line, i) => (
          <Text key={`${i}-${line}`} style={styles.readerLogLine}>
            {line}
          </Text>
        ))}
      </View>
    </View>
  );
}
