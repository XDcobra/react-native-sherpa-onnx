import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import {
  DocumentErrorCode,
  extractDocumentImages,
} from 'react-native-sherpa-onnx/document';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { releaseOfflineImageBuffer } from 'react-native-sherpa-onnx/imagebuffer';
import {
  computeDocumentKey,
  createReaderDocument,
  ReaderView,
  releaseReaderDocument,
  useReadAloudHighlights,
  type ReaderDocument,
  type ReaderHighlight,
  type ReaderHighlightStyle,
  type ReaderLocator,
  type ReaderViewHandle,
} from 'react-native-sherpa-onnx/reader';
import type { OfflineTextBufferRef } from 'react-native-sherpa-onnx/textbuffer';
import type { TtsEngine } from 'react-native-sherpa-onnx/tts';
import { OcrChoiceRow } from '../../components/ocr/OcrChoiceRow';
import { useReaderReadAloud } from '../reader/useReaderReadAloud';
import { styles } from './DocumentsScreen.styles';

type Props = {
  /** Extraction buffer with the reading structure (kept by the screen). */
  textBuffer: OfflineTextBufferRef;
  source: FileSource;
  getEngine: () => TtsEngine | null;
  sampleRate: number;
  speakerId: number;
  speed: number;
  ttsReady: boolean;
  onError: (message: string | null) => void;
};

const STYLES = ['background', 'underline', 'textColor'] as const;

/** `s4.b2` → `s4`, `s4.b0.t1` → `s4`, `app:about.p1` → `app:about`. */
function sectionOf(blockId: string): string {
  const dot = blockId.indexOf('.');
  return dot < 0 ? blockId : blockId.slice(0, dot);
}

/**
 * Read-aloud of an extracted book (EPUB, FB2, MOBI / AZW3) in the native
 * ReaderView: text slices from the chosen paragraph are synthesized chunk by
 * chunk, and the spoken sentence / word is highlighted and followed
 * (react-native-sherpa-onnx/reader read-aloud helpers, useReaderReadAloud).
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [startBlockId, setStartBlockId] = useState<string | null>(null);
  const [firstVisible, setFirstVisible] = useState<ReaderLocator | null>(null);
  const [followPaused, setFollowPaused] = useState(false);
  const [show, setShow] = useState<'sentence' | 'word' | 'both'>('both');
  const [sentenceStyle, setSentenceStyle] =
    useState<ReaderHighlightStyle>('background');
  const [wordStyle, setWordStyle] = useState<ReaderHighlightStyle>('underline');
  const [followMode, setFollowMode] = useState<
    'keepVisible' | 'center' | 'off'
  >('keepVisible');

  const imagesRef = useRef<string | null>(null);
  const docRef = useRef<ReaderDocument | null>(null);

  const { play, stop, busy, playing, timeline, positionMs } =
    useReaderReadAloud(doc, {
      getEngine,
      sampleRate,
      speakerId,
      speed,
      onError,
    });

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
        docRef.current = d;
        setDoc(d);
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
      const d = docRef.current;
      docRef.current = null;
      if (d) releaseReaderDocument(d).catch(() => {});
      const img = imagesRef.current;
      imagesRef.current = null;
      if (img) releaseOfflineImageBuffer(img).catch(() => {});
    };
  }, [source, textBuffer]);

  const startAt = (): ReaderLocator | null => {
    if (startBlockId) {
      return { sectionId: sectionOf(startBlockId), blockId: startBlockId };
    }
    if (firstVisible) return firstVisible;
    const first = doc?.sections[0];
    return first ? { sectionId: first.id, blockId: first.firstBlockId } : null;
  };

  // ---- Highlights: the chosen start paragraph, then sentence and word ----
  const readAloud = useReadAloudHighlights(timeline, positionMs, {
    show,
    sentenceStyle: { style: sentenceStyle },
    wordStyle: { style: wordStyle },
  });
  const highlights = useMemo<ReaderHighlight[]>(() => {
    if (playing || !startBlockId) return readAloud;
    const at = { sectionId: sectionOf(startBlockId), blockId: startBlockId };
    return [{ id: 'start', from: at, to: at, style: 'underline' }];
  }, [playing, readAloud, startBlockId]);

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
            if (r.settled) setFirstVisible(r.first);
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
            const from = startAt();
            if (from) play(from).catch(() => {});
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
