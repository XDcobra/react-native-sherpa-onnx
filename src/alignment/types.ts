export interface AlignmentTimestamp {
  text: string;
  start: number;
  end: number;
}

export interface AlignmentResult {
  words: AlignmentTimestamp[];
  chars: AlignmentTimestamp[];
}

export type AlignmentModelType = 'wav2vec2' | 'auto';

export interface AlignmentDetectResult {
  success: boolean;
  error?: string;
  detectedModels: Array<{ type: string; modelDir: string }>;
  modelType?: string;
  paths?: {
    model?: string;
  };
}
