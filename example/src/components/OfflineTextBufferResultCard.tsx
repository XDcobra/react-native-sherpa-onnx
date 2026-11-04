/**
 * Shared OfflineTextBuffer result UI: text + optional meta/expanders/JSON + buffer list.
 * Used by STT (full) and Punctuation / Showcase / VideoOcr (text-only flags).
 */

import { useState } from 'react';
import {
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import type { OfflineTextBufferSnapshot } from '../utils/readOfflineTextBufferSnapshot';

export type OfflineTextBufferResultCardProps = {
  result: OfflineTextBufferSnapshot | null;
  buffers?: OfflineTextBufferSnapshot[];
  onSelectBuffer?: (bufferId: string) => void;
  onRemoveBuffer?: (bufferId: string) => void;
  title?: string;
  hint?: string | null;
  textLabel?: string;
  showExpanders?: boolean;
  showMeta?: boolean;
  showJsonExport?: boolean;
  showBufferList?: boolean;
};

export function OfflineTextBufferResultCard({
  result,
  buffers,
  onSelectBuffer,
  onRemoveBuffer,
  title = 'Result',
  hint = null,
  textLabel = 'Transcription:',
  showExpanders = true,
  showMeta = true,
  showJsonExport = true,
  showBufferList,
}: OfflineTextBufferResultCardProps) {
  const [tokensExpanded, setTokensExpanded] = useState(false);
  const [timestampsExpanded, setTimestampsExpanded] = useState(false);
  const [durationsExpanded, setDurationsExpanded] = useState(false);

  const list = buffers ?? [];
  const showList = showBufferList ?? list.length > 0;

  const copyJson = () => {
    if (!result) return;
    Clipboard.setString(JSON.stringify(result, null, 2));
  };

  const shareJson = () => {
    if (!result) return;
    Share.share({
      message: JSON.stringify(result, null, 2),
      title: 'Export all as JSON',
    }).catch(() => {});
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}

      <View style={styles.resultSection}>
        {result ? (
          <>
            <View style={styles.resultLabelRow}>
              <Text style={styles.resultLabel}>{textLabel}</Text>
              <View style={styles.resultLabelActions}>
                <TouchableOpacity
                  style={styles.copyIconButton}
                  onPress={() => {
                    const t = result.text ?? '';
                    if (t) Clipboard.setString(t);
                  }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="copy-outline" size={20} color="#2e7d32" />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.copyIconButton}
                  onPress={() => {
                    const t = result.text ?? '';
                    if (t) {
                      Share.share({
                        message: t,
                        title: textLabel.replace(/:$/, '') || 'Text',
                      }).catch(() => {});
                    }
                  }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="share-outline" size={20} color="#2e7d32" />
                </TouchableOpacity>
                {onRemoveBuffer && result.bufferId ? (
                  <TouchableOpacity
                    style={styles.copyIconButton}
                    onPress={() => {
                      onRemoveBuffer(result.bufferId);
                    }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons name="trash-outline" size={20} color="#b71c1c" />
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
            <Text style={styles.resultText} selectable>
              {result.text ?? ''}
            </Text>

            {showMeta && (result.lang || result.emotion || result.event) ? (
              <View style={styles.metaRow}>
                {result.lang ? (
                  <Text style={styles.metaText}>Lang: {result.lang}</Text>
                ) : null}
                {result.emotion ? (
                  <Text style={styles.metaText}>Emotion: {result.emotion}</Text>
                ) : null}
                {result.event ? (
                  <Text style={styles.metaText}>Event: {result.event}</Text>
                ) : null}
              </View>
            ) : null}

            {showExpanders ? (
              <>
                <ExpandableArray
                  title="Tokens"
                  items={result.tokens}
                  expanded={tokensExpanded}
                  onToggle={() => setTokensExpanded((e) => !e)}
                  renderJoined
                />
                <ExpandableArray
                  title="Timestamps"
                  items={result.timestamps}
                  expanded={timestampsExpanded}
                  onToggle={() => setTimestampsExpanded((e) => !e)}
                />
                <ExpandableArray
                  title="Durations"
                  items={result.durations}
                  expanded={durationsExpanded}
                  onToggle={() => setDurationsExpanded((e) => !e)}
                />
              </>
            ) : null}

            {showJsonExport ? (
              <View style={styles.resultButtonRow}>
                <TouchableOpacity
                  style={styles.resultActionButton}
                  onPress={copyJson}
                >
                  <Ionicons
                    name="copy-outline"
                    size={18}
                    color="#2e7d32"
                    style={styles.resultActionIcon}
                  />
                  <Text style={styles.resultActionText}>Copy all as JSON</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.resultActionButton}
                  onPress={shareJson}
                >
                  <Ionicons
                    name="document-text-outline"
                    size={18}
                    color="#2e7d32"
                    style={styles.resultActionIcon}
                  />
                  <Text style={styles.resultActionText}>
                    Export all as JSON
                  </Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </>
        ) : (
          <Text style={styles.placeholder}>No active result selected.</Text>
        )}
      </View>

      {showList ? (
        <View style={styles.textBufferList}>
          <Text style={styles.textBufferListTitle}>
            Active OfflineTextBuffer
          </Text>
          {list.map((item) => (
            <View key={item.bufferId} style={styles.textBufferItem}>
              <View style={styles.textBufferItemHeader}>
                <TouchableOpacity
                  style={styles.flex1}
                  onPress={() => onSelectBuffer?.(item.bufferId)}
                  disabled={!onSelectBuffer}
                >
                  <Text style={styles.textBufferItemLabel}>
                    {item.text?.trim()
                      ? item.text.trim().slice(0, 64)
                      : 'Empty transcription'}
                  </Text>
                </TouchableOpacity>
                {onRemoveBuffer ? (
                  <TouchableOpacity
                    style={styles.copyIconButton}
                    onPress={() => onRemoveBuffer(item.bufferId)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons name="trash-outline" size={18} color="#b71c1c" />
                  </TouchableOpacity>
                ) : null}
              </View>
              <Text style={styles.bufferIdText} selectable>
                {item.bufferId}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ExpandableArray({
  title,
  items,
  expanded,
  onToggle,
  renderJoined = false,
}: {
  title: string;
  items: Array<string | number>;
  expanded: boolean;
  onToggle: () => void;
  renderJoined?: boolean;
}) {
  const arr = items ?? [];
  return (
    <>
      <TouchableOpacity style={styles.expandHeader} onPress={onToggle}>
        <Ionicons
          name={expanded ? 'chevron-down' : 'chevron-forward'}
          size={18}
          color="#2e7d32"
        />
        <Text style={styles.expandHeaderText}>
          {title} ({arr.length})
        </Text>
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.expandContent}>
          <View style={styles.expandActionRow}>
            <TouchableOpacity
              style={styles.expandActionBtn}
              onPress={() => {
                Clipboard.setString(
                  Array.isArray(arr) ? JSON.stringify(arr) : String(arr)
                );
              }}
            >
              <Ionicons
                name="copy-outline"
                size={18}
                color="#2e7d32"
                style={styles.expandActionIcon}
              />
              <Text style={styles.expandActionLabel}>Copy</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.expandActionBtn}
              onPress={() => {
                const str = Array.isArray(arr)
                  ? JSON.stringify(arr)
                  : String(arr);
                Share.share({ message: str, title }).catch(() => {});
              }}
            >
              <Ionicons
                name="share-outline"
                size={18}
                color="#2e7d32"
                style={styles.expandActionIcon}
              />
              <Text style={styles.expandActionLabel}>Share</Text>
            </TouchableOpacity>
          </View>
          {renderJoined ? (
            <Text style={styles.expandListItem}>
              {arr.map(String).join(', ')}
            </Text>
          ) : arr.length > 0 ? (
            <ScrollView
              style={styles.expandListWrap}
              nestedScrollEnabled
              showsVerticalScrollIndicator
            >
              {arr.map((item, i) => (
                <Text key={`${title}-${i}`} style={styles.expandListItem}>
                  [{String(item)}]
                </Text>
              ))}
            </ScrollView>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  section: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 8,
  },
  hint: {
    fontSize: 14,
    color: '#8E8E93',
    marginBottom: 12,
  },
  resultSection: {
    marginTop: 4,
  },
  resultLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  resultLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2e7d32',
  },
  resultLabelActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  copyIconButton: {
    padding: 4,
  },
  resultText: {
    fontSize: 15,
    color: '#000000',
    lineHeight: 22,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 10,
  },
  metaText: {
    fontSize: 13,
    color: '#555555',
  },
  expandHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    gap: 6,
  },
  expandHeaderText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2e7d32',
  },
  expandContent: {
    marginTop: 8,
    backgroundColor: '#F5F5F5',
    borderRadius: 8,
    padding: 10,
  },
  expandActionRow: {
    flexDirection: 'row',
    gap: 16,
    marginBottom: 8,
  },
  expandActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  expandActionIcon: {
    marginRight: 4,
  },
  expandActionLabel: {
    fontSize: 13,
    color: '#2e7d32',
    fontWeight: '500',
  },
  expandListWrap: {
    maxHeight: 160,
  },
  expandListItem: {
    fontSize: 13,
    color: '#333333',
    marginBottom: 2,
  },
  resultButtonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 14,
  },
  resultActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#E8F5E9',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  resultActionIcon: {
    marginRight: 6,
  },
  resultActionText: {
    fontSize: 13,
    color: '#2e7d32',
    fontWeight: '600',
  },
  placeholder: {
    fontSize: 14,
    color: '#8E8E93',
    fontStyle: 'italic',
  },
  textBufferList: {
    marginTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#C7C7CC',
    paddingTop: 12,
  },
  textBufferListTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 8,
  },
  textBufferItem: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
  textBufferItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  flex1: {
    flex: 1,
  },
  textBufferItemLabel: {
    fontSize: 14,
    color: '#000000',
  },
  bufferIdText: {
    marginTop: 4,
    fontSize: 11,
    color: '#8E8E93',
    fontFamily: 'Menlo',
  },
});
