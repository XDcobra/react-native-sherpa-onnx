export type RootStackParamList = {
  Home: undefined;
  STT: undefined;
  TTS: undefined;
  STTStreaming: undefined;
  TTSStreaming: undefined;
  Punctuation: undefined;
  PunctuationStreaming: undefined;
  OfflinePipelineShowcase: undefined;
  LivePipelineShowcase: undefined;
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
  AudioVisualization: undefined;
};

export type FeatureId =
  | 'stt'
  | 'tts'
  | 'stt_streaming'
  | 'tts_streaming'
  | 'punctuation'
  | 'punctuation_streaming'
  | 'offline_pipeline_showcase'
  | 'live_pipeline_showcase'
  | 'generate_timestamp'
  | 'download_showcase'
  | 'vad'
  | 'segmentation_showcase'
  | 'diarization'
  | 'enhancement'
  | 'enhancement_streaming'
  | 'separation'
  | 'fileio'
  | 'audio_visualization';

export interface Feature {
  id: FeatureId;
  title: string;
  description: string;
  icon: string;
  screen: keyof RootStackParamList;
  implemented: boolean;
}
