import type { FileSource } from '../fileio/types';
import type { StreamingPipelineStatus } from '../audiobuffer/streamingPipelineTypes';
import type { LiveTextBufferIdSource } from '../textbuffer/types';
import type { SegmentationPolicy } from '../segment/engine-types';
import type { PunctuationModelType } from './detect';

export type OnlinePunctuationModelType = Extract<
  PunctuationModelType,
  'cnn_bilstm' | 'auto'
>;

export type StreamingPunctuationInitializeOptions = {
  /** OnlinePunctuation layout (CNN-BiLSTM + bpe.vocab). */
  modelSource: FileSource;
  modelType?: OnlinePunctuationModelType;
  numThreads?: number;
  provider?: string;
  debug?: boolean;
};

export type StreamingPunctuationOptions = {
  segmentation?: {
    mode?: 'off' | 'manual' | 'auto';
    policy?: SegmentationPolicy;
  };
};

export type PunctuationPipelineHandle = {
  readonly instanceId: string;
  readonly pipelineId: string;
  readonly completed: Promise<void>;
  stop(): Promise<void>;
  flush(): Promise<void>;
  reset(): Promise<void>;
  getStatus(): Promise<StreamingPipelineStatus>;
};

export type StreamingPunctuationEngine = {
  readonly instanceId: string;
  punctuate(
    textIn: LiveTextBufferIdSource,
    textOut: LiveTextBufferIdSource,
    options?: StreamingPunctuationOptions
  ): Promise<PunctuationPipelineHandle>;
  destroy(): Promise<void>;
};
