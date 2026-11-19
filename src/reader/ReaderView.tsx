import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ElementRef,
  type ReactNode,
} from 'react';
import {
  Platform,
  processColor,
  StyleSheet,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  type Insets,
  type LayoutChangeEvent,
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

/** Flat native form of a margin marker (-1 = no range). */
export function markerSpecFor(m: ReaderMarker): {
  id: string;
  blockId: string;
  start: number;
  end: number;
} {
  const start = m.start != null && m.start >= 0 ? Math.trunc(m.start) : -1;
  const end = m.end != null && m.end >= 0 ? Math.trunc(m.end) : -1;
  return { id: m.id, blockId: m.blockId, start, end };
}

/**
 * Marker views kept mounted after their rows left the native window, so a
 * short scroll back does not remount them.
 */
export const MARKER_WINDOW_BUFFER = 16;

/**
 * Marker IDs whose views are mounted next: everything the native window asks
 * for, plus up to `buffer` of the previously mounted ones (most recently
 * requested first). IDs that are no longer in `known` are dropped.
 */
export function nextMarkerWindow(
  prev: readonly string[],
  requested: readonly string[],
  known: ReadonlySet<string>,
  buffer: number = MARKER_WINDOW_BUFFER
): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const id of requested) {
    if (known.has(id) && !seen.has(id)) {
      seen.add(id);
      next.push(id);
    }
  }
  let kept = 0;
  for (const id of prev) {
    if (kept >= buffer) break;
    if (known.has(id) && !seen.has(id)) {
      seen.add(id);
      next.push(id);
      kept += 1;
    }
  }
  if (next.length === prev.length && next.every((id, i) => id === prev[i])) {
    return prev as string[];
  }
  return next;
}

/** Default hit size of a marker (HIG 44 pt, Material 48 dp). */
function defaultMarkerHitSize(): number {
  return Platform.OS === 'android' ? 48 : 44;
}

/** Hit slop that grows a `width` × `height` marker view to `target`. */
export function markerHitSlop(
  width: number,
  height: number,
  target: number = defaultMarkerHitSize()
): Insets | undefined {
  const x = Math.max(0, Math.ceil((target - width) / 2));
  const y = Math.max(0, Math.ceil((target - height) / 2));
  if (x === 0 && y === 0) return undefined;
  return { top: y, bottom: y, left: x, right: x };
}

/** A touch that moved further than this (pt) is a drag, not a press. */
const MARKER_TAP_SLOP = 10;
const MARKER_A11Y_ACTIONS = [{ name: 'activate' }];

type MarkerHostProps = {
  marker: ReaderMarker;
  /** Side of the square hit area (pt / dp); at least the view's size. */
  hitSize: number;
  onPress?: (marker: { id: string; blockId: string }) => void;
  children: ReactNode;
};

/**
 * Host of one marker view. The native list places it at the marker's line;
 * a tap that no pressable child takes fires `onMarkerPress`.
 */
const MarkerHost = memo(function MarkerHost({
  marker,
  hitSize,
  onPress,
  children,
}: MarkerHostProps) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null
  );
  const slop = useMemo(
    () => (size ? markerHitSlop(size.width, size.height, hitSize) : undefined),
    [size, hitSize]
  );
  const touch = useRef<{ x: number; y: number } | null>(null);
  const { id, blockId } = marker;
  const press = useCallback(
    () => onPress?.({ id, blockId }),
    [onPress, id, blockId]
  );
  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((prev) =>
      prev?.width === width && prev?.height === height
        ? prev
        : { width, height }
    );
  }, []);
  const handleAction = useCallback(
    (e: AccessibilityActionEvent) => {
      if (e.nativeEvent.actionName === 'activate') press();
    },
    [press]
  );
  return (
    <SherpaReaderInsertView
      markerId={id}
      collapsable={false}
      style={styles.markerHost}
      hitSlop={slop}
      onLayout={handleLayout}
      accessible
      accessibilityRole="button"
      accessibilityLabel={marker.accessibilityLabel}
      accessibilityActions={MARKER_A11Y_ACTIONS}
      onAccessibilityAction={handleAction}
      // Bubbling: a pressable inside the app's view claims the touch first.
      onStartShouldSetResponder={() => true}
      onResponderTerminationRequest={() => true}
      onResponderGrant={(e: GestureResponderEvent) => {
        touch.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
      }}
      onResponderMove={(e: GestureResponderEvent) => {
        const t = touch.current;
        if (
          t &&
          Math.hypot(e.nativeEvent.pageX - t.x, e.nativeEvent.pageY - t.y) >
            MARKER_TAP_SLOP
        ) {
          touch.current = null;
        }
      }}
      onResponderRelease={() => {
        if (touch.current) press();
        touch.current = null;
      }}
      onResponderTerminate={() => {
        touch.current = null;
      }}
    >
      {children}
    </SherpaReaderInsertView>
  );
});

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
 * Native, virtualized reader (Fabric only). Inserts and marker views are
 * rendered as React children and placed by the native list: inserts into the
 * reading flow, marker views into the trailing margin.
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
      renderMarker,
      markerHitSize,
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
    // Virtualized marker views: the native list reports the markers of the
    // rows in and around the visible range; only those are mounted.
    const markerIds = useMemo(
      () => new Set((markers ?? []).map((m) => m.id)),
      [markers]
    );
    const knownMarkers = useRef(markerIds);
    knownMarkers.current = markerIds;
    const markerBlocks = useRef(new Map<string, string>());
    markerBlocks.current = useMemo(
      () => new Map((markers ?? []).map((m) => [m.id, m.blockId])),
      [markers]
    );
    const [markerWindow, setMarkerWindow] = useState<string[]>([]);
    const mountedMarkers = useMemo(() => {
      if (!renderMarker || !markers || markerWindow.length === 0) return [];
      const ids = new Set(markerWindow);
      // In `markers` order: the window only adds and removes hosts, it never
      // reorders them (a reorder would remount native views).
      return markers.filter((m) => ids.has(m.id));
    }, [renderMarker, markers, markerWindow]);
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
    const handleMarkerWindow = useCallback(
      (e: NativeSyntheticEvent<NativeEvent<'onMarkerWindowChange'>>) => {
        const requested = [...e.nativeEvent.markerIds];
        setMarkerWindow((prev) =>
          nextMarkerWindow(prev, requested, knownMarkers.current)
        );
      },
      []
    );
    // iOS: a tap over selectable text in a marker's hit area (the text kept
    // the touch so a long press can still select).
    const handleMarkerTap = useCallback(
      (e: NativeSyntheticEvent<NativeEvent<'onMarkerTap'>>) => {
        const id = e.nativeEvent.markerId;
        const blockId = markerBlocks.current.get(id);
        if (blockId != null) onMarkerPress?.({ id, blockId });
      },
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
        onMarkerWindowChange={renderMarker ? handleMarkerWindow : undefined}
        onMarkerTap={
          renderMarker && onMarkerPress ? handleMarkerTap : undefined
        }
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
        {renderMarker
          ? mountedMarkers.map((m) => (
              <MarkerHost
                key={m.id}
                marker={m}
                hitSize={markerHitSize ?? defaultMarkerHitSize()}
                onPress={onMarkerPress}
              >
                {renderMarker(m.id)}
              </MarkerHost>
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
  // Sized by its content; the native list places it at the marker's line.
  markerHost: { position: 'absolute', top: 0, left: 0 },
});
