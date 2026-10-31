import { useCallback, useMemo, useState } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Clipboard from '@react-native-clipboard/clipboard';
import { getCodecInfo } from 'react-native-sherpa-onnx/codec';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';

type SmokeItem = {
  id: string;
  title: string;
  device: string;
  steps: string;
  expected: string;
  grep: string;
};

const SMOKE: SmokeItem[] = [
  {
    id: 'S0.1',
    title: 'Dump Android catalog',
    device: 'A142P (plus Qualcomm/Exynos if available)',
    steps:
      'Open this screen or any VideoBuffer screen so VideoBuffer init runs. Filter logcat.',
    expected: 'codec.catalog.raw lines for every AVC/HEVC codec',
    grep: 'adb logcat -s SherpaOnnxCodec SherpaOnnx',
  },
  {
    id: 'S0.2',
    title: 'VideoToolbox hw= line',
    device: 'iPhone iOS 17+',
    steps: 'Decode + export once (Video Preview, then File IO export).',
    expected: 'codec.vt decode hw=… and codec.vt encode hw=…',
    grep: 'codec.vt',
  },
  {
    id: 'S1.1',
    title: 'Encode pool-full',
    device: 'A142P',
    steps: 'Start two exports in parallel.',
    expected:
      'second rejects VIDEO_ENCODER_UNAVAILABLE, codecReason: pool-full; slotFreed after first',
    grep: 'codec.slot',
  },
  {
    id: 'S1.2',
    title: 'Plan / try / select logs',
    device: 'A142P',
    steps: 'Any decode + export.',
    expected:
      'codec.plan / codec.try / codec.select / codec.slot release per open',
    grep: 'codec.plan|codec.try|codec.select|codec.slot',
  },
  {
    id: 'S2.1',
    title: 'Android platform SW decode',
    device: 'A142P',
    steps: '1080p H.264, decodePolicy software, then sample frames.',
    expected:
      'provider c2.android.avc.decoder; sampled frames vs HW PSNR ≥ 40 dB',
    grep: 'codec.select',
  },
  {
    id: 'S2.2',
    title: '4K HEVC software without variant',
    device: 'A142P',
    steps: '4K HEVC, software, default FFmpeg (no ffmpeg-vsw).',
    expected:
      'VIDEO_SW_DECODER_DISABLED; attempts list platform HEVC SW as unsupported-stream',
    grep: 'VIDEO_SW_DECODER_DISABLED|unsupported-stream',
  },
  {
    id: 'S2.3',
    title: 'Display budget fallback',
    device: 'A142P',
    steps: 'display budget 1, two previews, default policy.',
    expected: 'second preview on SW; one fallback event',
    grep: 'codec.fallback|hwVideoDisplay',
  },
  {
    id: 'S2.4',
    title: 'Software encode 720p',
    device: 'A142P',
    steps: 'export 720p encodePolicy software.',
    expected: 'c2.android.avc.encoder; file plays',
    grep: 'codec.select',
  },
  {
    id: 'S2.5',
    title: 'Software encode 1080p caps',
    device: 'A142P',
    steps: 'export 1080p encodePolicy software.',
    expected: 'VIDEO_ENCODER_UNAVAILABLE / unsupported-stream (D7)',
    grep: 'unsupported-stream',
  },
  {
    id: 'S2.6',
    title: 'Reclaim mid-stream',
    device: 'A142P',
    steps: 'export, then open the camera app.',
    expected: 'codec.midstream reopen once, or clean encoder error',
    grep: 'codec.midstream',
  },
  {
    id: 'S2.7',
    title: 'AVD default vs hardware',
    device: 'AVD emulator',
    steps: 'decode default vs hardware.',
    expected: 'default SW + fallback; hardware → VIDEO_DECODER_UNAVAILABLE',
    grep: 'codec.fallback|VIDEO_DECODER_UNAVAILABLE',
  },
  {
    id: 'S3.1',
    title: 'iOS VT software',
    device: 'iPhone iOS 17+',
    steps: 'decodePolicy software.',
    expected: 'hw=0, decision software, DecodedSampleBufferRenderer',
    grep: 'codec.vt|vt.sw',
  },
  {
    id: 'S3.2',
    title: 'iOS hardware busy',
    device: 'iPhone iOS 17+',
    steps: 'hardware while HW is busy (two exports + preview).',
    expected: 'clean UNAVAILABLE, no silent SW',
    grep: 'VIDEO_DECODER_UNAVAILABLE|VIDEO_ENCODER_UNAVAILABLE',
  },
  {
    id: 'S3.3',
    title: 'iOS background invalid-session',
    device: 'iPhone',
    steps: 'background the app during decode.',
    expected: 'invalid-session → one mid-stream reopen or clean error',
    grep: 'invalid-session|codec.midstream',
  },
  {
    id: 'S4.1',
    title: 'ffmpeg-vsw 4K HEVC',
    device: 'Android + iPhone, ffmpeg-vsw build',
    steps: '4K HEVC software, OCR at 1 fps.',
    expected: 'provider ffmpeg.hevc; OCR results arrive',
    grep: 'ffmpeg.hevc',
  },
  {
    id: 'S4.2',
    title: 'Default build SW disabled',
    device: 'same device, default FFmpeg',
    steps: 'same 4K HEVC software call.',
    expected: 'VIDEO_SW_DECODER_DISABLED',
    grep: 'VIDEO_SW_DECODER_DISABLED',
  },
  {
    id: 'S5.1',
    title: 'Android JPEG platform',
    device: 'Android API 30+',
    steps: 'JPEG create, default policy.',
    expected: 'decision hardware / platform / AImageDecoder',
    grep: 'AImageDecoder|platform',
  },
  {
    id: 'S5.2',
    title: 'API 28–29 JPEG + HEIC',
    device: 'Android API 28 or 29',
    steps: 'JPEG + HEIC create, default policy.',
    expected: 'JPEG stb + fallback os-too-old; HEIC ImageDecoder.java',
    grep: 'os-too-old|ImageDecoder.java',
  },
  {
    id: 'S5.3',
    title: 'API 26 HEIC unavailable',
    device: 'Android API 26',
    steps: 'HEIC create, default policy.',
    expected: 'ERR_IMAGE_SW_DECODER_UNAVAILABLE',
    grep: 'ERR_IMAGE_SW_DECODER_UNAVAILABLE',
  },
  {
    id: 'S5.4',
    title: 'iOS ImageIO thumbnail',
    device: 'iPhone',
    steps: 'HEIC + JPEG create with maxSide, EXIF-6 fixture.',
    expected: 'ImageIO thumbnail path, EXIF-6 upright',
    grep: 'ImageIO|imageio',
  },
];

function ReportBox({ report }: { report: string }) {
  return (
    <View style={styles.reportBox}>
      <Text style={styles.mono} selectable>
        {report}
      </Text>
    </View>
  );
}

export default function CodecSmokeScreen() {
  const [copied, setCopied] = useState(false);
  const [infoText, setInfoText] = useState(
    'Tap Dump catalog to call getCodecInfo.'
  );

  const report = useMemo(() => {
    const lines = [
      `platform=${Platform.OS} ${String(Platform.Version)}`,
      `when=${new Date().toISOString()}`,
      '',
      infoText,
      '',
      'Paste logcat / Xcode lines below:',
      '',
    ];
    return lines.join('\n');
  }, [infoText]);

  const onCopy = useCallback(() => {
    Clipboard.setString(report);
    setCopied(true);
  }, [report]);

  const onDump = useCallback(async () => {
    if (__DEV__) {
      console.log('[CodecSmoke] dump start');
    }
    try {
      const info = await getCodecInfo();
      if (__DEV__) {
        console.log('[CodecSmoke] dump ok', {
          ramClass: info.ramClass,
          providers: info.providers?.length ?? 0,
          slots: info.slots?.length ?? 0,
        });
      }
      setInfoText(JSON.stringify(info, null, 2));
    } catch (e) {
      const err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      if (__DEV__) {
        console.log('[CodecSmoke] dump fail', err);
      }
      setInfoText(`getCodecInfo failed\n${err}`);
    }
  }, []);

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScreenIntroModal screenId="CodecSmoke" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.h1}>Codec smoke</Text>
        <Text style={styles.body}>
          Run on a device. Implementation does not wait for these. Each item is
          one debug-first bug if it fails.
        </Text>
        <TouchableOpacity style={styles.button} onPress={onDump}>
          <Text style={styles.buttonText}>Dump catalog / getCodecInfo</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.buttonSecondary} onPress={onCopy}>
          <Text style={styles.buttonText}>
            {copied ? 'Copied report' : 'Copy report template'}
          </Text>
        </TouchableOpacity>
        <ReportBox report={report} />
        {SMOKE.map((item) => (
          <View key={item.id} style={styles.card}>
            <Text style={styles.id}>
              {item.id} · {item.device}
            </Text>
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.body}>{item.steps}</Text>
            <Text style={styles.expect}>Expected: {item.expected}</Text>
            <Text style={styles.mono}>{item.grep}</Text>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { padding: 16, paddingBottom: 40 },
  h1: { fontSize: 22, fontWeight: '700', marginBottom: 8, color: '#111' },
  body: { fontSize: 15, color: '#333', marginBottom: 8, lineHeight: 21 },
  expect: { fontSize: 14, color: '#155724', marginBottom: 6 },
  id: { fontSize: 12, fontWeight: '600', color: '#666', marginBottom: 4 },
  title: { fontSize: 17, fontWeight: '600', marginBottom: 6, color: '#111' },
  mono: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    color: '#222',
  },
  button: {
    backgroundColor: '#007AFF',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 10,
  },
  buttonSecondary: {
    backgroundColor: '#444',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 14,
  },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  reportBox: {
    backgroundColor: '#F4F4F5',
    borderRadius: 8,
    padding: 10,
    marginBottom: 16,
  },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#CCC',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
});
