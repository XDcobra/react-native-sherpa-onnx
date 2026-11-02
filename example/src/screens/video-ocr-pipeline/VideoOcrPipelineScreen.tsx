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
  createOfflineAudioBufferFromVideo,
  createOfflineImageBufferFromVideo,
  createOfflineVideoBufferFromFile,
  releaseVideoBuffer,
  type OfflineVideoBufferRef,
} from 'react-native-sherpa-onnx/videobuffer';
import {
  releasePipelineAudioBuffer,
  type OfflineAudioBufferRef,
} from 'react-native-sherpa-onnx/audiobuffer';
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
import {
  PipelineOfflineAudioResultCard,
  type PipelineOfflineAudioResultCardHandle,
} from '../../components/PipelineOfflineAudioResultCard';
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

type ImageExtractProgress = {
  percent: number;
  completed: number;
  total: number;
  ptsUs: number;
};

type AudioExtractProgress = {
  percent: number;
  decodedMs: number;
};

function isCancelledMessage(message: string): boolean {
  return message.includes('CANCELLED') || message.includes('cancelled');
}

function ExtractProgressBox({
  visible,
  label,
  percent,
  detail,
}: {
  visible: boolean;
  label: string;
  percent: number | null;
  detail: string | null;
}) {
  if (!visible) {
    return null;
  }
  const clamped = percent == null ? null : Math.max(0, Math.min(100, percent));
  return (
    <View style={styles.progressBox}>
      <View style={styles.progressHeader}>
        <Text style={styles.progressLabel} numberOfLines={2}>
          {label}
          {detail ? ` · ${detail}` : ''}
        </Text>
        {clamped != null ? (
          <Text style={styles.progressPercent}>{Math.round(clamped)}%</Text>
        ) : null}
      </View>
      {clamped != null ? (
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${clamped}%` }]} />
        </View>
      ) : null}
    </View>
  );
}

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
  const [extractProgress, setExtractProgress] =
    useState<ImageExtractProgress | null>(null);
  const [images, setImages] = useState<ExtractedImages | null>(null);
  const [audioBusy, setAudioBusy] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [audioProgress, setAudioProgress] =
    useState<AudioExtractProgress | null>(null);
  const [extractedAudio, setExtractedAudio] =
    useState<OfflineAudioBufferRef | null>(null);
  const [audioMeta, setAudioMeta] = useState<{
    mediaStartMs: number;
    sourceCodec: string;
    sourceSampleRate: number;
    sourceChannels: number;
  } | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrRunError, setOcrRunError] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState('');
  const [ocrTextBufferId, setOcrTextBufferId] = useState<string | null>(null);
  const [spanCount, setSpanCount] = useState(0);

  const imagesRef = useRef<ExtractedImages | null>(null);
  const audioRef = useRef<OfflineAudioBufferRef | null>(null);
  const ocrTextBufRef = useRef<OfflineTextBufferRef | null>(null);
  const ocrAbortRef = useRef<AbortController | null>(null);
  const extractAbortRef = useRef<AbortController | null>(null);
  const audioAbortRef = useRef<AbortController | null>(null);
  const audioCardRef = useRef<PipelineOfflineAudioResultCardHandle>(null);
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

  const releaseAudio = useCallback(async () => {
    const current = audioRef.current;
    audioRef.current = null;
    await audioCardRef.current?.stop();
    setExtractedAudio(null);
    setAudioMeta(null);
    if (current) {
      await releasePipelineAudioBuffer(current).catch(() => {});
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let playerLocal: VideoPreviewPlayer | null = null;
    let bufferLocal: OfflineVideoBufferRef | null = null;

    const releaseAll = async () => {
      ocrAbortRef.current?.abort();
      extractAbortRef.current?.abort();
      audioAbortRef.current?.abort();
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
        await releaseAudio();
        await releaseAll();
      })();
    };
  }, [
    onAudioUnavailable,
    onError,
    releaseAudio,
    releaseImages,
    releaseOcrTextBuf,
  ]);

  const handleExtract = useCallback(async () => {
    if (!buffer) {
      setExtractError('Video buffer is not ready.');
      return;
    }
    extractAbortRef.current?.abort();
    const controller = new AbortController();
    extractAbortRef.current = controller;
    setExtractBusy(true);
    setExtractError(null);
    setExtractProgress({ percent: 0, completed: 0, total: 0, ptsUs: 0 });
    setOcrRunError(null);
    await releaseOcrTextBuf();
    await releaseImages();
    try {
      const options = samplingValueToOptions(sampling);
      if (__DEV__) {
        console.log('[VideoOcrPipeline] extract', options);
      }
      const result = await createOfflineImageBufferFromVideo(buffer, {
        ...options,
        signal: controller.signal,
        onProgress: (e) => {
          setExtractProgress(e);
        },
      });
      const next: ExtractedImages = {
        imageBufferId: result.imageBufferId as OfflineImageBufferHandle,
        frameCount: result.frameCount,
      };
      imagesRef.current = next;
      setImages(next);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setExtractError(
        isCancelledMessage(message)
          ? 'Extract cancelled (VIDEO_CANCELLED).'
          : message
      );
    } finally {
      extractAbortRef.current = null;
      setExtractBusy(false);
      setExtractProgress(null);
    }
  }, [buffer, releaseImages, releaseOcrTextBuf, sampling]);

  const handleExtractAudio = useCallback(async () => {
    if (!buffer) {
      setAudioError('Video buffer is not ready.');
      return;
    }
    audioAbortRef.current?.abort();
    const controller = new AbortController();
    audioAbortRef.current = controller;
    setAudioBusy(true);
    setAudioError(null);
    setAudioProgress({ percent: 0, decodedMs: 0 });
    await releaseAudio();
    try {
      if (__DEV__) {
        console.log('[VideoOcrPipeline] extract audio 16 kHz');
      }
      const result = await createOfflineAudioBufferFromVideo(buffer, {
        targetSampleRateHz: 16000,
        signal: controller.signal,
        onProgress: (e) => {
          if (__DEV__) {
            console.log(
              '[VideoOcrPipeline] extract audio progress',
              e.percent,
              'decodedMs=',
              e.decodedMs
            );
          }
          setAudioProgress(e);
        },
      });
      audioRef.current = result.audio;
      setExtractedAudio(result.audio);
      setAudioMeta({
        mediaStartMs: result.mediaStartMs,
        sourceCodec: result.sourceCodec,
        sourceSampleRate: result.sourceSampleRate,
        sourceChannels: result.sourceChannels,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setAudioError(
        isCancelledMessage(message)
          ? 'Audio extract cancelled (VIDEO_CANCELLED).'
          : message
      );
    } finally {
      audioAbortRef.current = null;
      setAudioBusy(false);
      setAudioProgress(null);
    }
  }, [buffer, releaseAudio]);

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
      if (isCancelledMessage(msg)) {
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

  const nativeBusy = extractBusy || audioBusy || ocrBusy;
  const recognizeReady =
    ocr.isEngineInitialized && images != null && !nativeBusy;

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
            disabled={nativeBusy || buffer == null}
          />
          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[
                styles.primaryButton,
                styles.actionButtonFlex,
                (nativeBusy || buffer == null) && styles.primaryButtonDisabled,
              ]}
              onPress={() => {
                handleExtract().catch(() => {});
              }}
              disabled={nativeBusy || buffer == null}
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
            {extractBusy ? (
              <TouchableOpacity
                style={[styles.secondaryButton, styles.actionButtonFlex]}
                onPress={() => {
                  extractAbortRef.current?.abort();
                }}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <ExtractProgressBox
            visible={extractBusy}
            label="Copying RGB frames"
            percent={extractProgress?.percent ?? 0}
            detail={
              extractProgress && extractProgress.total > 0
                ? `${extractProgress.completed}/${extractProgress.total} · pts ${extractProgress.ptsUs} µs`
                : extractProgress
                ? 'waiting for first frame'
                : null
            }
          />
          {extractError ? (
            <Text style={styles.errorText}>{extractError}</Text>
          ) : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>2.1 Extract audio (optional)</Text>
          <Text style={styles.sectionHint}>
            createOfflineAudioBufferFromVideo at 16 kHz (STT default). Same clip
            as the preview above. Not required for OCR.
          </Text>
          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[
                styles.primaryButton,
                styles.actionButtonFlex,
                (nativeBusy || buffer == null) && styles.primaryButtonDisabled,
              ]}
              onPress={() => {
                handleExtractAudio().catch(() => {});
              }}
              disabled={nativeBusy || buffer == null}
              activeOpacity={0.7}
            >
              {audioBusy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryButtonText}>
                  createOfflineAudioBufferFromVideo
                </Text>
              )}
            </TouchableOpacity>
            {audioBusy ? (
              <TouchableOpacity
                style={[styles.secondaryButton, styles.actionButtonFlex]}
                onPress={() => {
                  audioAbortRef.current?.abort();
                }}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <ExtractProgressBox
            visible={audioBusy}
            label="Decoding clip audio"
            percent={audioProgress?.percent ?? 0}
            detail={
              audioProgress
                ? `${Math.round(audioProgress.decodedMs)} ms decoded`
                : null
            }
          />
          {audioError ? (
            <Text style={styles.errorText}>{audioError}</Text>
          ) : null}
          {extractedAudio && audioMeta ? (
            <PipelineOfflineAudioResultCard
              ref={audioCardRef}
              bufferId={extractedAudio.bufferId}
              sourceLabel={`${audioMeta.sourceCodec} ${
                audioMeta.sourceSampleRate
              } Hz × ${audioMeta.sourceChannels} → ${
                extractedAudio.info.sampleRate
              } Hz · mediaStart ${audioMeta.mediaStartMs.toFixed(1)} ms`}
              sampleRate={extractedAudio.info.sampleRate}
              durationMs={extractedAudio.info.durationMs}
              onDismiss={() => {
                releaseAudio().catch(() => {});
              }}
              disabled={audioBusy}
            />
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
            disabled={nativeBusy}
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
