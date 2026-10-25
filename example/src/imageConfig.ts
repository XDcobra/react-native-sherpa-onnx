/**
 * Configuration for test images used by the OCR example screen.
 * Images should be placed in:
 * - Android: example/android/app/src/main/assets/test_images/
 * - iOS: example/ios/sherpa_models/test_images/ (copied into the app bundle at build time)
 */

export const TEST_IMAGE_FILES = {
  EN_HELLO: 'test_images/en_hello.png',
  DE_GUTEN_TAG: 'test_images/de_guten_tag.png',
  ZH_NIHAO: 'test_images/zh_nihao.png',
  PAGE_MULTILINE: 'test_images/page_multiline.png',
  /** Synthetic id — loads EN/DE/ZH goldens as three OfflineImageBuffer frames. */
  MULTI_FRAME_PAGES: 'test_images/multi_frame_pages',
} as const;

export type ImageFileId =
  (typeof TEST_IMAGE_FILES)[keyof typeof TEST_IMAGE_FILES];

export type ImageFileInfo = {
  id: ImageFileId;
  name: string;
  description: string;
  /** Optional group header in the example image list. */
  section?: string;
  /**
   * When set, `createOfflineImageBufferFromFiles` loads these asset paths as
   * separate frames (multi-frame slide viewer). `id` is only the list key.
   */
  framePaths?: ImageFileId[];
};

export const IMAGE_FILES: ImageFileInfo[] = [
  {
    id: TEST_IMAGE_FILES.EN_HELLO,
    name: 'English — Hello',
    description: 'Single-line English golden (en_hello)',
    section: 'Single line',
  },
  {
    id: TEST_IMAGE_FILES.DE_GUTEN_TAG,
    name: 'German — Guten Tag',
    description: 'Single-line German golden (de_guten_tag)',
    section: 'Single line',
  },
  {
    id: TEST_IMAGE_FILES.ZH_NIHAO,
    name: 'Chinese — Ni Hao',
    description: 'Single-line Chinese golden (zh_nihao)',
    section: 'Single line',
  },
  {
    id: TEST_IMAGE_FILES.PAGE_MULTILINE,
    name: 'Multi-line page',
    description: 'Denser page for box overlays and DocTags',
    section: 'Page',
  },
  {
    id: TEST_IMAGE_FILES.MULTI_FRAME_PAGES,
    name: 'Multi-frame — 3 pages',
    description:
      'EN + DE + ZH goldens as three frames → FramePager (immutable; no image lazy-lru yet)',
    section: 'Multi-frame',
    framePaths: [
      TEST_IMAGE_FILES.EN_HELLO,
      TEST_IMAGE_FILES.DE_GUTEN_TAG,
      TEST_IMAGE_FILES.ZH_NIHAO,
    ],
  },
];
