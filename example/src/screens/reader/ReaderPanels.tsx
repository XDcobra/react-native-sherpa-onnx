import { useEffect } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import type { OcrFamily } from 'react-native-sherpa-onnx/ocr';

import type { useOcrModelInit } from '../../hooks/useOcrModelInit';
import type { useTtsModelInit } from '../../hooks/useTtsModelInit';
import { inferOcrFamilyFromFolder } from '../../utils/ocrModelCatalog';
import { panelStyles as s } from './ReaderPanels.styles';

type OcrInit = ReturnType<typeof useOcrModelInit>;
type TtsInit = ReturnType<typeof useTtsModelInit>;

export type PanelStatus = { text: string; error?: boolean } | null;

/** Which pages to recognize: the visible one (again), around it, or all. */
export type OcrScope = 'page' | 'around' | 'all';

const SCOPE_HINT: Record<OcrScope, string> = {
  page: 'The page at the top of the view, recognized again even when it has text (compare models).',
  around:
    'The page at the top of the view, two pages after it and one before; pages with text are skipped.',
  all: 'Every page from the first; pages with text are skipped. Stop keeps the pages done.',
};

/** What the reader gets from each OCR model family. */
const FAMILY_RESULT: Record<OcrFamily, { name: string; result: string }> = {
  ppocr: {
    name: 'PP-OCR',
    result:
      'Lines with their place on the page. Paragraphs come from the layout; highlights on the page image follow the line. Small and fast.',
  },
  doctr: {
    name: 'docTR',
    result:
      'Lines with their place on the page. Paragraphs come from the layout; highlights on the page image follow the line.',
  },
  doc_vlm: {
    name: 'Document VLM',
    result:
      'Layout elements: titles and section headers become headings, running headers and page numbers are hidden, each element keeps its place on the page. Large and slower. The fp32 pack reads best; q8 is faster but can repeat a line; fp16 and q4f16 currently return no text.',
  },
  nemotron_parse: {
    name: 'Nemotron Parse',
    result:
      'Markdown: headings and paragraphs. No places on the page, so highlights cover the whole page. Large.',
  },
  paddleocr_vl: {
    name: 'PaddleOCR-VL',
    result:
      'Task Text: paragraphs without places on the page, so highlights cover the whole page. Task Spotting: lines with their places, like PP-OCR. Large.',
  },
};

function Button({
  id,
  label,
  kind = 'primary',
  disabled = false,
  busy = false,
  onPress,
}: {
  id: string;
  label: string;
  kind?: 'primary' | 'secondary' | 'quiet';
  disabled?: boolean;
  busy?: boolean;
  onPress: () => void;
}) {
  const box =
    kind === 'primary'
      ? s.primary
      : kind === 'secondary'
      ? s.secondary
      : s.quiet;
  const text =
    kind === 'primary'
      ? s.primaryText
      : kind === 'secondary'
      ? s.secondaryText
      : s.quietText;
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        box,
        disabled && s.disabled,
        pressed && s.pressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={kind === 'primary' ? '#FFFFFF' : '#2563EB'} />
      ) : (
        <Text style={text}>{label}</Text>
      )}
    </Pressable>
  );
}

/** A wrapping row of model chips; the loaded model has a green dot. */
function ModelChips({
  idPrefix,
  entries,
  selected,
  loaded,
  disabled,
  onSelect,
}: {
  idPrefix: string;
  entries: ReadonlyArray<{ id: string; label: string }>;
  selected: string | null;
  loaded: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <View style={s.chips}>
      {entries.map((e) => {
        const active = e.id === selected;
        return (
          <Pressable
            key={e.id}
            testID={`${idPrefix}-${e.id}`}
            accessibilityRole="button"
            accessibilityLabel={e.label}
            accessibilityState={{ selected: active, disabled }}
            disabled={disabled}
            onPress={() => onSelect(e.id)}
            style={({ pressed }) => [
              s.chip,
              active && s.chipActive,
              disabled && s.disabled,
              pressed && s.pressed,
            ]}
          >
            {e.id === loaded ? <View style={s.readyDot} /> : null}
            <Text style={[s.chipText, active && s.chipTextActive]}>
              {e.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A labelled single choice as chips. */
function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
  format,
  disabled = false,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  format: (v: T) => string;
  disabled?: boolean;
}) {
  return (
    <View style={s.group}>
      <Text style={s.label}>{label}</Text>
      <View style={s.chips}>
        {options.map((o) => {
          const active = o === value;
          return (
            <Pressable
              key={o}
              accessibilityRole="button"
              accessibilityLabel={format(o)}
              accessibilityState={{ selected: active, disabled }}
              disabled={disabled}
              onPress={() => onChange(o)}
              style={({ pressed }) => [
                s.chip,
                active && s.chipActive,
                disabled && s.disabled,
                pressed && s.pressed,
              ]}
            >
              <Text style={[s.chipText, active && s.chipTextActive]}>
                {format(o)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** The public API calls behind a panel. */
function ApiNote({ lines }: { lines: string[] }) {
  return (
    <View style={s.api}>
      <Text style={s.apiLabel}>API</Text>
      {lines.map((l) => (
        <Text key={l} style={s.apiLine}>
          {l}
        </Text>
      ))}
    </View>
  );
}

function Status({ status }: { status: PanelStatus }) {
  if (!status) return null;
  return (
    <Text
      style={[s.status, status.error && s.statusError]}
      testID="reader-panel-status"
    >
      {status.text}
    </Text>
  );
}

// ---------------------------------------------------------------------------

export function ReaderOcrPanel({
  ocr,
  pages,
  direction,
  onDirection,
  paddleTask,
  onPaddleTask,
  busy,
  progress,
  status,
  scope,
  onScope,
  onRecognize,
  onStop,
  onSave,
  onLoad,
}: {
  ocr: OcrInit;
  /** Page and image-only sections, and how many of them have text. */
  pages: { total: number; withText: number };
  direction: 'ltr' | 'rtl';
  onDirection: (d: 'ltr' | 'rtl') => void;
  /** PaddleOCR-VL task: Markdown text, or lines with their places. */
  paddleTask: 'ocr' | 'spotting';
  onPaddleTask: (t: 'ocr' | 'spotting') => void;
  busy: boolean;
  progress: { done: number; total: number } | null;
  status: PanelStatus;
  scope: OcrScope;
  onScope: (scope: OcrScope) => void;
  onRecognize: () => void;
  onStop: () => void;
  onSave: () => void;
  onLoad: () => void;
}) {
  const family = ocr.selectedFolder
    ? inferOcrFamilyFromFolder(ocr.selectedFolder)
    : null;
  const info = family ? FAMILY_RESULT[family] : null;
  const loaded = ocr.initializedFolder;
  const selectedIsLoaded = loaded != null && loaded === ocr.selectedFolder;
  const allDone = pages.total > 0 && pages.withText >= pages.total;
  const fraction =
    progress && progress.total > 0 ? progress.done / progress.total : 0;

  return (
    <View style={s.card} testID="reader-ocr-panel">
      <View style={s.header}>
        <Text style={s.title}>Text from page images</Text>
        <View style={[s.badge, allDone && s.badgeDone]}>
          <Text
            style={[s.badgeText, allDone && s.badgeDoneText]}
            testID="reader-ocr-coverage"
          >
            {pages.withText} / {pages.total} pages with text
          </Text>
        </View>
      </View>
      <Text style={s.lead}>
        Scanned pages and comics have no text layer. An OCR model reads them
        page by page around the reading position, or the whole book; the text is
        shown, searched and read aloud like any other text.
      </Text>

      <View style={s.group}>
        <Text style={s.label}>Model</Text>
        {ocr.loadingModels ? (
          <ActivityIndicator />
        ) : ocr.catalogEntries.length === 0 ? (
          <Text style={s.caption}>
            No OCR model yet. Download one in Models → OCR (ppocrv6-tiny is
            small and fast).
          </Text>
        ) : (
          <ModelChips
            idPrefix="reader-ocr-model"
            entries={ocr.catalogEntries}
            selected={ocr.selectedFolder}
            loaded={loaded}
            disabled={busy || ocr.initBusy}
            onSelect={ocr.setSelectedFolder}
          />
        )}
        {info ? (
          <Text style={s.caption}>
            <Text style={s.captionStrong}>{info.name}: </Text>
            {info.result}
          </Text>
        ) : null}
        {selectedIsLoaded ? (
          <View style={s.ready}>
            <View style={s.readyDot} />
            <Text style={s.readyText}>Model loaded</Text>
          </View>
        ) : (
          <View style={s.row}>
            <Button
              id="reader-ocr-load-model"
              label={loaded ? 'Switch to this model' : 'Load model'}
              kind="secondary"
              busy={ocr.initBusy}
              disabled={!ocr.selectedFolder || busy}
              onPress={() => {
                ocr.applySelectedModel().catch(() => {});
              }}
            />
          </View>
        )}
        {ocr.error ? (
          <Text style={[s.status, s.statusError]}>{ocr.error}</Text>
        ) : null}
      </View>

      <Choice
        label="Reading order"
        options={['ltr', 'rtl'] as const}
        value={direction}
        onChange={onDirection}
        disabled={busy}
        format={(d) =>
          d === 'ltr' ? 'Left to right' : 'Right to left (manga)'
        }
      />

      {family === 'paddleocr_vl' ? (
        <Choice
          label="PaddleOCR-VL task"
          options={['ocr', 'spotting'] as const}
          value={paddleTask}
          onChange={onPaddleTask}
          disabled={busy}
          format={(t) => (t === 'ocr' ? 'Text' : 'Spotting')}
        />
      ) : null}

      <Choice
        label="Pages"
        options={['page', 'around', 'all'] as const}
        value={scope}
        onChange={onScope}
        disabled={busy}
        format={(v) =>
          v === 'page'
            ? 'This page'
            : v === 'around'
            ? 'Around here'
            : 'Whole book'
        }
      />
      <Text style={s.caption}>{SCOPE_HINT[scope]}</Text>
      <View style={s.row}>
        <Button
          id="reader-ocr-recognize"
          label="Recognize"
          disabled={!loaded || busy || (scope !== 'page' && allDone)}
          onPress={onRecognize}
        />
      </View>
      {busy ? (
        <View style={s.row}>
          <View style={s.progressTrack}>
            <View
              style={[
                s.progressFill,
                { width: `${Math.round(fraction * 100)}%` },
              ]}
            />
          </View>
          <Text style={s.progressText} testID="reader-ocr-progress">
            {progress ? `${progress.done} / ${progress.total}` : '…'}
          </Text>
          <Button
            id="reader-ocr-stop"
            label="Stop"
            kind="quiet"
            onPress={onStop}
          />
        </View>
      ) : null}
      <Status status={status} />

      <View style={s.divider} />
      <View style={s.group}>
        <Text style={s.label}>Keep the text</Text>
        <Text style={s.caption}>
          Save the recognized pages next to the book and load them in a later
          session: the pages have their text again without OCR.
        </Text>
        <View style={s.row}>
          <Button
            id="reader-ocr-save"
            label="Save"
            kind="quiet"
            disabled={busy || pages.withText === 0}
            onPress={onSave}
          />
          <Button
            id="reader-ocr-load"
            label="Load saved text"
            kind="quiet"
            disabled={busy}
            onPress={onLoad}
          />
        </View>
      </View>

      <ApiNote
        lines={[
          "recognizeReaderPages(doc, ocr, { scope: 'around', at })",
          "scope: { sections: ['s4'] }, force: true",
          "recognize: { readingDirection: 'rtl' }",
          "recognize: { instruction: { task: 'spotting' } } // paddleocr_vl",
          'saveReaderRecognition(doc, file) / loadReaderRecognition(doc, file)',
        ]}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------

export function ReaderListenPanel({
  tts,
  playing,
  busy,
  startsAt,
  show,
  onShow,
  follow,
  onFollow,
  status,
  onPlay,
  onStop,
}: {
  tts: TtsInit;
  playing: boolean;
  busy: boolean;
  /** Where reading starts, for the caption. */
  startsAt: string;
  show: 'sentence' | 'word' | 'both';
  onShow: (v: 'sentence' | 'word' | 'both') => void;
  follow: 'keepVisible' | 'center' | 'off';
  onFollow: (v: 'keepVisible' | 'center' | 'off') => void;
  status: PanelStatus;
  onPlay: () => void;
  onStop: () => void;
}) {
  const { catalogEntries, selectedModelForInit, setSelectedModelForInit } = tts;
  const loaded = tts.currentModelFolder;
  const selected = selectedModelForInit ?? loaded;
  // Preselect the first voice.
  useEffect(() => {
    if (!selectedModelForInit && !loaded && catalogEntries[0]) {
      setSelectedModelForInit(catalogEntries[0].id);
    }
  }, [catalogEntries, loaded, selectedModelForInit, setSelectedModelForInit]);
  const selectedIsLoaded = loaded != null && loaded === selected;

  return (
    <View style={s.card} testID="reader-listen-panel">
      <View style={s.header}>
        <Text style={s.title}>Read aloud</Text>
      </View>
      <Text style={s.lead}>
        Any book the reader shows can be read aloud: EPUB, FB2, MOBI, PDF and
        OCR text, across page breaks. The spoken sentence and word are
        highlighted and kept in view; on page images the highlight is drawn over
        the page.
      </Text>

      <View style={s.group}>
        <Text style={s.label}>Voice</Text>
        {tts.loadingModels ? (
          <ActivityIndicator />
        ) : catalogEntries.length === 0 ? (
          <Text style={s.caption}>
            No voice yet. Download one in Models → TTS (for example a Piper
            voice).
          </Text>
        ) : (
          <ModelChips
            idPrefix="reader-voice"
            entries={catalogEntries}
            selected={selected}
            loaded={loaded}
            disabled={playing || tts.loading}
            onSelect={setSelectedModelForInit}
          />
        )}
        {selectedIsLoaded ? (
          <View style={s.ready}>
            <View style={s.readyDot} />
            <Text style={s.readyText}>Voice loaded</Text>
          </View>
        ) : (
          <View style={s.row}>
            <Button
              id="reader-voice-load"
              label={loaded ? 'Switch to this voice' : 'Load voice'}
              kind="secondary"
              busy={tts.loading}
              disabled={!selected || playing}
              onPress={() => {
                Promise.resolve(tts.applySelectedModel()).catch(() => {});
              }}
            />
          </View>
        )}
        {tts.error ? (
          <Text style={[s.status, s.statusError]}>{tts.error}</Text>
        ) : null}
      </View>

      <View style={s.row}>
        <Button
          id="reader-listen-play"
          label={playing ? 'Restart here' : 'Play'}
          busy={busy}
          disabled={!loaded}
          onPress={onPlay}
        />
        {playing ? (
          <Button
            id="reader-listen-stop"
            label="Stop"
            kind="secondary"
            onPress={onStop}
          />
        ) : null}
      </View>
      <Text style={s.caption}>{startsAt}</Text>
      <Status status={status} />

      <Choice
        label="Highlight"
        options={['both', 'sentence', 'word'] as const}
        value={show}
        onChange={onShow}
        format={(v) =>
          v === 'both'
            ? 'Sentence and word'
            : v === 'word'
            ? 'Word'
            : 'Sentence'
        }
      />
      <Choice
        label="Follow"
        options={['keepVisible', 'center', 'off'] as const}
        value={follow}
        onChange={onFollow}
        format={(v) =>
          v === 'keepVisible'
            ? 'Keep in view'
            : v === 'center'
            ? 'Center'
            : 'Off'
        }
      />

      <ApiNote
        lines={[
          'const slice = await createReaderTextSlice(doc, { from })',
          'tts.synthesize(slice.buffer, audio, { timeline: true })',
          'createReadAloudTimeline(doc, { slice, tts: result.timeline })',
          'useReadAloudHighlights(timeline, positionMs)',
        ]}
      />
    </View>
  );
}
