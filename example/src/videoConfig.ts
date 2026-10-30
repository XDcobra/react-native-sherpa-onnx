/**
 * Configuration for test videos used by the Video Preview example screen.
 * Videos should be placed in:
 * - Android: example/android/app/src/main/assets/test_videos/
 * - iOS: example/ios/sherpa_models/test_videos/ (copied into the app bundle at build time)
 */

export const TEST_VIDEO_FILES = {
  PREVIEW_H264_AAC: 'test_videos/preview_h264_aac.mp4',
} as const;

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
];
