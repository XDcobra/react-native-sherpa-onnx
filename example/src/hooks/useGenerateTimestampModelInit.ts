import { useCallback } from 'react';
import type { AlignmentGranularity } from 'react-native-sherpa-onnx/alignment';
import { useAlignmentModelInit } from './useAlignmentModelInit';
import { useGenerateTimestampSttModelInit } from './useGenerateTimestampSttModelInit';
import { useGenerateTimestampVadPrep } from './useGenerateTimestampVadPrep';

export type GenerateTimestampModeRequirements = {
  requiresAlignmentModel: boolean;
  requiresVadModel: boolean;
  requiresSttModel: boolean;
  requiresEstimatedChunks: boolean;
  allowedGranularities: AlignmentGranularity[];
  granularityHint: string;
};

export type UseGenerateTimestampModelInitOptions = {
  onBeforeInit?: () => void | Promise<void>;
};

export function useGenerateTimestampModelInit(
  options: UseGenerateTimestampModelInitOptions = {}
) {
  const alignment = useAlignmentModelInit(options);
  const vad = useGenerateTimestampVadPrep();
  const stt = useGenerateTimestampSttModelInit(options);

  const collectRunBlockingIssues = useCallback(
    (params: {
      modeRequirements: GenerateTimestampModeRequirements;
      granularity: AlignmentGranularity;
      hasAudio: boolean;
      hasReferenceText: boolean;
      estimatedTimelineError: string | null;
    }): string[] => {
      const issues: string[] = [];
      const {
        modeRequirements,
        granularity,
        hasAudio,
        hasReferenceText,
        estimatedTimelineError,
      } = params;

      if (!hasAudio) {
        issues.push('Select an audio file.');
      }
      if (!hasReferenceText) {
        issues.push('Enter a reference transcript.');
      }
      if (!modeRequirements.allowedGranularities.includes(granularity)) {
        issues.push(modeRequirements.granularityHint);
      }
      if (modeRequirements.requiresEstimatedChunks && estimatedTimelineError) {
        issues.push(estimatedTimelineError);
      }
      if (modeRequirements.requiresAlignmentModel && !alignment.isPrepared) {
        if (alignment.initMode === 'auto') {
          issues.push('Prepare the selected alignment model with Use model.');
        } else {
          issues.push('Set the custom alignment model path (model slot).');
        }
      }
      if (modeRequirements.requiresVadModel && !vad.isPrepared) {
        issues.push('Prepare the selected VAD model with Use model.');
      }
      if (modeRequirements.requiresSttModel && !stt.isPrepared) {
        issues.push('Prepare the selected STT model with Use model.');
      }
      return issues;
    },
    [alignment.initMode, alignment.isPrepared, stt.isPrepared, vad.isPrepared]
  );

  return {
    alignment,
    vad,
    stt,
    collectRunBlockingIssues,
  };
}

export type UseGenerateTimestampModelInitReturn = ReturnType<
  typeof useGenerateTimestampModelInit
>;
