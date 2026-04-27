/**
 * Phase 1a Segmentation Contract: cross-domain linkage types.
 *
 * SegmentLink connects text and speech segments and is feature-agnostic
 * (alignment, TTS tracking, STT attribution, subtitle timing, etc.).
 */

export type SegmentLinkType =
  | 'alignment'
  | 'proportional'
  | 'vad_assisted'
  | 'sequential'
  | 'tts_produced'
  | 'stt_produced'
  | 'user_defined';

export interface SegmentLink {
  linkId: string;
  textSegmentId: string;
  speechSegmentId: string;
  linkType: SegmentLinkType;
  confidence?: number;
  meta?: Record<string, unknown>;
}

/**
 * Handle-only contract for native-held link maps.
 * Phase 1a intentionally defines types only; runtime APIs arrive in later phases.
 */
export interface SegmentLinkMapRef {
  linkMapId: string;
}

export interface SegmentLinkMapInfo {
  linkMapId: string;
  linkCount: number;
  textBufferId?: string;
  audioBufferId?: string;
}
