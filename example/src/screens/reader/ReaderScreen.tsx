import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ReaderView,
  type ReaderInsert,
  type ReaderViewHandle,
} from 'react-native-sherpa-onnx/reader';

import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import { styles } from './ReaderScreen.styles';

const LOG_LIMIT = 50;

function smoke(ev: string, data: Record<string, unknown> = {}) {
  if (__DEV__) {
    console.log('READER_SMOKE ' + JSON.stringify({ ev, ...data }));
  }
}

/**
 * Spike (phase 1): ReaderView with placeholder rows and React inserts, to
 * check mounting, resizing, taps and drags inside the native list.
 */
export default function ReaderScreen() {
  const reader = useRef<ReaderViewHandle>(null);
  const [log, setLog] = useState<string[]>([]);
  const [showFar, setShowFar] = useState(true);
  const [swapped, setSwapped] = useState(false);
  const [tall, setTall] = useState(false);
  const [presses, setPresses] = useState<Record<string, number>>({});

  const push = useCallback(
    (line: string, ev: string, data?: Record<string, unknown>) => {
      smoke(ev, data);
      setLog((prev) => [line, ...prev].slice(0, LOG_LIMIT));
    },
    []
  );

  const inserts = useMemo<ReaderInsert[]>(() => {
    const list: ReaderInsert[] = [
      { key: 'card-a', at: { afterBlock: swapped ? 's1.b4' : 's0.b2' } },
      { key: 'card-b', at: { sectionEnd: 's1' } },
    ];
    if (showFar) {
      list.push({ key: 'card-far', at: { beforeBlock: 's5.b0' } });
    }
    return list;
  }, [showFar, swapped]);

  const onPressInsert = useCallback(
    (key: string) => {
      setPresses((p) => ({ ...p, [key]: (p[key] ?? 0) + 1 }));
      push(`press ${key}`, 'insertPress', { key });
    },
    [push]
  );

  const renderInsert = useCallback(
    (key: string) => (
      <View style={styles.insertCard} accessibilityLabel={`Insert ${key}`}>
        <Text style={styles.insertTitle}>Insert {key}</Text>
        {key === 'card-a' && tall ? (
          <Text style={styles.insertBody}>
            This insert grew. The text below it should not jump while it changes
            size above the visible area.
          </Text>
        ) : null}
        <Pressable
          testID={`reader-insert-${key}-button`}
          accessibilityRole="button"
          accessibilityLabel={`Press ${key}`}
          onPress={() => onPressInsert(key)}
          style={({ pressed }) => [
            styles.insertButton,
            pressed && styles.insertButtonPressed,
          ]}
        >
          <Text style={styles.insertButtonText}>
            Press ({presses[key] ?? 0})
          </Text>
        </Pressable>
      </View>
    ),
    [onPressInsert, presses, tall]
  );

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.toolbar}>
        <ToolbarButton
          id="reader-toggle-far"
          label="Toggle far"
          onPress={() => {
            setShowFar((v) => !v);
            push('toggle far insert', 'toggleFar');
          }}
        />
        <ToolbarButton
          id="reader-move-a"
          label="Move A"
          onPress={() => {
            setSwapped((v) => !v);
            push('move card-a', 'moveA');
          }}
        />
        <ToolbarButton
          id="reader-grow-a"
          label="Resize A"
          onPress={() => {
            setTall((v) => !v);
            push('resize card-a', 'resizeA');
          }}
        />
        <ToolbarButton
          id="reader-jump"
          label="Jump s4"
          onPress={() => {
            reader.current?.scrollTo({ sectionId: 's4', blockId: 's4.b0' });
            push('scrollTo s4.b0', 'scrollTo');
          }}
        />
      </View>

      <ReaderView
        ref={reader}
        testID="reader-view"
        document={null}
        __debugRowCount={80}
        inserts={inserts}
        renderInsert={renderInsert}
        style={styles.reader}
        onReady={(info) =>
          push(`ready ${info.blockCount} blocks`, 'ready', info)
        }
        onVisibleRangeChange={(r) => {
          if (r.settled) {
            push(
              `visible ${r.first.blockId}…${
                r.last.blockId
              } [${r.visibleInserts.join(',')}]`,
              'visible',
              {
                first: r.first.blockId,
                last: r.last.blockId,
                inserts: r.visibleInserts,
              }
            );
          }
        }}
        onTap={(t) => push(`tap ${t.blockId}`, 'tap', t)}
      />

      <View style={styles.log} testID="reader-log">
        {log.slice(0, 5).map((line, i) => (
          <Text key={`${i}-${line}`} style={styles.logLine} numberOfLines={1}>
            {line}
          </Text>
        ))}
      </View>
      <ScreenIntroModal screenId="Reader" />
    </SafeAreaView>
  );
}

function ToolbarButton({
  id,
  label,
  onPress,
}: {
  id: string;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.toolbarButton,
        pressed && styles.toolbarButtonPressed,
      ]}
    >
      <Text style={styles.toolbarButtonText}>{label}</Text>
    </Pressable>
  );
}
