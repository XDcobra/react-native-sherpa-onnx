import { StyleSheet, Switch, Text, View } from 'react-native';
import {
  OCR_CAPABILITIES,
  OCR_DEFAULT_INSTRUCTIONS,
  type OcrDocVlmElement,
  type OcrFamily,
  type OcrGranularity,
  type OcrPaddleocrVlTask,
  type OcrTaskOf,
  type OcrVlmRawMode,
} from 'react-native-sherpa-onnx/ocr';
import {
  DocVlmInitOptionChips,
  OcrDbDetectorChips,
  PaddleocrVlMaxPixelsChips,
} from '../modelInit';
import {
  isDbDetectorOcrFamily,
  isVlmOcrFamily,
} from '../../utils/ocrModelCatalog';
import { OcrChoiceRow } from './OcrChoiceRow';

const GRANITE_ELEMENTS: readonly OcrDocVlmElement[] = [
  'table',
  'formula',
  'code',
];

const PPOCR_MAX_SIDE_PRESETS = [0, 640, 960, 1280] as const;

export type OcrRecognizeInstructionState = {
  paddleocrVlTask: OcrPaddleocrVlTask;
  setPaddleocrVlTask: (task: OcrPaddleocrVlTask) => void;
  graniteTask: OcrTaskOf<'doc_vlm'>;
  setGraniteTask: (task: OcrTaskOf<'doc_vlm'>) => void;
  graniteElement: OcrDocVlmElement;
  setGraniteElement: (element: OcrDocVlmElement) => void;
  granularity: OcrGranularity;
  setGranularity: (granularity: OcrGranularity) => void;
  vlmRaw: OcrVlmRawMode;
  setVlmRaw: (raw: OcrVlmRawMode) => void;
};

type Props = {
  family: OcrFamily | null;
  disabled?: boolean;
  maxNewTokens: number;
  onChangeMaxNewTokens: (value: number) => void;
  maxPixels: number;
  onChangeMaxPixels: (value: number) => void;
  detBoxThresh: number;
  detBoxScoreThresh: number;
  onChangeBoxThresh: (value: number) => void;
  onChangeBoxScoreThresh: (value: number) => void;
  maxSideLen: number;
  onChangeMaxSideLen: (value: number) => void;
  useOrientationCls: boolean;
  onChangeUseOrientationCls: (value: boolean) => void;
  recognize?: OcrRecognizeInstructionState;
};

export function OcrFamilyPublicApiFields({
  family,
  disabled = false,
  maxNewTokens,
  onChangeMaxNewTokens,
  maxPixels,
  onChangeMaxPixels,
  detBoxThresh,
  detBoxScoreThresh,
  onChangeBoxThresh,
  onChangeBoxScoreThresh,
  maxSideLen,
  onChangeMaxSideLen,
  useOrientationCls,
  onChangeUseOrientationCls,
  recognize,
}: Props) {
  if (!family) {
    return (
      <Text style={styles.hint}>
        Select a pack to show that family’s public createOCR / recognize fields.
      </Text>
    );
  }

  const capabilities = OCR_CAPABILITIES[family];
  const showInitVlm = isVlmOcrFamily(family);
  const showDb = isDbDetectorOcrFamily(family);
  const showRecognize = recognize != null;
  const granularities = capabilities.granularities;

  return (
    <View style={styles.block}>
      <Text style={styles.familyBadge}>Family {family}</Text>
      <Text style={styles.hint}>
        Only public fields this family accepts. Re-init applies createOCR
        values; instruction / granularity apply on the next recognize.
      </Text>

      <Text style={styles.subheading}>createOCR</Text>
      {showInitVlm ? (
        <DocVlmInitOptionChips
          maxNewTokens={maxNewTokens}
          onChangeMaxNewTokens={onChangeMaxNewTokens}
          disabled={disabled}
        />
      ) : null}
      {family === 'paddleocr_vl' ? (
        <PaddleocrVlMaxPixelsChips
          maxPixels={maxPixels}
          onChangeMaxPixels={onChangeMaxPixels}
          disabled={disabled}
        />
      ) : null}
      {showDb ? (
        <OcrDbDetectorChips
          family={family}
          detBoxThresh={detBoxThresh}
          detBoxScoreThresh={detBoxScoreThresh}
          onChangeBoxThresh={onChangeBoxThresh}
          onChangeBoxScoreThresh={onChangeBoxScoreThresh}
          disabled={disabled}
        />
      ) : null}
      {family === 'ppocr' ? (
        <>
          <OcrChoiceRow
            label="ppocr.maxSideLen"
            hint="Longest image side before detect (0 = native 960)."
            options={PPOCR_MAX_SIDE_PRESETS}
            value={maxSideLen}
            onChange={onChangeMaxSideLen}
            disabled={disabled}
            formatLabel={(v) => (v === 0 ? 'default' : String(v))}
          />
          <View style={styles.switchRow}>
            <View style={styles.switchCopy}>
              <Text style={styles.label}>ppocr.useOrientationCls</Text>
              <Text style={styles.hint}>
                Run the optional 180° classifier before recognize.
              </Text>
            </View>
            <Switch
              value={useOrientationCls}
              onValueChange={onChangeUseOrientationCls}
              disabled={disabled}
            />
          </View>
        </>
      ) : null}

      {showRecognize ? (
        <>
          <Text style={styles.subheading}>recognize</Text>
          {family === 'paddleocr_vl' ? (
            <OcrChoiceRow
              label="instruction.task"
              hint="PaddleOCR-VL control prompt. Same loaded session."
              options={OCR_CAPABILITIES.paddleocr_vl.tasks}
              value={recognize.paddleocrVlTask}
              onChange={recognize.setPaddleocrVlTask}
              disabled={disabled}
            />
          ) : null}
          {family === 'doc_vlm' ? (
            <>
              <OcrChoiceRow
                label="instruction.task"
                hint="Granite page / element / region. Crop + region is rejected."
                options={OCR_CAPABILITIES.doc_vlm.tasks}
                value={recognize.graniteTask}
                onChange={recognize.setGraniteTask}
                disabled={disabled}
              />
              {recognize.graniteTask === 'element' ? (
                <OcrChoiceRow
                  label="instruction.element"
                  hint="chart is gated (emits unknown). Public elements: table, formula, code."
                  options={GRANITE_ELEMENTS}
                  value={recognize.graniteElement}
                  onChange={recognize.setGraniteElement}
                  disabled={disabled}
                />
              ) : null}
              <OcrChoiceRow
                label="raw"
                hint="accepted (default) stops on invalid_sequence. full keeps decoding so result.raw is the complete model stream."
                options={['accepted', 'full'] as const}
                value={recognize.vlmRaw}
                onChange={recognize.setVlmRaw}
                disabled={disabled}
              />
            </>
          ) : null}
          {family === 'nemotron_parse' ? (
            <>
              <OcrChoiceRow
                label="instruction.task"
                hint="Public Nemotron union is page only."
                options={OCR_CAPABILITIES.nemotron_parse.tasks}
                value={OCR_DEFAULT_INSTRUCTIONS.nemotron_parse.task}
                onChange={() => {}}
                locked
              />
              <OcrChoiceRow
                label="instruction.output"
                hint="Locked to markdown_none_pic (layout none, text in pictures)."
                options={['markdown / layout:none / textInPictures'] as const}
                value="markdown / layout:none / textInPictures"
                onChange={() => {}}
                locked
              />
            </>
          ) : null}
          {capabilities.tasks.length === 0 ? (
            <Text style={styles.hint}>
              {family} has no instruction.task (line OCR).
            </Text>
          ) : null}
          {granularities.length > 1 ? (
            <OcrChoiceRow
              label="granularity"
              hint="doc_vlm titles/tables stay line; block is media (picture/chart)."
              options={granularities}
              value={recognize.granularity}
              onChange={recognize.setGranularity}
              disabled={disabled}
            />
          ) : (
            <OcrChoiceRow
              label="granularity"
              hint="This family only emits line spans."
              options={granularities}
              value={granularities[0] ?? 'line'}
              onChange={() => {}}
              locked
            />
          )}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 10,
  },
  familyBadge: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1D4ED8',
    fontFamily: 'Menlo',
  },
  subheading: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
    marginTop: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
  },
  hint: {
    fontSize: 13,
    color: '#64748b',
    lineHeight: 18,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  switchCopy: {
    flex: 1,
    gap: 4,
  },
});
