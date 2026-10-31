/**
 * Configuration for test videos used by the Video Preview example screen.
 * Videos should be placed in:
 * - Android: example/android/app/src/main/assets/test_videos/
 * - iOS: example/ios/sherpa_models/test_videos/ (copied into the app bundle at build time)
 */

export const TEST_VIDEO_FILES = {
  PREVIEW_H264_AAC: 'test_videos/preview_h264_aac.mp4',
  OCR_SUBTITLES_H264_AAC: 'test_videos/ocr_subtitles_h264_aac.mp4',
} as const;

/** 1 s / 144p File I/O codec samples (H.264; AAC in mp4/mov, Opus in mkv/webm). */
export const TEST_VIDEO_CODEC_FILES = {
  mp4: 'test_videos/sample.mp4',
  mov: 'test_videos/sample.mov',
  mkv: 'test_videos/sample.mkv',
  webm: 'test_videos/sample.webm',
} as const;

export type VideoCodecSampleFormat = keyof typeof TEST_VIDEO_CODEC_FILES;

export const VIDEO_CODEC_ASSET_ENTRIES: {
  format: VideoCodecSampleFormat;
  label: string;
}[] = [
  { format: 'mp4', label: 'MP4' },
  { format: 'mov', label: 'MOV' },
  { format: 'mkv', label: 'MKV' },
  { format: 'webm', label: 'WebM' },
];

export type VideoFileId =
  (typeof TEST_VIDEO_FILES)[keyof typeof TEST_VIDEO_FILES];

export type VideoFileInfo = {
  id: VideoFileId;
  name: string;
  description: string;
};

export const VIDEO_FILES: VideoFileInfo[] = [
  {
    id: TEST_VIDEO_FILES.PREVIEW_H264_AAC,
    name: 'Preview — H.264 + AAC',
    description:
      '8 s 640×360 testsrc2 pattern with a 440 Hz tone. Hardware-decodable Baseline H.264 + AAC.',
  },
  {
    id: TEST_VIDEO_FILES.OCR_SUBTITLES_H264_AAC,
    name: 'OCR subtitles — H.264 + AAC',
    description:
      '8 s 640×360 burned-in captions (HELLO WORLD / OPEN SOURCE / SPEECH TO TEXT / VIDEO TO OCR). Hardware-decodable Baseline H.264 + AAC.',
  },
];
