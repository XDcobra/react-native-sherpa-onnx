import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  type ElementRef,
} from 'react';
import { StyleSheet, type NativeSyntheticEvent } from 'react-native';

import SherpaReaderInsertView from './SherpaReaderInsertViewNativeComponent';
import SherpaReaderView, {
  Commands,
  type NativeProps,
} from './SherpaReaderViewNativeComponent';
import type {
  ReaderInsert,
  ReaderLocator,
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
      style,
      testID,
      onReady,
      onVisibleRangeChange,
      onFurthestPositionChange,
      onSectionEnd,
      onJump,
      onTap,
      onError,
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
        highlight() {
          if (__DEV__) {
            console.warn('[ReaderView] highlight() is not implemented yet.');
          }
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
          cause: n.cause as 'scroll' | 'fling' | 'scrollTo',
        });
      },
      [onJump]
    );
    const handleTap = useCallback(
      (e: NativeSyntheticEvent<NativeEvent<'onReaderTap'>>) =>
        onTap?.({ blockId: e.nativeEvent.blockId }),
      [onTap]
    );
    const handleError = useCallback(
      (e: NativeSyntheticEvent<NativeEvent<'onReaderError'>>) =>
        onError?.({ code: e.nativeEvent.code, message: e.nativeEvent.message }),
      [onError]
    );

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
        marginHorizontal={theme?.margins?.horizontal ?? 20}
        marginVertical={theme?.margins?.vertical ?? 24}
        textAlign={theme?.textAlign ?? 'start'}
        hyphenation={theme?.hyphenation ?? true}
        textColor={theme?.colors?.text}
        accentColor={theme?.colors?.accent}
        inserts={insertSpecs}
        jumpThreshold={jumpThreshold ?? 20}
        debugRowCount={__debugRowCount ?? 0}
        onReaderReady={handleReady}
        onVisibleRangeChange={handleVisible}
        onFurthestPositionChange={handleFurthest}
        onSectionEnd={handleSectionEnd}
        onJump={handleJump}
        onReaderTap={handleTap}
        onReaderError={handleError}
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
