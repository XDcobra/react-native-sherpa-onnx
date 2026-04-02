export interface DownloadAlignmentModelOptions {
  /**
   * Optional custom model URL.
   *
   * @default Hugging Face wav2vec2-base-960h int8 ONNX URL
   */
  url?: string;

  /**
   * Progress callback from the underlying file download.
   */
  onProgress?: (progress: {
    bytesWritten: number;
    contentLength: number;
  }) => void;
}

export interface AlignmentTimestamp {
  text: string;
  start: number;
  end: number;
}

export interface AlignmentResult {
  words: AlignmentTimestamp[];
  chars: AlignmentTimestamp[];
}
