import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from '@react-native-documents/picker';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import { DECODABLE_AUDIO_PICKER_TYPES } from '../../utils/decodableAudioPickerTypes';
import {
  createDiarization,
  detectDiarizationModel,
  type DiarizationEngine,
} from 'react-native-sherpa-onnx/diarization';
import { detectSpeakerEmbeddingModel } from 'react-native-sherpa-onnx/speaker-identification';
import {
  createEmptyOfflineSegmentBuffer,
  getOfflineSegmentBufferSegments,
  releasePipelineSegmentBuffer,
  type DiarizationSegmentMeta,
} from 'react-native-sherpa-onnx/segmentbuffer';
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  listDownloadedModels,
  ModelCategory,
} from 'react-native-sherpa-onnx/download';
import { listAssetModels } from 'react-native-sherpa-onnx/utils';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  getAssetModelPath,
  getFileModelPath,
  toDetectSource,
} from '../../modelConfig';
import { toFileSource } from '../../utils/fileSourceFromUri';

const DEFAULT_SEG_FOLDER = 'sherpa-onnx-pyannote-segmentation-3-0';
const DEFAULT_EMB_FOLDER =
  '3dspeaker_speech_eres2net_large_sv_zh-cn_3dspeaker_16k';

export default function DiarizationScreen() {
  const engineRef = useRef<DiarizationEngine | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Pick an audio file to diarize.');
  const [progress, setProgress] = useState(0);
  const [segments, setSegments] = useState<DiarizationSegmentMeta[]>([]);
  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [segModelHint, setSegModelHint] = useState(DEFAULT_SEG_FOLDER);
  const [embModelHint, setEmbModelHint] = useState(DEFAULT_EMB_FOLDER);
  const [segSource, setSegSource] = useState<FileSource | null>(null);
  const [embSource, setEmbSource] = useState<FileSource | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [assets, dlSeg, dlEmb] = await Promise.all([
          listAssetModels(),
          listDownloadedModels(ModelCategory.Diarization).catch(() => []),
          listDownloadedModels(ModelCategory.SpeakerEmbedding).catch(() => []),
        ]);

        const segAsset = assets.find(
          (m) =>
            m.folder.includes('pyannote') ||
            m.folder.includes('reverb') ||
            m.folder.includes('segmentation')
        );
        const embAsset = assets.find(
          (m) =>
            m.folder.includes('eres2net') ||
            m.folder.includes('wespeaker') ||
            m.folder.includes('titanet') ||
            m.folder.includes('3dspeaker')
        );

        const segFolder =
          dlSeg[0]?.id ?? segAsset?.folder ?? DEFAULT_SEG_FOLDER;
        const embFolder =
          dlEmb[0]?.id ?? embAsset?.folder ?? DEFAULT_EMB_FOLDER;

        const segFs = dlSeg.some((m) => m.id === segFolder)
          ? getFileModelPath(segFolder, ModelCategory.Diarization)
          : getAssetModelPath(segFolder);
        const embFs = dlEmb.some((m) => m.id === embFolder)
          ? getFileModelPath(embFolder, ModelCategory.SpeakerEmbedding)
          : getAssetModelPath(embFolder);

        if (!cancelled) {
          setSegModelHint(segFolder);
          setEmbModelHint(embFolder);
          setSegSource(segFs);
          setEmbSource(embFs);
        }
      } catch {
        if (!cancelled) {
          setSegSource(getAssetModelPath(DEFAULT_SEG_FOLDER));
          setEmbSource(getAssetModelPath(DEFAULT_EMB_FOLDER));
        }
      }
    })();
    return () => {
      cancelled = true;
      const eng = engineRef.current;
      engineRef.current = null;
      eng?.destroy().catch(() => undefined);
    };
  }, []);

  const pickAudio = useCallback(async () => {
    try {
      const [result] = await DocumentPicker.pick({
        type: DECODABLE_AUDIO_PICKER_TYPES,
      });
      if (result?.uri) {
        setAudioPath(result.uri);
        setStatus(`Selected: ${result.name ?? result.uri}`);
        setSegments([]);
      }
    } catch (e) {
      if (
        (DocumentPicker as { isCancel?: (err: unknown) => boolean }).isCancel?.(
          e
        )
      ) {
        return;
      }
      setStatus(`Pick failed: ${String(e)}`);
    }
  }, []);

  const runDiarize = useCallback(async () => {
    if (!audioPath) {
      setStatus('Pick an audio file first.');
      return;
    }
    if (!segSource || !embSource) {
      setStatus('Models not resolved yet.');
      return;
    }
    setBusy(true);
    setProgress(0);
    setSegments([]);
    let audioId: string | null = null;
    let segOutId: string | null = null;
    try {
      setStatus('Loading models…');
      const segDetectSrc = await toDetectSource(segSource);
      const embDetectSrc = await toDetectSource(embSource);

      const detect = await detectDiarizationModel(segDetectSrc);
      if (!detect.success || !detect.paths?.model) {
        throw new Error(detect.error ?? 'Segmentation model detect failed');
      }

      const embDetect = await detectSpeakerEmbeddingModel(embDetectSrc);
      if (!embDetect.success || !embDetect.paths?.model) {
        throw new Error(
          embDetect.error ?? 'Speaker embedding model detect failed'
        );
      }

      if (engineRef.current) {
        await engineRef.current.destroy();
        engineRef.current = null;
      }

      const engine = await createDiarization({
        segmentation: {
          modelSource: { kind: 'fs', path: detect.paths.model },
        },
        embedding: {
          modelSource: { kind: 'fs', path: embDetect.paths.model },
        },
        clustering: { threshold: 0.5 },
      });
      engineRef.current = engine;

      setStatus('Decoding audio…');
      const audio = await createOfflineAudioBufferFromFile(
        toFileSource(audioPath)
      );
      audioId = audio.bufferId;

      const segOut = await createEmptyOfflineSegmentBuffer({
        sourceAudioBufferId: audio.bufferId,
      });
      segOutId = segOut.bufferId;

      setStatus('Diarizing…');
      const result = await engine.diarize(audio.bufferId, segOut.bufferId, {
        onProgress: (p) => setProgress(Math.round((p.fraction ?? 0) * 100)),
      });

      const metas = await getOfflineSegmentBufferSegments(
        segOut.bufferId,
        0,
        4096
      );
      setSegments(
        metas.filter(
          (m): m is DiarizationSegmentMeta => m.kind === 'diarization'
        )
      );
      setStatus(
        `Done: ${result.numSpeakers} speakers, ${result.segmentCount} segments (${result.processingTimeMs} ms)`
      );
      setProgress(100);
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (audioId)
        await releasePipelineAudioBuffer(audioId).catch(() => undefined);
      if (segOutId)
        await releasePipelineSegmentBuffer(segOutId).catch(() => undefined);
      setBusy(false);
    }
  }, [audioPath, embSource, segSource]);

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Speaker Diarization</Text>
        <Text style={styles.hint}>
          Segmentation: {segModelHint}
          {'\n'}
          Embedding: {embModelHint}
        </Text>

        <TouchableOpacity
          style={styles.button}
          onPress={pickAudio}
          disabled={busy}
        >
          <Text style={styles.buttonText}>Pick audio</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.primary]}
          onPress={runDiarize}
          disabled={busy || !audioPath}
        >
          <Text style={styles.buttonText}>{busy ? 'Running…' : 'Diarize'}</Text>
        </TouchableOpacity>

        {busy ? (
          <View style={styles.progressRow}>
            <ActivityIndicator />
            <Text style={styles.progressText}>{progress}%</Text>
          </View>
        ) : null}

        <Text style={styles.status}>{status}</Text>

        {segments.length > 0 ? (
          <View style={styles.table}>
            <Text style={styles.tableHeader}># speaker time</Text>
            {segments.map((s, i) => {
              const start = (s.startSample / s.sampleRate).toFixed(2);
              const end = (s.endSample / s.sampleRate).toFixed(2);
              const speaker = s.payload?.speaker ?? '?';
              return (
                <Text key={s.id} style={styles.row}>
                  {i}: speaker {speaker} {start}s – {end}s
                </Text>
              );
            })}
          </View>
        ) : null}
      </ScrollView>
      <ScreenIntroModal screenId="Diarization" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F2F2F7' },
  content: { padding: 20, paddingBottom: 40 },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 8 },
  hint: { fontSize: 13, color: '#8E8E93', marginBottom: 16, lineHeight: 18 },
  button: {
    backgroundColor: '#3A3A3C',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginBottom: 10,
    alignItems: 'center',
  },
  primary: { backgroundColor: '#007AFF' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginVertical: 8,
  },
  progressText: { fontSize: 14, color: '#3A3A3C' },
  status: { marginTop: 12, fontSize: 14, color: '#3A3A3C', lineHeight: 20 },
  table: {
    marginTop: 16,
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 12,
  },
  tableHeader: {
    fontFamily: 'Courier',
    fontSize: 12,
    color: '#8E8E93',
    marginBottom: 8,
  },
  row: { fontFamily: 'Courier', fontSize: 13, marginBottom: 4, color: '#000' },
});
