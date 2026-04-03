export interface DownloadAlignmentModelOptions {
  /**
   * Optional subtitle model ID (from `ModelCategory.Subtitles`).
   *
   * @default wav2vec2-base-960h-int8
   */
  modelId?: string;

  /**
   * @deprecated Custom URL downloads are no longer supported and this value is ignored.
   */
  url?: string;

  /**
   * Optional abort signal for download/extraction.
   */
  signal?: AbortSignal;

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
