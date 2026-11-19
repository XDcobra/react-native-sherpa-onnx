import {
  codegenNativeCommands,
  codegenNativeComponent,
  type CodegenTypes,
  type ColorValue,
  type HostComponent,
  type ViewProps,
} from 'react-native';
import type * as React from 'react';

type InsertSpec = Readonly<{
  key: string;
  /** `sectionEnd` | `beforeBlock` | `afterBlock`. */
  kind: string;
  /** Section ID or block ID, depending on `kind`. */
  target: string;
}>;

type HighlightSpec = Readonly<{
  id: string;
  fromBlockId: string;
  /** -1: start of the block. */
  fromOffset: CodegenTypes.Int32;
  toBlockId: string;
  /** Exclusive; -1: end of the block. */
  toOffset: CodegenTypes.Int32;
  /** `background` | `underline` | `textColor`. */
  style: string;
  /** ARGB as a signed 32-bit int (processColor); ignored unless `hasColor`. */
  color: CodegenTypes.Int32;
  hasColor: boolean;
  follow: boolean;
}>;

type MarkerSpec = Readonly<{
  id: string;
  blockId: string;
  /** -1 with `end` -1: a marker for the whole block. */
  start: CodegenTypes.Int32;
  /** Exclusive; -1: see `start`. */
  end: CodegenTypes.Int32;
}>;

type SelectionMenuItemSpec = Readonly<{
  id: string;
  title: string;
  /** SF Symbol name (iOS); "" = none. */
  systemImage: string;
}>;

type SelectionActionEvent = Readonly<{
  itemId: string;
  blockId: string;
  start: CodegenTypes.Int32;
  end: CodegenTypes.Int32;
  text: string;
  sentenceStart: CodegenTypes.Int32;
  sentenceEnd: CodegenTypes.Int32;
}>;

type MarkerWindowEvent = Readonly<{
  /** Markers of the rows in and around the visible range (top to bottom). */
  markerIds: string[];
}>;

type MarkerTapEvent = Readonly<{
  markerId: string;
}>;

type FollowChangeEvent = Readonly<{
  following: boolean;
  reason: string;
}>;

type ReadyEvent = Readonly<{
  blockCount: CodegenTypes.Int32;
  sectionCount: CodegenTypes.Int32;
}>;

type VisibleRangeEvent = Readonly<{
  firstSectionId: string;
  firstBlockId: string;
  lastSectionId: string;
  lastBlockId: string;
  firstOffset: CodegenTypes.Int32;
  settled: boolean;
  visibleInsertKeys: string[];
}>;

type LocatorEvent = Readonly<{
  sectionId: string;
  blockId: string;
  offset: CodegenTypes.Int32;
}>;

type SectionEndEvent = Readonly<{
  sectionId: string;
  blockId: string;
}>;

type JumpEvent = Readonly<{
  fromSectionId: string;
  fromBlockId: string;
  toSectionId: string;
  toBlockId: string;
  distance: CodegenTypes.Int32;
  cause: string;
}>;

type TapEvent = Readonly<{
  blockId: string;
  /** UTF-16 offset in the block's text; -1 on rows without text. */
  offset: CodegenTypes.Int32;
}>;

type ErrorEvent = Readonly<{
  code: string;
  message: string;
}>;

export interface NativeProps extends ViewProps {
  documentId?: CodegenTypes.WithDefault<string, ''>;
  documentRevision?: CodegenTypes.WithDefault<CodegenTypes.Int32, 0>;
  initialSectionId?: CodegenTypes.WithDefault<string, ''>;
  initialBlockId?: CodegenTypes.WithDefault<string, ''>;
  initialOffset?: CodegenTypes.WithDefault<CodegenTypes.Int32, -1>;
  furthestBlockId?: CodegenTypes.WithDefault<string, ''>;
  /** Bumped by JS whenever the app sets a new frontier. */
  furthestRevision?: CodegenTypes.WithDefault<CodegenTypes.Int32, 0>;
  fontFamily?: CodegenTypes.WithDefault<string, ''>;
  fontSize?: CodegenTypes.WithDefault<CodegenTypes.Float, 18>;
  /** -1 = follow the system font scale. */
  fontScale?: CodegenTypes.WithDefault<CodegenTypes.Float, -1>;
  maxFontScale?: CodegenTypes.WithDefault<CodegenTypes.Float, 0>;
  lineHeight?: CodegenTypes.WithDefault<CodegenTypes.Float, 1.5>;
  paragraphSpacing?: CodegenTypes.WithDefault<CodegenTypes.Float, 0.75>;
  // Not `marginHorizontal` / `marginVertical`: Fabric would also read those
  // as Yoga layout margins of the view itself.
  readerMarginHorizontal?: CodegenTypes.WithDefault<CodegenTypes.Float, 20>;
  readerMarginVertical?: CodegenTypes.WithDefault<CodegenTypes.Float, 24>;
  textAlign?: CodegenTypes.WithDefault<string, 'start'>;
  hyphenation?: CodegenTypes.WithDefault<boolean, true>;
  textColor?: ColorValue;
  accentColor?: ColorValue;
  inserts?: ReadonlyArray<InsertSpec>;
  jumpThreshold?: CodegenTypes.WithDefault<CodegenTypes.Int32, 20>;
  highlights?: ReadonlyArray<HighlightSpec>;
  /** `keepVisible` | `center` | `off`. */
  followMode?: CodegenTypes.WithDefault<string, 'keepVisible'>;
  followAnchor?: CodegenTypes.WithDefault<CodegenTypes.Float, 0.3>;
  followPauseOnUserScroll?: CodegenTypes.WithDefault<boolean, true>;
  /** `text` | `image` | `imageAndText` (`auto` is resolved in ReaderView). */
  pageDisplay?: CodegenTypes.WithDefault<string, 'text'>;
  selectable?: CodegenTypes.WithDefault<boolean, false>;
  /** `none` | `sentence` | `block`. */
  selectionSnap?: CodegenTypes.WithDefault<string, 'none'>;
  selectionMenuItems?: ReadonlyArray<SelectionMenuItemSpec>;
  markers?: ReadonlyArray<MarkerSpec>;
  /** Spike/testing only: placeholder rows when there is no document. */
  debugRowCount?: CodegenTypes.WithDefault<CodegenTypes.Int32, 0>;
  onReaderReady?: CodegenTypes.DirectEventHandler<ReadyEvent>;
  onVisibleRangeChange?: CodegenTypes.DirectEventHandler<VisibleRangeEvent>;
  onFurthestPositionChange?: CodegenTypes.DirectEventHandler<LocatorEvent>;
  onSectionEnd?: CodegenTypes.DirectEventHandler<SectionEndEvent>;
  onJump?: CodegenTypes.DirectEventHandler<JumpEvent>;
  onReaderTap?: CodegenTypes.DirectEventHandler<TapEvent>;
  onReaderError?: CodegenTypes.DirectEventHandler<ErrorEvent>;
  onFollowChange?: CodegenTypes.DirectEventHandler<FollowChangeEvent>;
  onSelectionAction?: CodegenTypes.DirectEventHandler<SelectionActionEvent>;
  /** The markers whose views JS should mount changed. */
  onMarkerWindowChange?: CodegenTypes.DirectEventHandler<MarkerWindowEvent>;
  /**
   * iOS: a tap on selectable text inside a marker's hit area (the text keeps
   * the touch for a long press, so the marker view does not get it).
   */
  onMarkerTap?: CodegenTypes.DirectEventHandler<MarkerTapEvent>;
}

type ComponentType = HostComponent<NativeProps>;

interface NativeCommands {
  scrollToLocator: (
    viewRef: React.ElementRef<ComponentType>,
    sectionId: string,
    blockId: string,
    offset: CodegenTypes.Int32,
    animated: boolean
  ) => void;
  resumeFollow: (viewRef: React.ElementRef<ComponentType>) => void;
}

export const Commands: NativeCommands = codegenNativeCommands<NativeCommands>({
  supportedCommands: ['scrollToLocator', 'resumeFollow'],
});

export default codegenNativeComponent<NativeProps>(
  'SherpaReaderView'
) as ComponentType;
