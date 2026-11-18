import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  type ElementRef,
} from 'react';
import {
  processColor,
  StyleSheet,
  type NativeSyntheticEvent,
} from 'react-native';

import SherpaReaderInsertView from './SherpaReaderInsertViewNativeComponent';
import SherpaReaderView, {
  Commands,
  type NativeProps,
} from './SherpaReaderViewNativeComponent';
import type {
  ReaderHighlight,
  ReaderInsert,
  ReaderJumpCause,
  ReaderLocator,
  ReaderMarker,
  ReaderSelectionMenuItem,
  ReaderTap,
  ReaderViewHandle,
  ReaderViewProps,
} from './types';

type NativeEvent<K extends keyof NativeProps> = NonNullable<
  NativeProps[K]
> extends (e: NativeSyntheticEvent<infer T>) => unknown
  ? T
  : never;

export function insertSpecFor(insert: ReaderInsert): {
  key: string;
  kind: string;
  target: string;
} {
  const at = insert.at;
  if ('sectionEnd' in at) {
    return { key: insert.key, kind: 'sectionEnd', target: at.sectionEnd };
  }
  if ('beforeBlock' in at) {
    return { key: insert.key, kind: 'beforeBlock', target: at.beforeBlock };
  }
  return { key: insert.key, kind: 'afterBlock', target: at.afterBlock };
}

/** ARGB from processColor (unsigned on iOS) as the signed Int32 the prop carries. */
function toInt32(argb: number): number {
  const n = Math.trunc(argb) % 0x100000000;
  return n > 0x7fffffff ? n - 0x100000000 : n;
}

/** Flat native form of a highlight (colors resolved to ARGB ints). */
export function highlightSpecFor(h: ReaderHighlight): {
  id: string;
  fromBlockId: string;
  fromOffset: number;
  toBlockId: string;
  toOffset: number;
  style: string;
  color: number;
  hasColor: boolean;
  follow: boolean;
} {
  const processed = h.color != null ? processColor(h.color) : null;
  const hasColor = typeof processed === 'number';
  return {
    id: h.id,
    fromBlockId: h.from.blockId,
    fromOffset: h.from.offset ?? -1,
    toBlockId: h.to.blockId,
    toOffset: h.to.offset ?? -1,
    style: h.style ?? 'background',
    color: hasColor ? toInt32(processed as number) : 0,
    hasColor,
    follow: h.follow === true,
  };
}

/** A color prop as the native (color, hasColor) pair. */
function colorSpec(c: ReaderMarker['color']): {
  color: number;
  hasColor: boolean;
} {
  const processed = c != null ? processColor(c) : null;
  return typeof processed === 'number'
    ? { color: toInt32(processed), hasColor: true }
    : { color: 0, hasColor: false };
}

/** Flat native form of a margin marker (-1 = no range; colors as ARGB ints). */
export function markerSpecFor(m: ReaderMarker): {
  id: string;
  blockId: string;
  start: number;
  end: number;
  label: string;
  accessibilityLabel: string;
  color: number;
  hasColor: boolean;
  textColor: number;
  hasTextColor: boolean;
} {
  const fill = colorSpec(m.color);
  const text = colorSpec(m.textColor);
  const start = m.start != null && m.start >= 0 ? Math.trunc(m.start) : -1;
  const end = m.end != null && m.end >= 0 ? Math.trunc(m.end) : -1;
  return {
    id: m.id,
    blockId: m.blockId,
    start,
    end,
    label: m.label,
    accessibilityLabel: m.accessibilityLabel ?? '',
    color: fill.color,
    hasColor: fill.hasColor,
    textColor: text.color,
    hasTextColor: text.hasColor,
  };
}

/** Flat native form of a selection menu item. */
export function selectionMenuItemSpecFor(item: ReaderSelectionMenuItem): {
  id: string;
  title: string;
  systemImage: string;
} {
  return {
    id: item.id,
    title: item.title,
    systemImage: item.systemImage ?? '',
  };
}

/** `onTap` payload from the native event (`offset` -1: a row without text). */
export function tapFromNative(n: {
  blockId: string;
  offset: number;
}): ReaderTap {
  return n.offset >= 0
    ? { blockId: n.blockId, offset: n.offset }
    : { blockId: n.blockId };
}

function locator(
  sectionId: string,
  blockId: string,
  offset?: number
): ReaderLocator {
  return offset != null && offset >= 0
    ? { sectionId, blockId, offset }
    : { sectionId, blockId };
}

/**
 * Native, virtualized reader (Fabric only). Inserts are rendered as React
 * children and placed into the reading flow by the native list.
 */
export const ReaderView = forwardRef<ReaderViewHandle, ReaderViewProps>(
  function ReaderView(props, ref) {
    const {
      document,
      initialLocator,
      furthestLocator,
      theme,
      inserts,
      renderInsert,
      jumpThreshold,
      highlights,
      follow,
      pageDisplay,
      selectable,
      selectionSnap,
      selectionMenuItems,
      markers,
      style,
      testID,
      onReady,
      onVisibleRangeChange,
      onFurthestPositionChange,
      onSectionEnd,
      onJump,
      onTap,
      onError,
      onFollowChange,
      onSelectionAction,
      onMarkerPress,
      __debugRowCount,
    } = props;
    const nativeRef = useRef<ElementRef<typeof SherpaReaderView>>(null);

    useImperativeHandle(
      ref,
      () => ({
        scrollTo(target, options) {
          if (!nativeRef.current) return;
          Commands.scrollToLocator(
            nativeRef.current,
            target.sectionId,
            target.blockId,
            target.offset ?? -1,
            options?.animated ?? false
          );
        },
        resumeFollow() {
          if (nativeRef.current) Commands.resumeFollow(nativeRef.current);
        },
      }),
      []
    );

    // The frontier is applied natively only when this revision changes.
    const furthestRevision = useRef(0);
    const lastFurthest = useRef<string | null>(null);
    const furthestKey = furthestLocator?.blockId ?? '';
    if (furthestKey !== lastFurthest.current) {
      lastFurthest.current = furthestKey;
      furthestRevision.current += 1;
    }

    const insertSpecs = useMemo(
      () => (inserts ?? []).map(insertSpecFor),
      [inserts]
    );
    const highlightSpecs = useMemo(
      () => (highlights ?? []).map(highlightSpecFor),
      [highlights]
    );
    const markerSpecs = useMemo(
      () => (markers ?? []).map(markerSpecFor),
      [markers]
    );
    const menuItemSpecs = useMemo(
      () => (selectionMenuItems ?? []).map(selectionMenuItemSpecFor),
      [selectionMenuItems]
    );

    const handleReady = useCallback(
      (e: NativeSyntheticEvent<NativeEvent<'onReaderReady'>>) =>
        onReady?.({
          blockCount: e.nativeEvent.blockCount,
          sectionCount: e.nativeEvent.sectionCount,
        }),
      [onReady]
    );
    const handleVisible = useCallback(
      (e: NativeSyntheticEvent<NativeEvent<'onVisibleRangeChange'>>) => {
        const n = e.nativeEvent;
        onVisibleRangeChange?.({
          first: locator(n.firstSectionId, n.firstBlockId),
          last: locator(n.lastSectionId, n.lastBlockId),
          firstOffset: n.firstOffset,
          settled: n.settled,
          visibleInserts: [...n.visibleInsertKeys],
        });
      },
      [onVisibleRangeChange]
    );
    const handleFurthest = useCallback(
      (e: NativeSyntheticEvent<NativeEvent<'onFurthestPositionChange'>>) =>
        onFurthestPositionChange?.(
          locator(
            e.nativeEvent.sectionId,
            e.nativeEvent.blockId,
            e.nativeEvent.offset
          )
        ),
      [onFurthestPositionChange]
    );
    const handleSectionEnd = useCallback(
      (e: NativeSyntheticEvent<NativeEvent<'onSectionEnd'>>) =>
        onSectionEnd?.({
          sectionId: e.nativeEvent.sectionId,
          blockId: e.nativeEvent.blockId,
        }),
      [onSectionEnd]
    );
    const handleJump = useCallback(
      (e: NativeSyntheticEvent<NativeEvent<'onJump'>>) => {
        const n = e.nativeEvent;
        onJump?.({
          from: locator(n.fromSectionId, n.fromBlockId),
          to: locator(n.toSectionId, n.toBlockId),
          distance: n.distance,
          cause: n.cause as ReaderJumpCause,
        });
      },
      [onJump]
    );
    const handleTap = useCallback(
      (e: NativeSyntheticEvent<NativeEvent<'onReaderTap'>>) =>
        onTap?.(tapFromNative(e.nativeEvent)),
      [onTap]
    );
    const handleSelectionAction = useCallback(
      (e: NativeSyntheticEvent<NativeEvent<'onSelectionAction'>>) => {
        const n = e.nativeEvent;
        onSelectionAction?.({
          itemId: n.itemId,
          blockId: n.blockId,
          start: n.start,
          end: n.end,
          text: n.text,
          sentenceStart: n.sentenceStart,
          sentenceEnd: n.sentenceEnd,
        });
      },
      [onSelectionAction]
    );
    const handleMarkerPress = useCallback(
      (e: NativeSyntheticEvent<NativeEvent<'onMarkerPress'>>) =>
        onMarkerPress?.({
          id: e.nativeEvent.id,
          blockId: e.nativeEvent.blockId,
        }),
      [onMarkerPress]
    );
    const handleError = useCallback(
      (e: NativeSyntheticEvent<NativeEvent<'onReaderError'>>) =>
        onError?.({ code: e.nativeEvent.code, message: e.nativeEvent.message }),
      [onError]
    );

    const handleFollowChange = useCallback(
      (e: NativeSyntheticEvent<NativeEvent<'onFollowChange'>>) =>
        onFollowChange?.({
          following: e.nativeEvent.following,
          reason: e.nativeEvent.reason as 'user' | 'resumed' | 'command',
        }),
      [onFollowChange]
    );

    // `auto`: page images for page documents (comics), text for everything else.
    const resolvedPageDisplay =
      pageDisplay && pageDisplay !== 'auto'
        ? pageDisplay
        : document?.format === 'pages'
        ? 'image'
        : 'text';

    const fontScale =
      theme?.fontScale == null || theme.fontScale === 'system'
        ? -1
        : theme.fontScale;

    return (
      <SherpaReaderView
        ref={nativeRef}
        style={[
          styles.reader,
          theme?.colors?.background != null && {
            backgroundColor: theme.colors.background,
          },
          style,
        ]}
        testID={testID}
        documentId={document?.id ?? ''}
        documentRevision={document?.revision ?? 0}
        initialSectionId={initialLocator?.sectionId ?? ''}
        initialBlockId={initialLocator?.blockId ?? ''}
        initialOffset={initialLocator?.offset ?? -1}
        furthestBlockId={furthestKey}
        furthestRevision={furthestRevision.current}
        fontFamily={theme?.fontFamily ?? ''}
        fontSize={theme?.fontSize ?? 18}
        fontScale={fontScale}
        maxFontScale={theme?.maxFontScale ?? 0}
        lineHeight={theme?.lineHeight ?? 1.5}
        paragraphSpacing={theme?.paragraphSpacing ?? 0.75}
        readerMarginHorizontal={theme?.margins?.horizontal ?? 20}
        readerMarginVertical={theme?.margins?.vertical ?? 24}
        textAlign={theme?.textAlign ?? 'start'}
        hyphenation={theme?.hyphenation ?? true}
        textColor={theme?.colors?.text}
        accentColor={theme?.colors?.accent}
        inserts={insertSpecs}
        jumpThreshold={jumpThreshold ?? 20}
        highlights={highlightSpecs}
        followMode={follow?.mode ?? 'keepVisible'}
        followAnchor={Math.min(1, Math.max(0, follow?.anchor ?? 0.3))}
        followPauseOnUserScroll={follow?.pauseOnUserScroll ?? true}
        pageDisplay={resolvedPageDisplay}
        selectable={selectable ?? false}
        selectionSnap={selectionSnap ?? 'none'}
        selectionMenuItems={menuItemSpecs}
        markers={markerSpecs}
        debugRowCount={__debugRowCount ?? 0}
        onReaderReady={handleReady}
        onVisibleRangeChange={handleVisible}
        onFurthestPositionChange={handleFurthest}
        onSectionEnd={handleSectionEnd}
        onJump={handleJump}
        onReaderTap={handleTap}
        onReaderError={handleError}
        onFollowChange={handleFollowChange}
        onSelectionAction={handleSelectionAction}
        onMarkerPress={handleMarkerPress}
      >
        {renderInsert
          ? insertSpecs.map((spec) => (
              <SherpaReaderInsertView
                key={spec.key}
                insertKey={spec.key}
                collapsable={false}
                style={styles.insertHost}
              >
                {renderInsert(spec.key)}
              </SherpaReaderInsertView>
            ))
          : null}
      </SherpaReaderView>
    );
  }
);

const styles = StyleSheet.create({
  reader: { flex: 1, overflow: 'hidden' },
  // Laid out by Yoga at full reader width; the native list moves the host
  // into its row, so its on-screen position comes from the list.
  insertHost: { position: 'absolute', top: 0, left: 0, right: 0 },
});
