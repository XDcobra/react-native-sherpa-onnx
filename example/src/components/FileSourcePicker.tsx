import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { fileSourcePickerStyles as s } from './FileSourcePicker.styles';

export type FileSourceKind = 'example' | 'own';

export type FileSourcePickerListArgs = {
  disabled: boolean;
  /** Call after a successful pick so the list collapses. */
  collapse: () => void;
};

type Props = {
  disabled?: boolean;
  /** When set, the example/own lists collapse to this row. */
  selectedLabel?: string | null;
  selectedDescription?: string | null;
  exampleButtonLabel?: string;
  ownButtonLabel?: string;
  ownPickButtonLabel?: string;
  exampleListTitle?: string;
  changeButtonLabel?: string;
  /**
   * When false, a selection only hides the lists (parent shows its own
   * selected-file chrome). Default true.
   */
  showSelectedCard?: boolean;
  onPickOwn: () => void;
  /** Extra control on the collapsed selected-file row (e.g. delete). */
  selectedAccessory?: ReactNode;
  renderExampleList: (args: FileSourcePickerListArgs) => ReactNode;
};

/**
 * Shared Example / Own file picker. After a file is selected the long list
 * collapses to the current name plus Change (or stays hidden if the parent
 * already shows a ready card).
 */
export function FileSourcePicker({
  disabled = false,
  selectedLabel = null,
  selectedDescription = null,
  exampleButtonLabel = 'Example files',
  ownButtonLabel = 'Pick your own',
  ownPickButtonLabel = 'Pick a file…',
  exampleListTitle = 'Choose an example',
  changeButtonLabel = 'Change',
  showSelectedCard = true,
  onPickOwn,
  selectedAccessory = null,
  renderExampleList,
}: Props) {
  const [kind, setKind] = useState<FileSourceKind | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const hadSelectionRef = useRef(false);

  const hasSelection = Boolean(selectedLabel);

  useEffect(() => {
    if (hadSelectionRef.current && !selectedLabel) {
      setKind(null);
      setBrowsing(false);
    }
    if (selectedLabel) {
      setBrowsing(false);
    }
    hadSelectionRef.current = Boolean(selectedLabel);
  }, [selectedLabel]);

  const collapse = () => {
    setBrowsing(false);
  };

  const openChange = () => {
    setBrowsing(true);
    if (kind == null) {
      setKind('example');
    }
  };

  const goBack = () => {
    // Example list / own pick → Example | Own. Do not collapse onto the
    // previous file; that blocked switching to a custom document.
    setKind(null);
  };

  const cancelChange = () => {
    setBrowsing(false);
  };

  if (hasSelection && !browsing) {
    if (!showSelectedCard) {
      return null;
    }
    return (
      <View style={s.selectedCard}>
        <View style={s.selectedTextWrap}>
          <Text style={s.selectedLabel} numberOfLines={2}>
            {selectedLabel}
          </Text>
          {selectedDescription ? (
            <Text style={s.selectedDescription} numberOfLines={2}>
              {selectedDescription}
            </Text>
          ) : null}
        </View>
        <View style={s.selectedActions}>
          <TouchableOpacity
            style={[s.changeButton, disabled && s.disabled]}
            onPress={openChange}
            disabled={disabled}
            accessibilityLabel={changeButtonLabel}
          >
            <Text style={s.changeButtonText}>{changeButtonLabel}</Text>
          </TouchableOpacity>
          {selectedAccessory}
        </View>
      </View>
    );
  }

  if (kind == null) {
    return (
      <View style={s.browse}>
        {hasSelection ? (
          <View style={s.actionRow}>
            <TouchableOpacity
              style={[s.backButton, disabled && s.disabled]}
              onPress={cancelChange}
              disabled={disabled}
              accessibilityLabel="Back"
            >
              <Ionicons name="chevron-back" size={22} color="#007AFF" />
            </TouchableOpacity>
            <Text style={s.listTitle}>Change document</Text>
          </View>
        ) : null}
        <View style={s.choiceRow}>
          <TouchableOpacity
            style={[s.choiceButton, disabled && s.choiceButtonDisabled]}
            onPress={() => setKind('example')}
            disabled={disabled}
          >
            <Text style={s.choiceButtonText}>{exampleButtonLabel}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.choiceButton, disabled && s.choiceButtonDisabled]}
            onPress={() => {
              setKind('own');
              onPickOwn();
            }}
            disabled={disabled}
          >
            <Text style={s.choiceButtonText}>{ownButtonLabel}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (kind === 'example') {
    return (
      <View style={s.browse}>
        <View style={s.actionRow}>
          <TouchableOpacity
            style={[s.backButton, disabled && s.disabled]}
            onPress={goBack}
            disabled={disabled}
            accessibilityLabel="Back"
          >
            <Ionicons name="chevron-back" size={22} color="#007AFF" />
          </TouchableOpacity>
          <Text style={s.listTitle}>{exampleListTitle}</Text>
        </View>
        {renderExampleList({ disabled, collapse })}
      </View>
    );
  }

  return (
    <View style={s.actionRow}>
      <TouchableOpacity
        style={[s.backButton, disabled && s.disabled]}
        onPress={goBack}
        disabled={disabled}
        accessibilityLabel="Back"
      >
        <Ionicons name="chevron-back" size={22} color="#007AFF" />
      </TouchableOpacity>
      <TouchableOpacity
        style={[s.choiceButton, disabled && s.choiceButtonDisabled]}
        onPress={onPickOwn}
        disabled={disabled}
      >
        <Text style={s.choiceButtonText}>{ownPickButtonLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}
