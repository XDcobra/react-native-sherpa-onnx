import type { FileSource } from '../fileio/types';
import { ModelCategory } from '../download/types';
import {
  assertCustomModelConfig,
  resolveCustomModelConfigPaths,
} from '../detect/customConfigResolver';
import type { OcrConcreteModelType } from './types';
import { OcrErrorCode } from './types';

/** Keys accepted by native `GetOcrPathRequirements` / ValidateOcrPaths. */
export type OcrCustomPathKey =
  | 'det'
  | 'rec'
  | 'cls'
  | 'rec_dict'
  | 'manifest'
  | 'vision_encoder'
  | 'vision_encoder_data'
  | 'embed_tokens'
  | 'embed_tokens_data'
  | 'embedding'
  | 'embedding_data'
  | 'decoder'
  | 'decoder_data'
  | 'tokenizer'
  | 'patch_embed'
  | 'patch_embed_data'
  | 'pos_embed';

export type OcrPpocrCustomConfig = {
  det: FileSource;
  rec: FileSource;
  rec_dict: FileSource;
  cls?: FileSource;
};

export type OcrDoctrCustomConfig = {
  det: FileSource;
  rec: FileSource;
  manifest: FileSource;
  cls?: FileSource;
  rec_dict?: FileSource;
};

export type OcrDocVlmCustomConfig = {
  vision_encoder: FileSource;
  vision_encoder_data: FileSource;
  embed_tokens: FileSource;
  embed_tokens_data: FileSource;
  decoder: FileSource;
  decoder_data: FileSource;
  tokenizer: FileSource;
  manifest: FileSource;
};

export type OcrNemotronParseCustomConfig = OcrDocVlmCustomConfig & {
  patch_embed: FileSource;
  pos_embed: FileSource;
  patch_embed_data?: FileSource;
};

export type OcrPaddleocrVlCustomConfig = {
  vision_encoder: FileSource;
  embedding: FileSource;
  decoder: FileSource;
  tokenizer: FileSource;
  vision_encoder_data?: FileSource;
  embedding_data?: FileSource;
  decoder_data?: FileSource;
  manifest?: FileSource;
};

export type OcrCustomConfigByModelType = {
  ppocr: OcrPpocrCustomConfig;
  doctr: OcrDoctrCustomConfig;
  doc_vlm: OcrDocVlmCustomConfig;
  nemotron_parse: OcrNemotronParseCustomConfig;
  paddleocr_vl: OcrPaddleocrVlCustomConfig;
};

export type OcrCustomConfig = OcrCustomConfigByModelType[OcrConcreteModelType];

export function assertOcrCustomConfig(
  customConfig: Record<string, unknown>
): void {
  assertCustomModelConfig(customConfig, OcrErrorCode.INVALID_ARGUMENT);
}

export async function resolveOcrCustomConfigPaths(
  modelType: OcrConcreteModelType,
  customConfig: OcrCustomConfig
): Promise<Record<string, string>> {
  return resolveCustomModelConfigPaths({
    category: ModelCategory.Ocr,
    modelType,
    customConfig: customConfig as unknown as Record<string, unknown>,
    errorCode: OcrErrorCode.INVALID_ARGUMENT,
    unknownKeyMessage: (key, mt) =>
      `Unknown customConfig key '${key}' for OCR modelType '${mt}'`,
  });
}
