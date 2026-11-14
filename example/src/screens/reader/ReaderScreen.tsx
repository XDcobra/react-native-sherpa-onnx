import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from '@react-native-documents/picker';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  getReaderBlocks,
  insertSection,
  loadReaderDocument,
  ReaderView,
  releaseReaderDocument,
  removeSection,
  type ReaderBlock,
  type ReaderDocument,
  type ReaderHighlight,
  type ReaderInsert,
  type ReaderLocator,
  type ReaderPageDisplay,
  type ReaderSectionInfo,
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

type ThemeName = 'paper' | 'sepia' | 'night';
type FontName = 'serif' | 'sans';
type SizeName = 'system' | '0.9×' | '1.2×' | '1.5×';
type LineName = '1.3' | '1.5' | '1.8';
type AlignName = 'start' | 'justify';
type MarginName = 'narrow' | 'normal' | 'wide';
type Panel = 'none' | 'appearance' | 'search';

const THEMES: Record<
  ThemeName,
  { background: string; text: string; accent: string }
> = {
  paper: { background: '#FBF8F1', text: '#2A2724', accent: '#3F3AB8' },
  sepia: { background: '#F4ECD8', text: '#5B4636', accent: '#8A5A2B' },
  night: { background: '#15171A', text: '#E4E0D8', accent: '#8AB4F8' },
};
const FONTS: Record<FontName, string | undefined> = {
  serif: undefined, // system serif
  sans: Platform.select({ ios: 'Avenir Next', default: 'sans-serif' }),
};
const SIZES: Record<SizeName, ReaderTheme['fontScale']> = {
  'system': 'system',
  '0.9×': 0.9,
  '1.2×': 1.2,
  '1.5×': 1.5,
};
const MARGINS: Record<MarginName, number> = {
  narrow: 12,
  normal: 20,
  wide: 36,
};

/** Colors of the app's own highlights (the read-aloud screen uses the theme accent). */
const MARK_COLOR = '#FACC1566';
const HIT_COLOR = '#EA580C';
const HIT_ACTIVE_COLOR = '#FB923C55';
const MAX_HITS = 500;
/** Sections with at least this many blocks count as chapters (end cards). */
const MIN_CHAPTER_BLOCKS = 8;

/** App section the screen inserts after the first chapter. */
const GUIDE_ID = 'app:about';
const GUIDE_TITLE = 'About this example';

/** Last position per book (documentKey), for "resume where you left off". */
const savedPositions = new Map<
  string,
  { at: ReaderLocator; furthest: ReaderLocator | null }
>();

type Note = {
  key: string;
  blockId: string;
  sectionId: string;
  quote: string;
  time: string;
};

type Hit = { from: ReaderLocator; to: ReaderLocator };

/** Block index in reading order for each section's first block. */
function sectionStarts(doc: ReaderDocument): Map<string, number> {
  const out = new Map<string, number>();
  let index = 0;
  for (const s of doc.sections) {
    out.set(s.id, index);
    index += s.blockCount;
  }
  return out;
}

/** Index of a block in reading order (file blocks exact, app blocks at their section). */
function blockIndex(
  starts: Map<string, number>,
  locator: ReaderLocator
): number {
  const start = starts.get(locator.sectionId) ?? 0;
  const m = /\.b(\d+)$/.exec(locator.blockId);
  return m ? start + Number(m[1]) : start;
}

function sectionTitle(s: ReaderSectionInfo | undefined): string {
  if (!s) return '';
  if (s.title) return s.title;
  return s.kind === 'image' ? 'Image page' : 'Untitled section';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reader showcase: pick an EPUB, read it in the native ReaderView and try the
 * reader API — appearance, contents, an app section, React Native inserts in
 * the reading flow, highlights, search, progress, jumps and resume.
 */
export default function ReaderScreen() {
  const { height } = useWindowDimensions();
  const reader = useRef<ReaderViewHandle>(null);
  const docRef = useRef<ReaderDocument | null>(null);
  const furthestRef = useRef<ReaderLocator | null>(null);
  const textsRef = useRef<ReaderBlock[] | null>(null);

  // Document
  const [doc, setDoc] = useState<ReaderDocument | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialLocator, setInitialLocator] = useState<ReaderLocator | null>(
    null
  );
  const [furthest, setFurthest] = useState<ReaderLocator | null>(null);

  // Appearance
  const [themeName, setThemeName] = useState<ThemeName>('paper');
  const [fontName, setFontName] = useState<FontName>('serif');
  const [sizeName, setSizeName] = useState<SizeName>('system');
  const [lineName, setLineName] = useState<LineName>('1.5');
  const [alignName, setAlignName] = useState<AlignName>('start');
  const [marginName, setMarginName] = useState<MarginName>('normal');
  const [pageDisplay, setPageDisplay] = useState<ReaderPageDisplay>('auto');
  const [panel, setPanel] = useState<Panel>('none');
  const [showContents, setShowContents] = useState(false);

  // Reading state from events
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [position, setPosition] = useState<ReaderLocator | null>(null);
  const [finished, setFinished] = useState<Set<string>>(new Set());
  const [jumpBack, setJumpBack] = useState<ReaderLocator | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Marks, notes, selection, search
  const [selected, setSelected] = useState<{
    locator: ReaderLocator;
    quote: string;
  } | null>(null);
  const [marks, setMarks] = useState<Record<string, ReaderLocator>>({});
  const [notes, setNotes] = useState<Note[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [hitIndex, setHitIndex] = useState(0);
  const [searching, setSearching] = useState(false);

  const theme = useMemo<ReaderTheme>(
    () => ({
      fontFamily: FONTS[fontName],
      fontScale: SIZES[sizeName],
      lineHeight: Number(lineName),
      textAlign: alignName,
      margins: { horizontal: MARGINS[marginName] },
      hyphenation: true,
      colors: THEMES[themeName],
    }),
    [alignName, fontName, lineName, marginName, sizeName, themeName]
  );
  const colors = THEMES[themeName];

  const starts = useMemo(
    () => (doc ? sectionStarts(doc) : new Map<string, number>()),
    [doc]
  );
  const sectionsById = useMemo(
    () => new Map((doc?.sections ?? []).map((s) => [s.id, s])),
    [doc]
  );

  const showNotice = useCallback((text: string) => setNotice(text), []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // ---- Open / close ----

  const release = useCallback(async () => {
    const current = docRef.current;
    docRef.current = null;
    textsRef.current = null;
    if (current) await releaseReaderDocument(current).catch(() => {});
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
      await release();
      setDoc(null);
      setChapterId(null);
      setPosition(null);
      setFinished(new Set());
      setJumpBack(null);
      setSelected(null);
      setMarks({});
      setNotes([]);
      setHits([]);
      setQuery('');
      setPanel('none');
      try {
        let next = await loadReaderDocument(source);
        // Text that is not in the file: an app section after the first chapter.
        const firstText = next.sections.find(
          (s) => s.origin === 'file' && s.kind === 'text'
        );
        if (firstText) {
          next = await insertSection(next, guideSection(firstText.id));
        }
        const saved = savedPositions.get(next.documentKey);
        setInitialLocator(saved?.at ?? null);
        setFurthest(saved?.furthest ?? null);
        furthestRef.current = saved?.furthest ?? null;
        docRef.current = next;
        setDoc(next);
        if (saved) {
          showNotice(
            `Resumed at “${sectionTitle(
              next.sections.find((s) => s.id === saved.at.sectionId)
            )}”`
          );
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [release, showNotice]
  );

  const handlePickOwn = useCallback(async () => {
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

  // ---- App section ----

  const hasGuide = doc?.sections.some((s) => s.id === GUIDE_ID) ?? false;
  const toggleGuide = useCallback(async () => {
    const current = docRef.current;
    if (!current) return;
    try {
      let next: ReaderDocument;
      if (current.sections.some((s) => s.id === GUIDE_ID)) {
        next = await removeSection(current, GUIDE_ID);
      } else {
        const firstText = current.sections.find(
          (s) => s.origin === 'file' && s.kind === 'text'
        );
        if (!firstText) return;
        next = await insertSection(current, guideSection(firstText.id));
      }
      // A new revision keeps the reading position.
      docRef.current = next;
      textsRef.current = null;
      setDoc(next);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // ---- Block text (selection quote, search) ----

  const loadTexts = useCallback(async (): Promise<ReaderBlock[]> => {
    const current = docRef.current;
    if (!current) return [];
    if (!textsRef.current) {
      textsRef.current = await getReaderBlocks(current, 0, current.blockCount, {
        includeText: true,
      });
    }
    return textsRef.current;
  }, []);

  const select = useCallback(
    async (blockId: string) => {
      const blocks = await loadTexts();
      const block = blocks.find((b) => b.id === blockId);
      if (!block?.text) {
        setSelected(null);
        return;
      }
      setSelected({
        locator: { sectionId: block.sectionId, blockId: block.id },
        quote: block.text,
      });
    },
    [loadTexts]
  );

  const runSearch = useCallback(async () => {
    const term = query.trim();
    if (!term) {
      setHits([]);
      return;
    }
    setSearching(true);
    try {
      const blocks = await loadTexts();
      const re = new RegExp(escapeRegExp(term), 'gi');
      const found: Hit[] = [];
      for (const b of blocks) {
        if (!b.text) continue;
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(b.text)) !== null && found.length < MAX_HITS) {
          found.push({
            from: { sectionId: b.sectionId, blockId: b.id, offset: m.index },
            to: {
              sectionId: b.sectionId,
              blockId: b.id,
              offset: m.index + m[0].length,
            },
          });
        }
        if (found.length >= MAX_HITS) break;
      }
      setHits(found);
      setHitIndex(0);
      if (found[0]) reader.current?.scrollTo(found[0].from);
    } finally {
      setSearching(false);
    }
  }, [loadTexts, query]);

  const goToHit = useCallback(
    (delta: number) => {
      if (hits.length === 0) return;
      const next = (hitIndex + delta + hits.length) % hits.length;
      setHitIndex(next);
      reader.current?.scrollTo(hits[next]!.from, { animated: true });
    },
    [hitIndex, hits]
  );

  // ---- Highlights: marks, search hits, active hit, selection ----

  const highlights = useMemo<ReaderHighlight[]>(() => {
    const list: ReaderHighlight[] = Object.entries(marks).map(
      ([blockId, at]) => ({
        id: `mark:${blockId}`,
        from: at,
        to: at,
        style: 'background',
        color: MARK_COLOR,
      })
    );
    hits.forEach((h, i) =>
      list.push({
        id: `hit:${i}`,
        from: h.from,
        to: h.to,
        style: 'textColor',
        color: HIT_COLOR,
      })
    );
    const active = hits[hitIndex];
    if (active) {
      list.push({
        id: 'hit:active',
        from: active.from,
        to: active.to,
        style: 'background',
        color: HIT_ACTIVE_COLOR,
      });
    }
    if (selected) {
      list.push({
        id: 'selection',
        from: selected.locator,
        to: selected.locator,
        style: 'underline',
      });
    }
    return list;
  }, [hitIndex, hits, marks, selected]);

  // ---- Inserts: chapter ends and notes ----

  const inserts = useMemo<ReaderInsert[]>(() => {
    if (!doc) return [];
    const list: ReaderInsert[] = [];
    doc.sections.forEach((s, i) => {
      const next = doc.sections[i + 1];
      // Chapters only: skip short front matter such as the title page.
      if (
        s.origin === 'file' &&
        s.kind === 'text' &&
        s.blockCount >= MIN_CHAPTER_BLOCKS &&
        next
      ) {
        list.push({ key: `end:${s.id}`, at: { sectionEnd: s.id } });
      }
    });
    for (const n of notes) {
      list.push({ key: n.key, at: { afterBlock: n.blockId } });
    }
    return list;
  }, [doc, notes]);

  const renderInsert = useCallback(
    (key: string) => {
      if (key.startsWith('note:')) {
        const note = notes.find((n) => n.key === key);
        if (!note) return null;
        return (
          <View
            style={[styles.noteCard, { borderLeftColor: colors.accent }]}
            accessibilityLabel={`Note: ${note.quote}`}
          >
            <Text style={styles.noteMeta}>Note · {note.time}</Text>
            <Text style={styles.noteQuote} numberOfLines={3}>
              “{note.quote}”
            </Text>
            <Pressable
              testID={`reader-note-remove-${note.key}`}
              accessibilityRole="button"
              accessibilityLabel="Remove note"
              onPress={() =>
                setNotes((all) => all.filter((n) => n.key !== key))
              }
              style={({ pressed }) => [
                styles.linkButton,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.linkButtonText, { color: colors.accent }]}>
                Remove note
              </Text>
            </Pressable>
          </View>
        );
      }
      const sectionId = key.slice('end:'.length);
      const index = doc?.sections.findIndex((s) => s.id === sectionId) ?? -1;
      const section = doc?.sections[index];
      const next = doc?.sections[index + 1];
      if (!section || !next) return null;
      const done = finished.has(section.id);
      return (
        <View
          style={[styles.chapterCard, { borderColor: colors.accent }]}
          accessibilityLabel={`End of ${sectionTitle(section)}`}
        >
          <Text style={styles.chapterCardKicker}>
            {done ? '✓ Chapter finished' : 'End of chapter'}
          </Text>
          <Text style={styles.chapterCardTitle} numberOfLines={2}>
            {sectionTitle(section)}
          </Text>
          <Pressable
            testID={`reader-next-${section.id}`}
            accessibilityRole="button"
            accessibilityLabel={`Continue with ${sectionTitle(next)}`}
            onPress={() =>
              reader.current?.scrollTo(
                { sectionId: next.id, blockId: next.firstBlockId },
                { animated: true }
              )
            }
            style={({ pressed }) => [
              styles.chapterCardButton,
              { backgroundColor: colors.accent },
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.chapterCardButtonText} numberOfLines={1}>
              Next: {sectionTitle(next)}
            </Text>
          </Pressable>
        </View>
      );
    },
    [colors.accent, doc, finished, notes]
  );

  // ---- Derived reading state ----

  // Position in the book (first visible block).
  const progress = useMemo(() => {
    if (!doc || !position || doc.blockCount === 0) return 0;
    return Math.min(1, (blockIndex(starts, position) + 1) / doc.blockCount);
  }, [doc, position, starts]);

  const chapter = chapterId ? sectionsById.get(chapterId) : undefined;
  const readerHeight = Math.max(360, Math.round(height * 0.55));

  // ---- Render ----

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={styles.content}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Book</Text>
          <FileSourcePicker
            disabled={busy}
            selectedLabel={label}
            selectedDescription={
              doc
                ? describe(doc)
                : READER_FILES.find((f) => f.id === selectedId)?.description ??
                  null
            }
            exampleListTitle="Choose an example book"
            ownPickButtonLabel="Pick an EPUB…"
            onPickOwn={() => {
              handlePickOwn().catch(() => {});
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
              <Text style={styles.sectionHint}>Opening the book…</Text>
            </View>
          ) : null}
          {!doc && !busy ? (
            <Text style={styles.sectionHint}>
              loadReaderDocument() turns an EPUB into a ReaderDocument with
              stable block IDs; the native ReaderView shows it.
            </Text>
          ) : null}
        </View>

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorTitle}>Reader error</Text>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {doc ? (
          <View style={[styles.section, styles.readerSection]}>
            <View style={styles.toolbar}>
              <ToolbarButton
                id="reader-contents"
                label="Contents"
                onPress={() => setShowContents(true)}
              />
              <ToolbarButton
                id="reader-appearance"
                label="Aa"
                active={panel === 'appearance'}
                onPress={() =>
                  setPanel((p) => (p === 'appearance' ? 'none' : 'appearance'))
                }
              />
              <ToolbarButton
                id="reader-search"
                label="Search"
                active={panel === 'search'}
                onPress={() =>
                  setPanel((p) => (p === 'search' ? 'none' : 'search'))
                }
              />
            </View>

            {panel === 'appearance' ? (
              <View style={styles.panel}>
                <OcrChoiceRow
                  label="Theme"
                  options={['paper', 'sepia', 'night'] as const}
                  value={themeName}
                  onChange={setThemeName}
                />
                <OcrChoiceRow
                  label="Font"
                  options={['serif', 'sans'] as const}
                  value={fontName}
                  onChange={setFontName}
                />
                <OcrChoiceRow
                  label="Text size"
                  options={['system', '0.9×', '1.2×', '1.5×'] as const}
                  value={sizeName}
                  onChange={setSizeName}
                />
                <OcrChoiceRow
                  label="Line height"
                  options={['1.3', '1.5', '1.8'] as const}
                  value={lineName}
                  onChange={setLineName}
                />
                <OcrChoiceRow
                  label="Alignment"
                  options={['start', 'justify'] as const}
                  value={alignName}
                  onChange={setAlignName}
                />
                <OcrChoiceRow
                  label="Margins"
                  options={['narrow', 'normal', 'wide'] as const}
                  value={marginName}
                  onChange={setMarginName}
                />
                {doc.sections.some((s) => s.kind === 'page') ? (
                  <OcrChoiceRow
                    label="Pages"
                    options={['auto', 'text', 'image', 'imageAndText'] as const}
                    value={pageDisplay}
                    onChange={setPageDisplay}
                  />
                ) : null}
              </View>
            ) : null}

            {panel === 'search' ? (
              <View style={styles.panel}>
                <View style={styles.searchRow}>
                  <TextInput
                    testID="reader-search-input"
                    style={styles.searchInput}
                    value={query}
                    onChangeText={setQuery}
                    placeholder="Search the book"
                    placeholderTextColor="#94A3B8"
                    returnKeyType="search"
                    autoCapitalize="none"
                    autoCorrect={false}
                    onSubmitEditing={() => {
                      runSearch().catch(() => {});
                    }}
                  />
                  <ToolbarButton
                    id="reader-search-go"
                    label="Find"
                    onPress={() => {
                      runSearch().catch(() => {});
                    }}
                  />
                </View>
                <View style={styles.searchRow}>
                  <Text style={styles.searchCount} testID="reader-search-count">
                    {searching
                      ? 'Searching…'
                      : hits.length > 0
                      ? `${hitIndex + 1} / ${hits.length}${
                          hits.length >= MAX_HITS ? '+' : ''
                        }`
                      : query.trim()
                      ? 'No matches'
                      : 'Matches are highlighted in the text'}
                  </Text>
                  <ToolbarButton
                    id="reader-search-prev"
                    label="‹"
                    onPress={() => goToHit(-1)}
                  />
                  <ToolbarButton
                    id="reader-search-next"
                    label="›"
                    onPress={() => goToHit(1)}
                  />
                </View>
              </View>
            ) : null}

            <View
              style={[
                styles.readerBox,
                { height: readerHeight, backgroundColor: colors.background },
              ]}
            >
              <ReaderView
                ref={reader}
                testID="reader-view"
                document={doc}
                initialLocator={initialLocator}
                furthestLocator={furthest}
                theme={theme}
                inserts={inserts}
                renderInsert={renderInsert}
                highlights={highlights}
                pageDisplay={pageDisplay}
                style={styles.reader}
                onVisibleRangeChange={(r) => {
                  setChapterId(r.first.sectionId);
                  if (!r.settled) return;
                  setPosition(r.first);
                  savedPositions.set(doc.documentKey, {
                    at: { ...r.first, offset: r.firstOffset },
                    furthest: furthestRef.current,
                  });
                }}
                onFurthestPositionChange={(l) => {
                  furthestRef.current = l;
                  setFurthest(l);
                }}
                onSectionEnd={(e) =>
                  setFinished((s) =>
                    s.has(e.sectionId) ? s : new Set(s).add(e.sectionId)
                  )
                }
                onJump={(j) => setJumpBack(j.from)}
                onTap={({ blockId }) => {
                  select(blockId).catch(() => {});
                }}
                onError={(e) => setError(`${e.code}: ${e.message}`)}
              />
              {selected ? (
                <View style={styles.actionBar} testID="reader-selection-bar">
                  <Text style={styles.actionQuote} numberOfLines={1}>
                    {selected.quote}
                  </Text>
                  <View style={styles.actionButtons}>
                    <ActionButton
                      id="reader-mark"
                      label={
                        marks[selected.locator.blockId] ? 'Unmark' : 'Mark'
                      }
                      onPress={() => {
                        const { locator } = selected;
                        setMarks((m) => {
                          const next = { ...m };
                          if (next[locator.blockId])
                            delete next[locator.blockId];
                          else next[locator.blockId] = locator;
                          return next;
                        });
                        setSelected(null);
                      }}
                    />
                    <ActionButton
                      id="reader-note"
                      label="Add note"
                      onPress={() => {
                        const { locator, quote } = selected;
                        const now = new Date();
                        setNotes((all) => [
                          ...all,
                          {
                            key: `note:${now.getTime()}`,
                            blockId: locator.blockId,
                            sectionId: locator.sectionId,
                            quote:
                              quote.length > 140
                                ? `${quote.slice(0, 140)}…`
                                : quote,
                            time: now.toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            }),
                          },
                        ]);
                        setSelected(null);
                      }}
                    />
                    <ActionButton
                      id="reader-selection-close"
                      label="✕"
                      onPress={() => setSelected(null)}
                    />
                  </View>
                </View>
              ) : null}
            </View>

            <View style={styles.footer} testID="reader-footer">
              <View style={styles.footerRow}>
                <Text style={styles.footerChapter} numberOfLines={1}>
                  {chapter ? sectionTitle(chapter) : ' '}
                </Text>
                <Text style={styles.footerPercent}>
                  {Math.round(progress * 100)} %
                </Text>
              </View>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    {
                      width: `${Math.round(progress * 100)}%`,
                      backgroundColor: colors.accent,
                    },
                  ]}
                />
              </View>
              {jumpBack ? (
                <View style={styles.footerRow}>
                  <Pressable
                    testID="reader-jump-back"
                    accessibilityRole="button"
                    accessibilityLabel="Go back to where you were"
                    onPress={() => {
                      const target = jumpBack;
                      setJumpBack(null);
                      reader.current?.scrollTo(target);
                    }}
                    style={({ pressed }) => [
                      styles.chip,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.chipText} numberOfLines={1}>
                      ↩ Back to “
                      {sectionTitle(sectionsById.get(jumpBack.sectionId))}”
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Dismiss"
                    onPress={() => setJumpBack(null)}
                    style={({ pressed }) => [
                      styles.chipClose,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.chipCloseText}>✕</Text>
                  </Pressable>
                </View>
              ) : null}
              {notice ? <Text style={styles.notice}>{notice}</Text> : null}
            </View>
          </View>
        ) : null}

        {doc ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Try it</Text>
            <Hint text="Tap a paragraph to mark it or attach a note. Notes and the chapter-end cards are React Native views inside the native list (inserts)." />
            <Hint text="Contents jumps to a chapter with scrollTo(); a jump offers a way back (onJump)." />
            <Hint
              text={`“${GUIDE_TITLE}” is an app section: text that is not in the EPUB, added with insertSection().`}
            />
            <Hint text="Change the book and open this one again: it resumes at the last position (initialLocator, furthestLocator)." />
          </View>
        ) : null}
      </ScrollView>

      {doc ? (
        <Modal
          visible={showContents}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setShowContents(false)}
        >
          <SafeAreaView style={styles.container}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sectionTitle} numberOfLines={1}>
                {doc.metadata.title ?? label}
              </Text>
              <ToolbarButton
                id="reader-contents-done"
                label="Done"
                onPress={() => setShowContents(false)}
              />
            </View>
            <ScrollView contentContainerStyle={styles.content}>
              <Pressable
                testID="reader-toggle-guide"
                accessibilityRole="button"
                onPress={() => {
                  toggleGuide().catch(() => {});
                }}
                style={({ pressed }) => [
                  styles.guideRow,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.guideRowText}>
                  {hasGuide
                    ? `Remove the app section “${GUIDE_TITLE}”`
                    : `Insert the app section “${GUIDE_TITLE}”`}
                </Text>
              </Pressable>
              {doc.sections.map((s) => {
                const current = s.id === chapterId;
                return (
                  <Pressable
                    key={s.id}
                    testID={`reader-section-${s.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Go to ${sectionTitle(s)}`}
                    disabled={!s.firstBlockId}
                    onPress={() => {
                      setShowContents(false);
                      reader.current?.scrollTo({
                        sectionId: s.id,
                        blockId: s.firstBlockId,
                      });
                    }}
                    style={({ pressed }) => [
                      styles.sectionRow,
                      current && styles.sectionRowCurrent,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text
                      style={[
                        styles.sectionRowTitle,
                        current && styles.sectionRowTitleCurrent,
                      ]}
                      numberOfLines={1}
                    >
                      {finished.has(s.id) ? '✓ ' : ''}
                      {sectionTitle(s)}
                    </Text>
                    <Text style={styles.sectionRowMeta}>
                      {furthest?.sectionId === s.id ? 'Furthest read · ' : ''}
                      {s.origin === 'app'
                        ? 'App section'
                        : s.kind === 'image'
                        ? 'Image'
                        : `${s.blockCount} ${
                            s.blockCount === 1 ? 'block' : 'blocks'
                          }`}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </SafeAreaView>
        </Modal>
      ) : null}
      <ScreenIntroModal screenId="Reader" />
    </SafeAreaView>
  );
}

function guideSection(after: string) {
  return {
    after,
    id: GUIDE_ID,
    title: GUIDE_TITLE,
    blocks: [
      {
        key: 'title',
        type: 'heading' as const,
        level: 2,
        text: GUIDE_TITLE,
      },
      {
        key: 'p1',
        type: 'paragraph' as const,
        text: 'This section is not part of the EPUB. The app inserted it with insertSection(), for example for a preface, a reading guide or generated content.',
      },
      {
        key: 'p2',
        type: 'paragraph' as const,
        text: 'Its blocks have IDs like app:about.p1. Positions, events, highlights and inserts work here exactly as in the book’s own text. Remove it again from the contents.',
      },
    ],
  };
}

function describe(doc: ReaderDocument): string {
  const by = doc.metadata.creator ? ` · ${doc.metadata.creator}` : '';
  const files = doc.sections.filter((s) => s.origin === 'file').length;
  return `${doc.metadata.title ?? 'Untitled'}${by} — ${files} sections, ${
    doc.blockCount
  } blocks`;
}

function Hint({ text }: { text: string }) {
  return (
    <View style={styles.hintRow}>
      <Text style={styles.hintBullet}>•</Text>
      <Text style={styles.hintText}>{text}</Text>
    </View>
  );
}

function ToolbarButton({
  id,
  label,
  active = false,
  onPress,
}: {
  id: string;
  label: string;
  active?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.toolbarButton,
        active && styles.toolbarButtonActive,
        pressed && styles.pressed,
      ]}
    >
      <Text
        style={[
          styles.toolbarButtonText,
          active && styles.toolbarButtonTextActive,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function ActionButton({
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
      style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
    >
      <Text style={styles.actionButtonText}>{label}</Text>
    </Pressable>
  );
}
