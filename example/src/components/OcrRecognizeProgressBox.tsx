import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useState,
} from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type {
  OcrConcreteModelType,
  OcrProgress,
} from 'react-native-sherpa-onnx/ocr';

const OCR_PHASES_BY_FAMILY: Record<OcrConcreteModelType, readonly string[]> = {
  nemotron_parse: [
    'preprocess',
    'patch',
    'vision',
    'embed',
    'prefill',
    'decode',
    'parse',
  ],
  paddleocr_vl: ['preprocess', 'vision', 'embed', 'prefill', 'decode', 'parse'],
  doc_vlm: ['preprocess', 'vision', 'embed', 'prefill', 'decode', 'parse'],
  ppocr: ['preprocess', 'detect', 'recognize'],
  doctr: ['preprocess', 'detect', 'recognize'],
};

const LONG_ONESHOT_PHASES = new Set(['vision', 'prefill', 'detect']);

function phaseIndexOf(
  family: OcrConcreteModelType | null,
  phase: string
): { index: number; count: number } | null {
  if (!family) {
    return null;
  }
  const phases = OCR_PHASES_BY_FAMILY[family];
  const idx = phases.indexOf(phase);
  if (idx < 0) {
    return null;
  }
  return { index: idx + 1, count: phases.length };
}

export type OcrProgressBoxHandle = {
  apply(progress: OcrProgress): void;
  reset(): void;
};

type Props = {
  family: OcrConcreteModelType | null;
};

export const OcrRecognizeProgressBox = memo(
  forwardRef<OcrProgressBoxHandle, Props>(function OcrRecognizeProgressBox(
    { family },
    ref
  ) {
    const [phase, setPhase] = useState<string | null>(null);
    const [label, setLabel] = useState<string | null>(null);
    const [phaseIndex, setPhaseIndex] = useState<number | null>(null);
    const [phaseCount, setPhaseCount] = useState<number | null>(null);
    const [percent, setPercent] = useState<number | null>(null);

    const reset = useCallback(() => {
      setPhase(null);
      setLabel(null);
      setPhaseIndex(null);
      setPhaseCount(null);
      setPercent(null);
    }, []);

    const apply = useCallback(
      (p: OcrProgress) => {
        const nextPercent =
          p.total > 0 ? Math.round((100 * p.done) / p.total) : null;
        const frameBit =
          p.frameCount > 1 ? `frame ${p.frameIndex + 1}/${p.frameCount}` : '';
        const inPhaseBit = p.total > 0 ? `${p.done}/${p.total}` : '…';
        const detail = [frameBit, inPhaseBit]
          .filter((bit) => bit.length > 0)
          .join(' · ');
        const phaseMeta = phaseIndexOf(family, p.phase);
        setPhase(p.phase);
        setLabel(detail);
        setPhaseIndex(phaseMeta?.index ?? null);
        setPhaseCount(phaseMeta?.count ?? null);
        setPercent(nextPercent);
      },
      [family]
    );

    useImperativeHandle(ref, () => ({ apply, reset }), [apply, reset]);

    if (!phase) {
      return null;
    }
    const showLongOneshotHint = LONG_ONESHOT_PHASES.has(phase) && percent === 0;
    return (
      <View style={styles.progressBox}>
        <View style={styles.progressHeader}>
          <Text style={styles.progressPhase} numberOfLines={1}>
            {phase}
            {label ? ` · ${label}` : ''}
          </Text>
          {phaseIndex != null && phaseCount != null ? (
            <Text style={styles.progressPhaseCount}>
              {phaseIndex} / {phaseCount}
            </Text>
          ) : null}
        </View>
        {showLongOneshotHint ? (
          <Text style={styles.progressWaitHint}>
            This step can take a while (single model run, no in-step ticks). The
            app is not frozen — please wait.
          </Text>
        ) : null}
        {percent != null ? (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${percent}%` }]} />
          </View>
        ) : null}
      </View>
    );
  })
);
OcrRecognizeProgressBox.displayName = 'OcrRecognizeProgressBox';

const styles = StyleSheet.create({
  progressBox: {
    backgroundColor: '#f0f0f0',
    borderRadius: 8,
    padding: 12,
    marginTop: 8,
  },
  progressHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 8,
  },
  progressPhase: {
    flex: 1,
    fontSize: 13,
    color: '#334155',
  },
  progressPhaseCount: {
    fontSize: 13,
    fontWeight: '700',
    color: '#007AFF',
    fontVariant: ['tabular-nums'],
  },
  progressWaitHint: {
    fontSize: 12,
    lineHeight: 16,
    color: '#c00',
    marginBottom: 8,
  },
  progressTrack: {
    height: 6,
    backgroundColor: '#ddd',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: 6,
    backgroundColor: '#007AFF',
  },
});
