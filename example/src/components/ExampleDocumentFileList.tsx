import { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { DocumentFileInfo } from '../documentConfig';

type Props = {
  files: DocumentFileInfo[];
  selectedId?: string | null;
  onSelect: (file: DocumentFileInfo) => void;
  disabled?: boolean;
};

export function ExampleDocumentFileList({
  files,
  selectedId = null,
  onSelect,
  disabled = false,
}: Props) {
  const sections = useMemo(() => {
    const hasSections = files.some((file) => !!file.section);
    if (!hasSections) {
      return [{ title: null as string | null, files }];
    }
    const groups: { title: string | null; files: DocumentFileInfo[] }[] = [];
    for (const file of files) {
      const title = file.section ?? null;
      const last = groups[groups.length - 1];
      if (last && last.title === title) {
        last.files.push(file);
      } else {
        groups.push({ title, files: [file] });
      }
    }
    return groups;
  }, [files]);

  if (files.length === 0) {
    return <Text style={styles.empty}>No example documents available.</Text>;
  }

  return (
    <View style={styles.container}>
      {sections.map((section, sectionIndex) => (
        <View
          key={section.title ?? `section-${sectionIndex}`}
          style={styles.section}
        >
          {section.title ? (
            <Text style={styles.sectionTitle}>{section.title}</Text>
          ) : null}
          {section.files.map((file) => {
            const isSelected = selectedId != null && selectedId === file.id;
            return (
              <TouchableOpacity
                key={file.id}
                style={[
                  styles.button,
                  isSelected && styles.buttonActive,
                  disabled && styles.buttonDisabled,
                ]}
                onPress={() => onSelect(file)}
                disabled={disabled}
              >
                <Text
                  style={[
                    styles.buttonText,
                    isSelected && styles.buttonTextActive,
                  ]}
                >
                  {file.name}
                </Text>
                <Text style={styles.description}>{file.description}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 10,
  },
  section: {
    gap: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#8E8E93',
    marginTop: 4,
  },
  button: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    padding: 12,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  buttonActive: {
    backgroundColor: '#E3F2FD',
    borderColor: '#007AFF',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 4,
  },
  buttonTextActive: {
    color: '#007AFF',
  },
  description: {
    fontSize: 13,
    color: '#8E8E93',
  },
  empty: {
    color: '#666',
    marginBottom: 8,
  },
});
