export type RootStackParamList = {
  Home: undefined;
  STT: undefined;
  TTS: undefined;
  STTStreaming: undefined;
  TTSStreaming: undefined;
  Punctuation: undefined;
  PunctuationStreaming: undefined;
  PipelineShowcase: undefined;
  GenerateTimestamp: undefined;
  DownloadShowcase: undefined;
  VAD: undefined;
  SegmentationShowcase: undefined;
  Diarization: undefined;
  Enhancement: undefined;
  EnhancementStreaming: undefined;
  Separation: undefined;
  Settings: undefined;
  FileIO: undefined;
};

export type FeatureId =
  | 'stt'
  | 'tts'
  | 'stt_streaming'
  | 'tts_streaming'
  | 'punctuation'
  | 'punctuation_streaming'
  | 'pipeline_showcase'
  | 'generate_timestamp'
  | 'download_showcase'
  | 'vad'
  | 'segmentation_showcase'
  | 'diarization'
  | 'enhancement'
  | 'enhancement_streaming'
  | 'separation'
  | 'fileio';

export interface Feature {
  id: FeatureId;
  title: string;
  description: string;
  icon: string;
  screen: keyof RootStackParamList;
  implemented: boolean;
}
