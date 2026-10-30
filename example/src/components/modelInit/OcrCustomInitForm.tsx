import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  PADDLEOCR_VL_MIN_PIXELS,
  PADDLEOCR_VL_MOBILE_MAX_PIXELS,
  PADDLEOCR_VL_OFFICIAL_MAX_PIXELS,
  PADDLEOCR_VL_SPOTTING_MAX_PIXELS,
  type OcrConcreteModelType,
  type OcrCustomPathKey,
} from 'react-native-sherpa-onnx/ocr';
import {
  getCustomModelPathRequirements,
  type CustomModelPathRequirements,
} from 'react-native-sherpa-onnx/detect';
import { ModelCategory } from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { FileSourceSlotPicker } from './FileSourceSlotPicker';

const OCR_CONCRETE_TYPES: readonly OcrConcreteModelType[] = [
  'ppocr',
  'doctr',
  'doc_vlm',
  'nemotron_parse',
  'paddleocr_vl',
];

export type OcrCustomInitFormState = {
  modelType: OcrConcreteModelType;
  fileSources: Partial<Record<OcrCustomPathKey, FileSource>>;
  /** 0 → backend default (8192). Used by VLM families. */
  maxNewTokens: number;
  /** 0 → official 1003520. Used by paddleocr_vl. */
  maxPixels: number;
  /** 0 → native default. Used by ppocr/doctr. */
  detBoxThresh: number;
  /** 0 → native default. Used by ppocr/doctr. */
  detBoxScoreThresh: number;
};

type OcrCustomInitFormProps = {
  value: OcrCustomInitFormState;
  onChange: (next: OcrCustomInitFormState) => void;
  selectedCatalogModelId: string | null;
  onFillFromSelectedModel: () => void;
  onPrepareScatteredTest: () => void;
  fillLoading?: boolean;
  disabled?: boolean;
  fillHint?: string | null;
  showScatteredTest?: boolean;
};

const MAX_NEW_TOKEN_PRESETS = [0, 512, 2048, 4096, 8192] as const;
const MAX_PIXEL_PRESETS = [
  0,
  PADDLEOCR_VL_MOBILE_MAX_PIXELS,
  PADDLEOCR_VL_MIN_PIXELS,
  PADDLEOCR_VL_SPOTTING_MAX_PIXELS,
] as const;
const DET_BOX_THRESH_PRESETS = [0, 0.15, 0.3] as const;
const DET_BOX_SCORE_THRESH_PRESETS = [0, 0.15, 0.5] as const;

type DocVlmInitOptionChipsProps = {
  maxNewTokens: number;
  onChangeMaxNewTokens: (value: number) => void;
  disabled?: boolean;
};

export function DocVlmInitOptionChips({
  maxNewTokens,
  onChangeMaxNewTokens,
  disabled = false,
}: DocVlmInitOptionChipsProps) {
  return (
    <View>
      <Text style={styles.subheading}>maxNewTokens</Text>
      <Text style={styles.hint}>
        Cap on generated VLM tokens. 0 uses the backend default (8192). 512 is
        only enough for short goldens; full pages need a higher cap.
      </Text>
      <View style={styles.typeRow}>
        {MAX_NEW_TOKEN_PRESETS.map((preset) => {
          const active = maxNewTokens === preset;
          return (
            <TouchableOpacity
              key={preset}
              style={[styles.typeChip, active && styles.typeChipActive]}
              onPress={() => onChangeMaxNewTokens(preset)}
              disabled={disabled}
            >
              <Text
                style={[
                  styles.typeChipText,
                  active && styles.typeChipTextActive,
                ]}
              >
                {preset === 0 ? 'default' : String(preset)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

type PaddleocrVlMaxPixelsChipsProps = {
  maxPixels: number;
  onChangeMaxPixels: (value: number) => void;
  disabled?: boolean;
};

export function PaddleocrVlMaxPixelsChips({
  maxPixels,
  onChangeMaxPixels,
  disabled = false,
}: PaddleocrVlMaxPixelsChipsProps) {
  return (
    <View>
      <Text style={styles.subheading}>paddleocrVl.maxPixels</Text>
      <Text style={styles.hint}>
        Vision smart_resize area. 0 is the official{' '}
        {PADDLEOCR_VL_OFFICIAL_MAX_PIXELS} cap. {PADDLEOCR_VL_MOBILE_MAX_PIXELS}{' '}
        is a phone-oriented 512-token cap.
      </Text>
      <View style={styles.typeRow}>
        {MAX_PIXEL_PRESETS.map((preset) => {
          const active = maxPixels === preset;
          return (
            <TouchableOpacity
              key={preset}
              style={[styles.typeChip, active && styles.typeChipActive]}
              onPress={() => onChangeMaxPixels(preset)}
              disabled={disabled}
            >
              <Text
                style={[
                  styles.typeChipText,
                  active && styles.typeChipTextActive,
                ]}
              >
                {preset === 0 ? 'official' : String(preset)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

type OcrDbDetectorChipsProps = {
  family?: 'ppocr' | 'doctr';
  detBoxThresh: number;
  detBoxScoreThresh: number;
  onChangeBoxThresh: (value: number) => void;
  onChangeBoxScoreThresh: (value: number) => void;
  disabled?: boolean;
};

export function OcrDbDetectorChips({
  family,
  detBoxThresh,
  detBoxScoreThresh,
  onChangeBoxThresh,
  onChangeBoxScoreThresh,
  disabled = false,
}: OcrDbDetectorChipsProps) {
  const title = family ? `${family} DB detector` : 'ppocr/doctr DB detector';
  return (
    <View>
      <Text style={styles.subheading}>{title}</Text>
      <Text style={styles.hint}>
        0 leaves the native default (ppocr 0.3 / 0.5, doctr 0.15 / 0.15).
        Re-init to apply.
      </Text>
      <Text style={styles.hint}>detBoxThresh</Text>
      <View style={styles.typeRow}>
        {DET_BOX_THRESH_PRESETS.map((preset) => {
          const active = detBoxThresh === preset;
          return (
            <TouchableOpacity
              key={`box-${preset}`}
              style={[styles.typeChip, active && styles.typeChipActive]}
              onPress={() => onChangeBoxThresh(preset)}
              disabled={disabled}
            >
              <Text
                style={[
                  styles.typeChipText,
                  active && styles.typeChipTextActive,
                ]}
              >
                {preset === 0 ? 'default' : String(preset)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={styles.hint}>detBoxScoreThresh</Text>
      <View style={styles.typeRow}>
        {DET_BOX_SCORE_THRESH_PRESETS.map((preset) => {
          const active = detBoxScoreThresh === preset;
          return (
            <TouchableOpacity
              key={`score-${preset}`}
              style={[styles.typeChip, active && styles.typeChipActive]}
              onPress={() => onChangeBoxScoreThresh(preset)}
              disabled={disabled}
            >
              <Text
                style={[
                  styles.typeChipText,
                  active && styles.typeChipTextActive,
                ]}
              >
                {preset === 0 ? 'default' : String(preset)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const PATH_LABELS: Record<OcrCustomPathKey, string> = {
  det: 'Det ONNX',
  rec: 'Rec ONNX',
  cls: 'Cls ONNX (optional)',
  rec_dict: 'Rec dictionary',
  manifest: 'ocr_manifest.json',
  vision_encoder: 'vision_encoder.onnx',
  vision_encoder_data: 'vision_encoder.onnx_data',
  embedding: 'embedding.onnx',
  embedding_data: 'embedding.onnx_data',
  embed_tokens: 'embed_tokens.onnx',
  embed_tokens_data: 'embed_tokens.onnx_data',
  decoder: 'decoder_model_merged.onnx',
  decoder_data: 'decoder_model_merged.onnx_data',
  tokenizer: 'tokenizer.json',
  patch_embed: 'patch_embed.onnx',
  patch_embed_data: 'patch_embed.onnx_data',
  pos_embed: 'pos_embed.npy',
};

export function OcrCustomInitForm({
  value,
  onChange,
  selectedCatalogModelId,
  onFillFromSelectedModel,
  onPrepareScatteredTest,
  fillLoading = false,
  disabled = false,
  fillHint = null,
  showScatteredTest = true,
}: OcrCustomInitFormProps) {
  const [schema, setSchema] = useState<CustomModelPathRequirements>({
    fields: [],
  });
  const [schemaLoading, setSchemaLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSchemaLoading(true);
    getCustomModelPathRequirements(ModelCategory.Ocr, value.modelType)
      .then((requirements) => {
        if (!cancelled) {
          setSchema(requirements);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSchemaLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [value.modelType]);

  const slotKeys = useMemo(
    () =>
      schema.fields.map((field) => ({
        key: field.key as OcrCustomPathKey,
        required: field.required,
      })),
    [schema.fields]
  );

  const setModelType = (modelType: OcrConcreteModelType) => {
    if (modelType === value.modelType) {
      return;
    }
    onChange({
      modelType,
      fileSources: {},
      maxNewTokens: value.maxNewTokens,
      maxPixels: value.maxPixels,
      detBoxThresh: value.detBoxThresh,
      detBoxScoreThresh: value.detBoxScoreThresh,
    });
  };

  const setFileSource = (
    key: OcrCustomPathKey,
    source: FileSource | undefined
  ) => {
    const next = { ...value.fileSources };
    if (source) {
      next[key] = source;
    } else {
      delete next[key];
    }
    onChange({ ...value, fileSources: next });
  };

  return (
    <View style={styles.container}>
      <Text style={styles.subheading}>OCR model type</Text>
      <View style={styles.typeRow}>
        {OCR_CONCRETE_TYPES.map((type) => {
          const active = value.modelType === type;
          return (
            <TouchableOpacity
              key={type}
              style={[styles.typeChip, active && styles.typeChipActive]}
              onPress={() => setModelType(type)}
              disabled={disabled || fillLoading}
            >
              <Text
                style={[
                  styles.typeChipText,
                  active && styles.typeChipTextActive,
                ]}
              >
                {type}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={styles.helperRow}>
        <TouchableOpacity
          style={[
            styles.helperButton,
            (!selectedCatalogModelId || fillLoading || disabled) &&
              styles.helperButtonDisabled,
          ]}
          onPress={onFillFromSelectedModel}
          disabled={!selectedCatalogModelId || fillLoading || disabled}
        >
          {fillLoading ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={styles.helperButtonText}>
              Fill from selected model
            </Text>
          )}
        </TouchableOpacity>
        {showScatteredTest ? (
          <TouchableOpacity
            style={[
              styles.helperButtonSecondary,
              disabled && styles.helperButtonDisabled,
            ]}
            onPress={onPrepareScatteredTest}
            disabled={disabled || fillLoading}
          >
            <Text style={styles.helperButtonSecondaryText}>
              Scattered test (clear slots)
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {fillHint ? <Text style={styles.fillHint}>{fillHint}</Text> : null}

      <Text style={styles.subheading}>Model files</Text>
      <Text style={styles.hint}>
        Required and optional slots come from native ValidateOcrPaths for the
        selected family. Use Fill to pre-populate from the catalog selection.
      </Text>

      {schemaLoading ? (
        <ActivityIndicator
          size="small"
          color="#5856D6"
          style={styles.schemaLoader}
        />
      ) : null}

      {slotKeys.map(({ key, required }) => (
        <FileSourceSlotPicker
          key={key}
          label={PATH_LABELS[key] ?? key}
          value={value.fileSources[key]}
          onChange={(source) => setFileSource(key, source)}
          disabled={disabled || fillLoading}
          required={required}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 4,
  },
  subheading: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
    marginTop: 8,
    marginBottom: 6,
  },
  hint: {
    fontSize: 12,
    color: '#6B7280',
    marginBottom: 8,
    lineHeight: 17,
  },
  typeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingBottom: 4,
  },
  typeChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  typeChipActive: {
    backgroundColor: '#EEF4FF',
    borderColor: '#93C5FD',
  },
  typeChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
  },
  typeChipTextActive: {
    color: '#1D4ED8',
  },
  helperRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
    marginBottom: 4,
  },
  helperButton: {
    backgroundColor: '#0F62FE',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minWidth: 140,
    alignItems: 'center',
  },
  helperButtonSecondary: {
    backgroundColor: '#F3F4F6',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  helperButtonDisabled: {
    opacity: 0.45,
  },
  helperButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 13,
  },
  helperButtonSecondaryText: {
    color: '#111827',
    fontWeight: '600',
    fontSize: 13,
  },
  fillHint: {
    fontSize: 12,
    color: '#4B5563',
    marginTop: 4,
    marginBottom: 4,
    lineHeight: 17,
  },
  schemaLoader: {
    marginVertical: 8,
  },
});
