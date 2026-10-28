import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import {
  DocVlmInitOptionChips,
  InitModeSelector,
  ModelFolderGrid,
  OcrCustomInitForm,
} from './modelInit';
import { getModelDisplayName } from '../modelConfig';
import { isVlmOcrPack } from '../utils/ocrModelCatalog';
import {
  OCR_MAX_THREADS,
  OCR_MAX_UNCLIP,
  OCR_MIN_THREADS,
  OCR_MIN_UNCLIP,
  clampOcrUnclipRatio,
  type useOcrModelInit,
} from '../hooks/useOcrModelInit';

type OcrInit = ReturnType<typeof useOcrModelInit>;

type Props = {
  ocr: OcrInit;
  title?: string;
  disabled?: boolean;
  showScatteredTest?: boolean;
  onSelectFolder?: (id: string) => void;
};

export function OcrModelInitPanel({
  ocr,
  title = 'OCR model',
  disabled = false,
  showScatteredTest = true,
  onSelectFolder,
}: Props) {
  const busy = disabled || ocr.initBusy;
  const [providerPickerOpen, setProviderPickerOpen] = useState(false);
  const unclipTrackWidthRef = useRef(0);

  const applyUnclipFromLocationX = useCallback(
    (locationX: number) => {
      if (busy) return;
      const width = unclipTrackWidthRef.current;
      if (width <= 0) return;
      const x = Math.max(0, Math.min(width, locationX));
      const t = x / width;
      ocr.setDetUnclipRatio(
        clampOcrUnclipRatio(
          OCR_MIN_UNCLIP + t * (OCR_MAX_UNCLIP - OCR_MIN_UNCLIP)
        )
      );
    },
    [busy, ocr]
  );

  const onUnclipTouch = useCallback(
    (event: GestureResponderEvent) => {
      applyUnclipFromLocationX(event.nativeEvent.locationX);
    },
    [applyUnclipFromLocationX]
  );

  const onUnclipSliderLayout = useCallback((event: LayoutChangeEvent) => {
    unclipTrackWidthRef.current = event.nativeEvent.layout.width;
  }, []);

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionHint}>
        Recommended start: ppocrv6-tiny (bundled assets or Download Manager →
        OCR).
      </Text>

      <View style={styles.sectionBody}>
        <InitModeSelector
          value={ocr.initMode}
          onChange={ocr.setInitMode}
          disabled={busy || ocr.fillLoading}
        />

        {ocr.initMode === 'auto' ? (
          <>
            <ModelFolderGrid
              entries={ocr.catalogEntries}
              selectedId={ocr.selectedFolder}
              initializedId={
                ocr.initializedFolder?.startsWith('custom:')
                  ? null
                  : ocr.initializedFolder
              }
              onSelect={(id) => {
                ocr.setSelectedFolder(id);
                onSelectFolder?.(id);
              }}
              loading={ocr.loadingModels}
              disabled={busy || ocr.fillLoading}
              emptyMessage="No OCR models found. Use bundled assets, PAD, or Download Manager → OCR."
            />
            {ocr.selectedFolder && isVlmOcrPack(ocr.selectedFolder) ? (
              <DocVlmInitOptionChips
                maxNewTokens={ocr.customInitForm.maxNewTokens}
                onChangeMaxNewTokens={(maxNewTokens) =>
                  ocr.setCustomInitForm((prev) => ({ ...prev, maxNewTokens }))
                }
                disabled={busy || ocr.fillLoading}
              />
            ) : null}
          </>
        ) : (
          <OcrCustomInitForm
            value={ocr.customInitForm}
            onChange={ocr.setCustomInitForm}
            selectedCatalogModelId={ocr.selectedFolder}
            onFillFromSelectedModel={() => {
              ocr.fillFromSelectedModel().catch(() => {});
            }}
            onPrepareScatteredTest={ocr.prepareScatteredTest}
            fillLoading={ocr.fillLoading}
            disabled={busy}
            showScatteredTest={showScatteredTest}
            fillHint={
              ocr.fillHint ??
              (ocr.selectedFolder
                ? `Fill can use last catalog selection: ${getModelDisplayName(
                    ocr.selectedFolder
                  )}`
                : 'Pick files per slot, or switch to Auto, select a pack, then return here and Fill.')
            }
          />
        )}

        <Text style={styles.fieldLabel}>numThreads</Text>
        <View style={styles.fieldControlRow}>
          <TouchableOpacity
            style={[
              styles.paramStepButton,
              (busy || ocr.numThreads <= OCR_MIN_THREADS) &&
                styles.paramStepButtonDisabled,
            ]}
            onPress={() =>
              ocr.setNumThreads((v) => Math.max(OCR_MIN_THREADS, v - 1))
            }
            disabled={busy || ocr.numThreads <= OCR_MIN_THREADS}
          >
            <Text style={styles.paramStepButtonText}>-</Text>
          </TouchableOpacity>
          <View style={styles.paramValueBadge}>
            <Text style={styles.paramValueText}>{ocr.numThreads}</Text>
          </View>
          <TouchableOpacity
            style={[
              styles.paramStepButton,
              (busy || ocr.numThreads >= OCR_MAX_THREADS) &&
                styles.paramStepButtonDisabled,
            ]}
            onPress={() =>
              ocr.setNumThreads((v) => Math.min(OCR_MAX_THREADS, v + 1))
            }
            disabled={busy || ocr.numThreads >= OCR_MAX_THREADS}
          >
            <Text style={styles.paramStepButtonText}>+</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.fieldLabel}>provider</Text>
        <TouchableOpacity
          style={[
            styles.providerSelect,
            (busy || ocr.providersLoading) && styles.providerSelectDisabled,
          ]}
          onPress={() => setProviderPickerOpen(true)}
          disabled={busy || ocr.providersLoading}
        >
          <Text style={styles.providerSelectValue}>
            {ocr.providersLoading ? 'Detecting…' : ocr.provider}
          </Text>
          <Text style={styles.providerSelectHint}>
            {ocr.providersLoading
              ? 'probing device'
              : `${ocr.providerOptions.length} available ▾`}
          </Text>
        </TouchableOpacity>

        <View style={styles.sliderHeader}>
          <Text style={styles.fieldLabel}>detUnclipRatio</Text>
          <Text style={styles.sliderValue}>
            {ocr.detUnclipRatio.toFixed(2)}
          </Text>
        </View>
        <Text style={styles.sectionHint}>
          Expands DB detection boxes for ppocr/doctr (1.0 tight … 2.5 loose).
          Default 1.5 — not glyph-perfect bounds. Re-init to apply.
        </Text>
        <View
          style={[styles.sliderTrack, busy && styles.sliderTrackDisabled]}
          onLayout={onUnclipSliderLayout}
          onStartShouldSetResponder={() => !busy}
          onMoveShouldSetResponder={() => !busy}
          onResponderTerminationRequest={() => false}
          onResponderGrant={onUnclipTouch}
          onResponderMove={onUnclipTouch}
        >
          <View style={styles.sliderRail} pointerEvents="none">
            <View
              style={[
                styles.sliderFill,
                {
                  width: `${
                    ((ocr.detUnclipRatio - OCR_MIN_UNCLIP) /
                      (OCR_MAX_UNCLIP - OCR_MIN_UNCLIP)) *
                    100
                  }%`,
                },
              ]}
            />
          </View>
          <View
            pointerEvents="none"
            style={[
              styles.sliderThumb,
              {
                left: `${
                  ((ocr.detUnclipRatio - OCR_MIN_UNCLIP) /
                    (OCR_MAX_UNCLIP - OCR_MIN_UNCLIP)) *
                  100
                }%`,
              },
            ]}
          />
        </View>
        <View style={styles.sliderLegend}>
          <Text style={styles.sliderLegendText}>
            {OCR_MIN_UNCLIP.toFixed(1)}
          </Text>
          <Text style={styles.sliderLegendText}>
            {OCR_MAX_UNCLIP.toFixed(1)}
          </Text>
        </View>

        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[
              styles.primaryButton,
              styles.actionButtonFlex,
              (busy ||
                ocr.fillLoading ||
                (ocr.initMode === 'auto' && !ocr.selectedFolder)) &&
                styles.primaryButtonDisabled,
            ]}
            onPress={() => {
              ocr.applySelectedModel().catch(() => {});
            }}
            disabled={
              busy ||
              ocr.fillLoading ||
              (ocr.initMode === 'auto' && !ocr.selectedFolder)
            }
          >
            {ocr.initBusy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.primaryButtonText}>
                {ocr.initializedFolder ? 'Re-initialize' : 'Initialize'}
              </Text>
            )}
          </TouchableOpacity>
          {ocr.initializedFolder ? (
            <TouchableOpacity
              style={[styles.secondaryButton, styles.actionButtonFlex]}
              onPress={() => {
                ocr.releaseEngine().catch(() => {});
              }}
              disabled={busy}
            >
              <Text style={styles.secondaryButtonText}>Destroy</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {ocr.initMessage || ocr.detectSummary ? (
          <View style={styles.statusCard}>
            {ocr.initMessage ? (
              <View style={styles.statusBlock}>
                <Text style={styles.statusLabel}>Engine</Text>
                <Text style={styles.mono}>{ocr.initMessage}</Text>
              </View>
            ) : null}
            {ocr.detectSummary ? (
              <View style={styles.statusBlock}>
                <Text style={styles.statusLabel}>Detect</Text>
                <Text style={styles.mono}>{ocr.detectSummary}</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {ocr.error ? <Text style={styles.errorText}>{ocr.error}</Text> : null}
      </View>

      <Modal
        visible={providerPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setProviderPickerOpen(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setProviderPickerOpen(false)}
        >
          <Pressable
            style={styles.modalSheet}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={styles.modalTitle}>Execution provider</Text>
            <Text style={styles.sectionHint}>
              Only providers compiled into this ORT build that also pass a
              device canInit probe.
            </Text>
            <ScrollView>
              {ocr.providerOptions.map((option) => {
                const active = option === ocr.provider;
                return (
                  <TouchableOpacity
                    key={option}
                    style={[styles.modalItem, active && styles.modalItemActive]}
                    onPress={() => {
                      ocr.setProvider(option);
                      setProviderPickerOpen(false);
                    }}
                  >
                    <Text
                      style={[
                        styles.modalItemText,
                        active && styles.modalItemTextActive,
                      ]}
                    >
                      {option}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 16,
    gap: 12,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111',
  },
  sectionHint: {
    fontSize: 13,
    color: '#64748b',
    lineHeight: 18,
  },
  sectionBody: {
    gap: 10,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
    marginTop: 4,
  },
  fieldControlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
  },
  paramValueBadge: {
    backgroundColor: '#F3F4F6',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    minWidth: 48,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  paramValueText: {
    fontSize: 14,
    fontFamily: 'Menlo',
    fontWeight: '700',
    color: '#111827',
  },
  paramStepButton: {
    backgroundColor: '#E5E7EB',
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  paramStepButtonDisabled: {
    opacity: 0.45,
  },
  paramStepButtonText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#374151',
    lineHeight: 20,
  },
  providerSelect: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#fff',
    minHeight: 44,
  },
  providerSelectDisabled: {
    opacity: 0.45,
  },
  providerSelectValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111',
    fontFamily: 'Menlo',
  },
  providerSelectHint: {
    fontSize: 12,
    color: '#64748b',
  },
  sliderHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  sliderValue: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'Menlo',
    color: '#1D4ED8',
  },
  sliderTrack: {
    height: 28,
    justifyContent: 'center',
    position: 'relative',
  },
  sliderTrackDisabled: {
    opacity: 0.45,
  },
  sliderRail: {
    height: 6,
    borderRadius: 3,
    backgroundColor: '#E5E7EB',
    overflow: 'hidden',
  },
  sliderFill: {
    height: 6,
    backgroundColor: '#007AFF',
  },
  sliderThumb: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#007AFF',
    marginLeft: -10,
    top: 4,
  },
  sliderLegend: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  sliderLegendText: {
    fontSize: 11,
    color: '#94A3B8',
    fontFamily: 'Menlo',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 10,
    marginTop: 4,
  },
  actionButtonFlex: {
    flex: 1,
  },
  primaryButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  primaryButtonDisabled: {
    backgroundColor: '#94a3b8',
  },
  primaryButtonText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 16,
  },
  secondaryButton: {
    backgroundColor: '#FEE2E2',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  secondaryButtonText: {
    color: '#B91C1C',
    fontWeight: '700',
    fontSize: 15,
  },
  statusCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 12,
    gap: 10,
  },
  statusBlock: {
    gap: 4,
  },
  statusLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748B',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  mono: {
    fontFamily: 'Menlo',
    fontSize: 12,
    color: '#334155',
    lineHeight: 17,
  },
  errorText: {
    color: '#c00',
    fontSize: 13,
    lineHeight: 18,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 28,
    maxHeight: '55%',
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111',
    marginBottom: 12,
  },
  modalItem: {
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
  },
  modalItemActive: {
    backgroundColor: '#E8F1FF',
    marginHorizontal: -8,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  modalItemText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#334155',
    fontFamily: 'Menlo',
  },
  modalItemTextActive: {
    color: '#007AFF',
  },
});
