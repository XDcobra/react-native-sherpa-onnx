import type { FileSource } from '../fileio/types';
import type {
  StreamingPipelineCompletion,
  StreamingPipelineStatus,
} from '../audiobuffer/streamingPipelineTypes';
import type { LiveTextBufferIdSource } from '../textbuffer/types';
import type { SegmentationPolicy } from '../segment/engine-types';
import type { PunctuationModelType } from './detect';
import type { TextInputNormalization } from './textInputNormalization';

export type OnlinePunctuationModelType = Extract<
  PunctuationModelType,
  'cnn_bilstm' | 'auto'
>;

export type StreamingPunctuationConcreteModelType = 'cnn_bilstm';

export type StreamingPunctuationInitOptionsShared = {
  numThreads?: number;
  provider?: string;
  debug?: boolean;
};

export type StreamingPunctuationAutoInitializeOptions =
  StreamingPunctuationInitOptionsShared & {
    initMode?: 'auto';
    /** OnlinePunctuation layout (CNN-BiLSTM + bpe.vocab). */
    modelSource: FileSource;
    modelType?: OnlinePunctuationModelType;
  };

export type StreamingPunctuationCustomInitializeOptions =
  StreamingPunctuationInitOptionsShared & {
    initMode: 'custom';
    modelType: StreamingPunctuationConcreteModelType;
    customConfig: import('./customConfig').StreamingPunctuationCustomConfig;
  };

export type StreamingPunctuationInitializeOptions =
  | StreamingPunctuationAutoInitializeOptions
  | StreamingPunctuationCustomInitializeOptions;

export type StreamingPunctuationOptions = {
  /**
   * Applied to each committed input segment before `OnlinePunctuation` inference.
   * Default: `'lower'` (recommended for ASR uppercase output).
   */
  textInputNormalization?: TextInputNormalization;
  segmentation?: {
    mode?: 'off' | 'manual' | 'auto';
    policy?: SegmentationPolicy;
  };
};

export type PunctuationPipelineHandle = {
  readonly instanceId: string;
  readonly pipelineId: string;
  readonly completed: Promise<StreamingPipelineCompletion>;
  stop(): Promise<void>;
  /**
   * Drain any remaining **input** segments through the worker (native queue).
   * Call **after** `finalizeLiveTextBuffer` on the live **input** buffer so no
   * further segments can appear; then `stop()` and `completed` as in the
   * streaming punctuation doc (`docs/punctuation-streaming.md`). Flushing only
   * the pipeline while the input is still `recording` does not replace
   * finalizing the input — you may need another `flush()` after more commits.
   */
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
