import { ModelCategory } from '../../types';
import type { HuggingFaceRepoSpec } from './huggingface';

const DEFAULT_INCLUDE: ReadonlyArray<string | RegExp> = [
  /\.onnx$/i,
  /\btokens\.txt$/i,
  /\bvocab[\w.-]*\.txt$/i,
  /\blexicon[\w.-]*\.txt$/i,
  /\.bin$/i,
  /^config[\w.-]*\.json$/i,
  /^README/i,
  /^LICENSE/i,
];

const DEFAULTS: Partial<Record<ModelCategory, HuggingFaceRepoSpec[]>> = {
  [ModelCategory.Tts]: [],
  [ModelCategory.Stt]: [],
  [ModelCategory.Vad]: [],
  [ModelCategory.Punctuation]: [],
  [ModelCategory.Diarization]: [],
  [ModelCategory.Enhancement]: [],
  [ModelCategory.Separation]: [],
  [ModelCategory.Qnn]: [],
  [ModelCategory.Alignment]: [],
};

export function getDefaultHuggingFaceRepos(
  category: ModelCategory
): HuggingFaceRepoSpec[] {
  const list = DEFAULTS[category] ?? [];
  return list.map((spec) => ({
    includeFiles: DEFAULT_INCLUDE,
    ...spec,
  }));
}
