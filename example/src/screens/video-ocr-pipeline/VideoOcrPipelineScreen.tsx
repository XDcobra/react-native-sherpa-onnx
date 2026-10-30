import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  createOfflineImageBufferFromVideo,
  createOfflineVideoBufferFromFile,
  releaseVideoBuffer,
  type OfflineVideoBufferRef,
} from 'react-native-sherpa-onnx/videobuffer';
import {
  createVideoPreviewPlayer,
  type VideoPreviewAudioUnavailableEvent,
  type VideoPreviewError,
  type VideoPreviewPlayer,
} from 'react-native-sherpa-onnx/videopreview';
import {
  releaseOfflineImageBuffer,
  type OfflineImageBufferHandle,
} from 'react-native-sherpa-onnx/imagebuffer';
import {
  createEmptyOfflineTextBuffer,
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
  type OfflineTextBufferInfo,
  type OfflineTextBufferRef,
} from 'react-native-sherpa-onnx/textbuffer';
import type { OcrProgress } from 'react-native-sherpa-onnx/ocr';
import { ExampleVideoPreviewPlayer } from '../../components/ExampleVideoPreviewPlayer';
import { OfflineImageBufferFramePager } from '../../components/OfflineImageBufferFramePager';
import { OcrModelInitPanel } from '../../components/OcrModelInitPanel';
import {
  OcrRecognizeProgressBox,
  type OcrProgressBoxHandle,
} from '../../components/OcrRecognizeProgressBox';
import { PipelineStepStrip } from '../../components/PipelineStepStrip';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  DEFAULT_VIDEO_FRAME_SAMPLING,
  samplingValueToOptions,
  VideoFrameSamplingControls,
  type VideoFrameSamplingValue,
} from '../../components/VideoFrameSamplingControls';
import { useOcrModelInit } from '../../hooks/useOcrModelInit';
import { fileSourceFromBundledPath } from '../../utils/fileSourceFromUri';
import { TEST_VIDEO_FILES } from '../../videoConfig';
import { styles } from './VideoOcrPipelineScreen.styles';

const BUNDLED_VIDEO = TEST_VIDEO_FILES.OCR_SUBTITLES_H264_AAC;

type ExtractedImages = {
  imageBufferId: OfflineImageBufferHandle;
  frameCount: number;
};

export default function VideoOcrPipelineScreen() {
  const ocr = useOcrModelInit();
  const [buffer, setBuffer] = useState<OfflineVideoBufferRef | null>(null);
  const [player, setPlayer] = useState<VideoPreviewPlayer | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const [audioHint, setAudioHint] = useState<string | null>(null);
  const [sampling, setSampling] = useState<VideoFrameSamplingValue>(
    DEFAULT_VIDEO_FRAME_SAMPLING
  );
  const [extractBusy, setExtractBusy] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [images, setImages] = useState<ExtractedImages | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrRunError, setOcrRunError] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState('');
  const [ocrTextBufferId, setOcrTextBufferId] = useState<string | null>(null);
  const [spanCount, setSpanCount] = useState(0);

  const imagesRef = useRef<ExtractedImages | null>(null);
  const ocrTextBufRef = useRef<OfflineTextBufferRef | null>(null);
  const ocrAbortRef = useRef<AbortController | null>(null);
  const ocrProgressBoxRef = useRef<OcrProgressBoxHandle>(null);

  const onError = useCallback((error: VideoPreviewError) => {
    setPlayError(`${error.code}: ${error.message}`);
  }, []);

  const onAudioUnavailable = useCallback(
    (event: VideoPreviewAudioUnavailableEvent) => {
      setAudioHint(
        `Video continues without sound (${event.reason}: ${event.code}${
          event.codec ? ` ${event.codec}` : ''
        }).`
      );
    },
    []
  );

  const releaseOcrTextBuf = useCallback(async () => {
    const current = ocrTextBufRef.current;
    ocrTextBufRef.current = null;
    setOcrTextBufferId(null);
    setOcrText('');
    setSpanCount(0);
    if (current) {
      await releasePipelineTextBuffer(current).catch(() => {});
    }
  }, []);

  const releaseImages = useCallback(async () => {
    const current = imagesRef.current;
    imagesRef.current = null;
    setImages(null);
    if (current) {
      await releaseOfflineImageBuffer(current.imageBufferId).catch(() => {});
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let playerLocal: VideoPreviewPlayer | null = null;
    let bufferLocal: OfflineVideoBufferRef | null = null;

    const releaseAll = async () => {
      ocrAbortRef.current?.abort();
      if (playerLocal) {
        const currentPlayer = playerLocal;
        playerLocal = null;
        try {
          await currentPlayer.release();
        } catch {
          // ignore
        }
      }
      if (bufferLocal) {
        const currentBuffer = bufferLocal;
        bufferLocal = null;
        try {
          await releaseVideoBuffer(currentBuffer);
        } catch {
          // ignore
        }
      }
    };

    setLoading(true);
    setLoadError(null);
    setPlayError(null);
    setAudioHint(null);

    void (async () => {
      try {
        const created = await createOfflineVideoBufferFromFile(
          fileSourceFromBundledPath(BUNDLED_VIDEO)
        );
        bufferLocal = created;
        if (cancelled) {
          await releaseAll();
          return;
        }
        setBuffer(created);
        const createdPlayer = await createVideoPreviewPlayer(created, {
          audio: { source: 'track', required: false },
          progressIntervalMs: 250,
          onError,
          onAudioUnavailable,
        });
        playerLocal = createdPlayer;
        if (cancelled) {
          await releaseAll();
          return;
        }
        setPlayer(createdPlayer);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!cancelled) {
          setLoadError(message);
        }
        await releaseAll();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      void (async () => {
        await releaseOcrTextBuf();
        await releaseImages();
        await releaseAll();
      })();
    };
  }, [onAudioUnavailable, onError, releaseImages, releaseOcrTextBuf]);

  const handleExtract = useCallback(async () => {
    if (!buffer) {
      setExtractError('Video buffer is not ready.');
      return;
    }
    setExtractBusy(true);
    setExtractError(null);
    setOcrRunError(null);
    await releaseOcrTextBuf();
    await releaseImages();
    try {
      const options = samplingValueToOptions(sampling);
      if (__DEV__) {
        console.log('[VideoOcrPipeline] extract', options);
      }
      const result = await createOfflineImageBufferFromVideo(buffer, options);
      const next: ExtractedImages = {
        imageBufferId: result.imageBufferId as OfflineImageBufferHandle,
        frameCount: result.frameCount,
      };
      imagesRef.current = next;
      setImages(next);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setExtractError(message);
    } finally {
      setExtractBusy(false);
    }
  }, [buffer, releaseImages, releaseOcrTextBuf, sampling]);

  const handleRecognize = useCallback(async () => {
    const engine = ocr.engineRef.current;
    if (!engine || !images) {
      setOcrRunError('Initialize OCR and extract images first.');
      return;
    }
    setOcrBusy(true);
    setOcrRunError(null);
    ocrAbortRef.current?.abort();
    const controller = new AbortController();
    ocrAbortRef.current = controller;
    await releaseOcrTextBuf();
    ocrProgressBoxRef.current?.reset();
    try {
      const textOut = await createEmptyOfflineTextBuffer();
      ocrTextBufRef.current = textOut;
      setOcrTextBufferId(textOut.bufferId);
      await engine.recognize(images.imageBufferId, textOut, {
        granularity: 'line',
        signal: controller.signal,
        onProgress: (p: OcrProgress) => {
          ocrProgressBoxRef.current?.apply(p);
        },
      });
      const info = (await getPipelineTextBufferInfo(
        textOut
      )) as OfflineTextBufferInfo;
      const text =
        info.utf16Length > 0
          ? await getOfflineTextBufferTextSlice(textOut, 0, info.utf16Length)
          : '';
      setOcrText(text);
      setSpanCount(info.hasSpatialSpans ? info.spatialSpanCount : 0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await releaseOcrTextBuf();
      if (msg.includes('CANCELLED') || msg.includes('cancelled')) {
        setOcrRunError('Recognize cancelled (OCR_CANCELLED).');
      } else {
        setOcrRunError(msg);
      }
    } finally {
      ocrAbortRef.current = null;
      setOcrBusy(false);
      ocrProgressBoxRef.current?.reset();
    }
  }, [images, ocr.engineRef, releaseOcrTextBuf]);

  const pipelineSteps = useMemo(
    () => [
      { id: 'video', label: 'Video', active: buffer != null },
      { id: 'extract', label: 'Extract', active: images != null },
      { id: 'images', label: 'Images', active: images != null },
      {
        id: 'ocr',
        label: 'OCR model',
        active: ocr.isEngineInitialized,
      },
      {
        id: 'recognize',
        label: 'Recognize',
        active: ocrText.length > 0 || spanCount > 0,
      },
    ],
    [buffer, images, ocr.isEngineInitialized, ocrText.length, spanCount]
  );

  const recognizeReady =
    ocr.isEngineInitialized && images != null && !ocrBusy && !extractBusy;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScreenIntroModal screenId="VideoOcrPipeline" />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Pipeline</Text>
          <Text style={styles.sectionHint}>
            VideoBuffer → createOfflineImageBufferFromVideo → ImageBuffer →
            createOCR().recognize → TextBuffer.
          </Text>
          <PipelineStepStrip steps={pipelineSteps} />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>1. Video</Text>
          <Text style={styles.sectionHint}>
            Bundled H.264 clip with burned-in captions (HELLO WORLD / OPEN
            SOURCE / SPEECH TO TEXT / VIDEO TO OCR, 2 s each).
          </Text>
          <Text style={styles.mono}>{BUNDLED_VIDEO}</Text>
          {buffer ? (
            <Text style={styles.mono}>buffer {buffer.bufferId}</Text>
          ) : null}
          {loadError ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorTitle}>Failed to load video</Text>
              <Text style={styles.errorText}>{loadError}</Text>
            </View>
          ) : null}
          {playError ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorTitle}>Player error</Text>
              <Text style={styles.errorText}>{playError}</Text>
            </View>
          ) : null}
          {audioHint ? (
            <View style={styles.hintBox}>
              <Text style={styles.hintText}>{audioHint}</Text>
            </View>
          ) : null}
          <ExampleVideoPreviewPlayer
            player={player}
            loading={loading}
            showFrameStep={false}
            showLoop={false}
            showMute={false}
            onPlayError={setPlayError}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>2. Extract frames</Text>
          <VideoFrameSamplingControls
            value={sampling}
            onChange={setSampling}
            disabled={extractBusy || buffer == null}
          />
          <TouchableOpacity
            style={[
              styles.primaryButton,
              (extractBusy || buffer == null) && styles.primaryButtonDisabled,
            ]}
            onPress={() => {
              handleExtract().catch(() => {});
            }}
            disabled={extractBusy || buffer == null}
            activeOpacity={0.7}
          >
            {extractBusy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.primaryButtonText}>
                createOfflineImageBufferFromVideo
              </Text>
            )}
          </TouchableOpacity>
          {extractError ? (
            <Text style={styles.errorText}>{extractError}</Text>
          ) : null}
        </View>

        {images ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>3. Images</Text>
            <Text style={styles.mono}>
              {images.imageBufferId} · {images.frameCount} frame
              {images.frameCount === 1 ? '' : 's'}
            </Text>
            <OfflineImageBufferFramePager
              buffer={images.imageBufferId}
              frameCount={images.frameCount}
              maxSide={1280}
              text={ocrTextBufferId ?? undefined}
            />
          </View>
        ) : null}

        {images ? (
          <OcrModelInitPanel
            ocr={ocr}
            title="4. OCR model"
            disabled={ocrBusy || extractBusy}
            showScatteredTest={false}
          />
        ) : null}

        {images ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>5. Recognize</Text>
            <Text style={styles.sectionHint}>
              Runs createOCR().recognize on every extracted frame (default
              frames = all). Boxes overlay the pager above.
            </Text>
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  styles.actionButtonFlex,
                  !recognizeReady && styles.primaryButtonDisabled,
                ]}
                onPress={() => {
                  handleRecognize().catch(() => {});
                }}
                disabled={!recognizeReady}
                activeOpacity={0.7}
              >
                {ocrBusy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryButtonText}>Run OCR</Text>
                )}
              </TouchableOpacity>
              {ocrBusy ? (
                <TouchableOpacity
                  style={[styles.secondaryButton, styles.actionButtonFlex]}
                  onPress={() => {
                    ocrAbortRef.current?.abort();
                  }}
                >
                  <Text style={styles.secondaryButtonText}>Cancel</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            <OcrRecognizeProgressBox
              ref={ocrProgressBoxRef}
              family={ocr.engineFamily}
            />
            {ocrRunError ? (
              <Text style={styles.errorText}>{ocrRunError}</Text>
            ) : null}
            {ocrText.length > 0 || spanCount > 0 ? (
              <View style={styles.resultCard}>
                <Text style={styles.mono}>
                  spanCount={spanCount}
                  {ocrText.length > 0 ? `\nutf16Length=${ocrText.length}` : ''}
                </Text>
                {ocrText.length > 0 ? (
                  <Text style={styles.resultText}>{ocrText}</Text>
                ) : (
                  <Text style={styles.sectionHint}>
                    Spans present, empty plaintext slice.
                  </Text>
                )}
              </View>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
