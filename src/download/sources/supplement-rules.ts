import { ModelCategory } from '../types';

/**
 * A file a model needs that its pack does not ship. The source publishes it as a
 * separate asset of the same release; the download puts it into the model directory.
 */
export type SupplementRule = {
  category: ModelCategory;
  /** Release asset name, also the file name inside the model directory. */
  fileName: string;
  /** Model ids (asset name without extension) that need the file. */
  modelIds: ReadonlyArray<RegExp>;
};

/**
 * Upstream text frontends read words only through lexicon files since espeak-ng was
 * removed, and a word that is in no loaded lexicon is skipped. These packs ship no
 * English lexicon (the distilled ZipVoice zh-en packs ship only a Chinese one).
 * Upstream's examples download `lexicon-en-us.txt` from the `tts-models` release next
 * to each of them.
 *
 * The full (not distilled) ZipVoice zh-en pack ships no Chinese `lexicon.txt` either,
 * and no release asset can stand in for it: `lexicon-zh-g2pw.txt` spells pinyin with
 * other tokens (`zh ong 1 _`, ZipVoice uses `zh0 ong1`). The caller has to place the
 * distilled pack's `lexicon.txt` there itself.
 */
export const SUPPLEMENT_RULES: ReadonlyArray<SupplementRule> = [
  {
    category: ModelCategory.Tts,
    fileName: 'lexicon-en-us.txt',
    modelIds: [
      /^sherpa-onnx-zipvoice-(?:.*-)?zh-en(?:-|$)/i,
      /^kokoro-(?:int8-)?en-v/i,
      /^kitten-[a-z]+-en-/i,
      /^matcha-icefall-en_us-/i,
      /^vits-piper-en_(?:us|gb)-/i,
    ],
  },
];

/** File names the rules add to `modelId` in `category` (empty when none apply). */
export function getSupplementFileNames(
  category: ModelCategory,
  modelId: string,
  rules: ReadonlyArray<SupplementRule> = SUPPLEMENT_RULES
): string[] {
  const names: string[] = [];
  for (const rule of rules) {
    if (rule.category !== category) continue;
    if (!rule.modelIds.some((pattern) => pattern.test(modelId))) continue;
    if (!names.includes(rule.fileName)) names.push(rule.fileName);
  }
  return names;
}
