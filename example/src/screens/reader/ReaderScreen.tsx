import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from '@react-native-documents/picker';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  insertSection,
  loadReaderDocument,
  ReaderView,
  releaseReaderDocument,
  type ReaderDocument,
  type ReaderInsert,
  type ReaderLocator,
  type ReaderTheme,
  type ReaderViewHandle,
} from 'react-native-sherpa-onnx/reader';

import { ExampleDocumentFileList } from '../../components/ExampleDocumentFileList';
import { FileSourcePicker } from '../../components/FileSourcePicker';
import { OcrChoiceRow } from '../../components/ocr/OcrChoiceRow';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import { READER_FILES } from '../../documentConfig';
import {
  fileSourceFromBundledPath,
  toFileSource,
} from '../../utils/fileSourceFromUri';
import { styles } from './ReaderScreen.styles';

const LOG_LIMIT = 50;

type ThemeName = 'paper' | 'sepia' | 'contrast';
type ScaleName = 'system' | '0.9×' | '1.2×' | '1.5×';
type LineName = '1.3' | '1.5' | '1.8';
type JumpName = '5' | '20' | '50';

const THEMES: Record<ThemeName, NonNullable<ReaderTheme['colors']>> = {
  paper: { background: '#FBF8F1', text: '#2A2724', accent: '#3F3AB8' },
  sepia: { background: '#F4ECD8', text: '#5B4636', accent: '#8A5A2B' },
  contrast: { background: '#000000', text: '#FFFFFF', accent: '#FFD60A' },
};
const SCALES: Record<ScaleName, ReaderTheme['fontScale']> = {
  'system': 'system',
  '0.9×': 0.9,
  '1.2×': 1.2,
  '1.5×': 1.5,
};

function smoke(ev: string, data: Record<string, unknown> = {}) {
  if (__DEV__) {
    console.log('READER_SMOKE ' + JSON.stringify({ ev, ...data }));
  }
}

const DEMO_SECTION_ID = 'app:demo';

/**
 * Reader API demo: EPUB → ReaderDocument (stable block IDs, app section) →
 * native ReaderView with inserts, theme controls and an event log.
 */
export default function ReaderScreen() {
  const reader = useRef<ReaderViewHandle>(null);
  const docRef = useRef<ReaderDocument | null>(null);
  const [doc, setDoc] = useState<ReaderDocument | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [themeName, setThemeName] = useState<ThemeName>('paper');
  const [scaleName, setScaleName] = useState<ScaleName>('system');
  const [lineName, setLineName] = useState<LineName>('1.5');
  const [jumpName, setJumpName] = useState<JumpName>('20');
  const [showSettings, setShowSettings] = useState(false);
  const [showSections, setShowSections] = useState(false);
  const [presses, setPresses] = useState<Record<string, number>>({});
  const [visible, setVisible] = useState<ReaderLocator | null>(null);
  const [saved, setSaved] = useState<ReaderLocator | null>(null);
  const [initialLocator, setInitialLocator] = useState<ReaderLocator | null>(
    null
  );
  const [mountKey, setMountKey] = useState(0);

  const push = useCallback(
    (line: string, ev: string, data?: Record<string, unknown>) => {
      smoke(ev, data);
      setLog((prev) => [line, ...prev].slice(0, LOG_LIMIT));
    },
    []
  );

  const release = useCallback(async () => {
    const current = docRef.current;
    docRef.current = null;
    if (current) {
      await releaseReaderDocument(current).catch(() => {});
    }
  }, []);

  useEffect(
    () => () => {
      release().catch(() => {});
    },
    [release]
  );

  const open = useCallback(
    async (source: FileSource, name: string) => {
      setBusy(true);
      setError(null);
      setLabel(name);
      setLog([]);
      setSaved(null);
      setInitialLocator(null);
      await release();
      setDoc(null);
      try {
        let next = await loadReaderDocument(source);
        // App section (text that is not in the file), after the second section.
        const anchor = next.sections[1] ?? next.sections[0];
        if (anchor) {
          next = await insertSection(next, {
            after: anchor.id,
            id: DEMO_SECTION_ID,
            title: 'A path of your own',
            blocks: [
              {
                key: 'title',
                type: 'heading',
                level: 2,
                text: 'A path of your own',
              },
              {
                key: 'p1',
                type: 'paragraph',
                text: 'This section was inserted by the app with insertSection(). Its blocks have IDs like app:demo.p1 and sit between the file’s sections.',
              },
            ],
          });
        }
        docRef.current = next;
        setDoc(next);
        smoke('loaded', {
          name,
          blocks: next.blockCount,
          sections: next.sections.length,
          key: next.documentKey.slice(0, 12),
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        smoke('error', { message: msg });
      } finally {
        setBusy(false);
      }
    },
    [release]
  );

  const handleChooseFile = useCallback(async () => {
    try {
      const picked = await DocumentPicker.pick({
        type: ['application/epub+zip', 'org.idpf.epub-container'],
        allowMultiSelection: false,
      });
      const file = Array.isArray(picked) ? picked[0] : picked;
      const uri = file?.uri ?? '';
      if (!uri) return;
      const name = file?.name?.trim() || uri.split('/').pop() || 'book.epub';
      setSelectedId(null);
      await open(toFileSource(uri, name), name);
    } catch (e: unknown) {
      if (!DocumentPicker.isErrorWithCode(e)) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, [open]);

  const inserts = useMemo<ReaderInsert[]>(() => {
    if (!doc) return [];
    const list: ReaderInsert[] = [];
    const first = doc.sections.find((s) => s.origin === 'file');
    if (first) list.push({ key: 'invite', at: { sectionEnd: first.id } });
    const later = doc.sections.filter((s) => s.origin === 'file')[2];
    if (later?.firstBlockId) {
      list.push({
        key: 'turning-point',
        at: { beforeBlock: later.firstBlockId },
      });
    }
    return list;
  }, [doc]);

  const renderInsert = useCallback(
    (key: string) => (
      <View
        style={[styles.insertCard, { borderColor: THEMES[themeName].accent }]}
        accessibilityLabel={`Insert ${key}`}
      >
        <Text style={styles.insertTitle}>
          {key === 'invite' ? 'End of chapter' : 'Turning point'}
        </Text>
        <Text style={styles.insertBody}>
          A React Native view inside the native reading flow.
        </Text>
        <Pressable
          testID={`reader-insert-${key}-button`}
          accessibilityRole="button"
          accessibilityLabel={`Press ${key}`}
          onPress={() => {
            setPresses((p) => ({ ...p, [key]: (p[key] ?? 0) + 1 }));
            push(`press ${key}`, 'insertPress', { key });
          }}
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
    [presses, push, themeName]
  );

  const theme = useMemo<ReaderTheme>(
    () => ({
      fontScale: SCALES[scaleName],
      lineHeight: Number(lineName),
      colors: THEMES[themeName],
      hyphenation: true,
    }),
    [lineName, scaleName, themeName]
  );

  if (!doc) {
    return (
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Open a book</Text>
            <Text style={styles.sectionHint}>
              EPUB text and images become a ReaderDocument with stable block
              IDs, shown in the native ReaderView.
            </Text>
            <FileSourcePicker
              disabled={busy}
              selectedLabel={label}
              selectedDescription={
                READER_FILES.find((f) => f.id === selectedId)?.description ??
                null
              }
              exampleListTitle="Choose an example book"
              ownPickButtonLabel="Pick an EPUB…"
              onPickOwn={() => {
                handleChooseFile().catch(() => {});
              }}
              renderExampleList={({ disabled, collapse }) => (
                <ExampleDocumentFileList
                  files={READER_FILES}
                  selectedId={selectedId}
                  disabled={disabled}
                  onSelect={(file) => {
                    collapse();
                    setSelectedId(file.id);
                    open(fileSourceFromBundledPath(file.id), file.name).catch(
                      () => {}
                    );
                  }}
                />
              )}
            />
            {busy ? (
              <View style={styles.busyRow}>
                <ActivityIndicator />
                <Text style={styles.sectionHint}>Loading book…</Text>
              </View>
            ) : null}
          </View>
          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorTitle}>Could not open the book</Text>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}
        </ScrollView>
        <ScreenIntroModal screenId="Reader" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={[
        styles.container,
        { backgroundColor: THEMES[themeName].background },
      ]}
      edges={['bottom']}
    >
      <View style={styles.toolbar}>
        <ToolbarButton
          id="reader-close"
          label="Close"
          onPress={() => {
            release().catch(() => {});
            setDoc(null);
          }}
        />
        <ToolbarButton
          id="reader-sections"
          label="Sections"
          onPress={() => setShowSections(true)}
        />
        <ToolbarButton
          id="reader-settings"
          label="Aa"
          onPress={() => setShowSettings((v) => !v)}
        />
        <ToolbarButton
          id="reader-save"
          label="Save"
          onPress={() => {
            setSaved(visible);
            push(`saved ${visible?.blockId ?? '—'}`, 'save', {
              blockId: visible?.blockId,
            });
          }}
        />
        <ToolbarButton
          id="reader-restore"
          label="Restore"
          onPress={() => {
            if (!saved) return;
            setInitialLocator(saved);
            setMountKey((k) => k + 1);
            push(`restore ${saved.blockId}`, 'restore', {
              blockId: saved.blockId,
            });
          }}
        />
      </View>

      {showSettings ? (
        <View style={styles.settings}>
          <OcrChoiceRow
            label="Theme"
            options={['paper', 'sepia', 'contrast'] as const}
            value={themeName}
            onChange={(v) => {
              setThemeName(v);
              push(`theme ${v}`, 'theme', { value: v });
            }}
          />
          <OcrChoiceRow
            label="Text size"
            options={['system', '0.9×', '1.2×', '1.5×'] as const}
            value={scaleName}
            onChange={(v) => {
              setScaleName(v);
              push(`size ${v}`, 'fontScale', { value: v });
            }}
          />
          <OcrChoiceRow
            label="Line height"
            options={['1.3', '1.5', '1.8'] as const}
            value={lineName}
            onChange={(v) => {
              setLineName(v);
              push(`line ${v}`, 'lineHeight', { value: v });
            }}
          />
          <OcrChoiceRow
            label="Jump after (blocks)"
            options={['5', '20', '50'] as const}
            value={jumpName}
            onChange={(v) => {
              setJumpName(v);
              push(`jump threshold ${v}`, 'jumpThreshold', { value: v });
            }}
          />
        </View>
      ) : null}

      <ReaderView
        key={mountKey}
        ref={reader}
        testID="reader-view"
        document={doc}
        initialLocator={initialLocator}
        theme={theme}
        inserts={inserts}
        renderInsert={renderInsert}
        jumpThreshold={Number(jumpName)}
        style={styles.reader}
        onReady={(info) =>
          push(
            `ready ${info.blockCount} blocks, ${info.sectionCount} sections`,
            'ready',
            info
          )
        }
        onVisibleRangeChange={(r) => {
          if (!r.settled) return;
          setVisible({ ...r.first, offset: r.firstOffset });
          push(
            `visible ${r.first.blockId}…${r.last.blockId}${
              r.visibleInserts.length ? ` [${r.visibleInserts.join(',')}]` : ''
            }`,
            'visible',
            {
              first: r.first.blockId,
              last: r.last.blockId,
              offset: r.firstOffset,
              inserts: r.visibleInserts,
            }
          );
        }}
        onFurthestPositionChange={(l) =>
          push(`furthest ${l.blockId}`, 'furthest', { blockId: l.blockId })
        }
        onSectionEnd={(e) =>
          push(`section end ${e.sectionId}`, 'sectionEnd', e)
        }
        onJump={(j) =>
          push(
            `jump ${j.cause} ${j.from.blockId}→${j.to.blockId} (${j.distance})`,
            'jump',
            {
              cause: j.cause,
              from: j.from.blockId,
              to: j.to.blockId,
              distance: j.distance,
            }
          )
        }
        onTap={(t) => push(`tap ${t.blockId}`, 'tap', t)}
        onError={(e) => push(`error ${e.code}`, 'readerError', e)}
      />

      <View style={styles.log} testID="reader-log">
        {log.slice(0, 4).map((line, i) => (
          <Text key={`${i}-${line}`} style={styles.logLine} numberOfLines={1}>
            {line}
          </Text>
        ))}
      </View>

      <Modal
        visible={showSections}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowSections(false)}
      >
        <SafeAreaView style={styles.container}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sectionTitle}>
              {doc.metadata.title ?? label}
            </Text>
            <Pressable
              testID="reader-sections-done"
              accessibilityRole="button"
              onPress={() => setShowSections(false)}
              style={styles.toolbarButton}
            >
              <Text style={styles.toolbarButtonText}>Done</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.content}>
            {doc.sections.map((s) => (
              <Pressable
                key={s.id}
                testID={`reader-section-${s.id}`}
                accessibilityRole="button"
                accessibilityLabel={`Go to ${s.title ?? s.id}`}
                disabled={!s.firstBlockId}
                onPress={() => {
                  setShowSections(false);
                  reader.current?.scrollTo({
                    sectionId: s.id,
                    blockId: s.firstBlockId,
                  });
                  push(`go to ${s.id}`, 'scrollTo', { sectionId: s.id });
                }}
                style={({ pressed }) => [
                  styles.sectionRow,
                  pressed && styles.toolbarButtonPressed,
                ]}
              >
                <Text style={styles.sectionRowTitle} numberOfLines={1}>
                  {s.title ?? (s.kind === 'image' ? 'Image page' : 'Untitled')}
                </Text>
                <Text style={styles.sectionRowMeta}>
                  {s.id} · {s.blockCount} blocks
                  {s.origin === 'app' ? ' · app' : ''}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </SafeAreaView>
      </Modal>
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
