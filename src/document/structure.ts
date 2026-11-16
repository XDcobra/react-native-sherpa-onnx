import type {
  DocumentStructure,
  DocumentStructureFormat,
  DocumentStructureSection,
} from './types';

const FORMATS: readonly DocumentStructureFormat[] = [
  'epub',
  'fb2',
  'mobi',
  'pdf',
];

/** Native structure summary (document and PDF bridges) → `DocumentStructure`. */
export function mapDocumentStructure(
  raw: unknown
): DocumentStructure | undefined {
  if (raw == null || typeof raw !== 'object') {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const sections = Array.isArray(r.sections) ? r.sections : [];
  const meta = (r.metadata ?? {}) as Record<string, unknown>;
  const str = (v: unknown) =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  const metadata: DocumentStructure['metadata'] = {};
  if (str(meta.title)) metadata.title = str(meta.title);
  if (str(meta.creator)) metadata.creator = str(meta.creator);
  if (str(meta.language)) metadata.language = str(meta.language);
  return {
    format: FORMATS.includes(r.format as DocumentStructureFormat)
      ? (r.format as DocumentStructureFormat)
      : 'epub',
    version: Number(r.version ?? 1),
    blockCount: Number(r.blockCount ?? 0),
    sections: sections.map((item) => {
      const s = (item ?? {}) as Record<string, unknown>;
      const titleSource = s.titleSource;
      const section: DocumentStructureSection = {
        sectionIndex: Number(s.sectionIndex ?? 0),
        href: String(s.href ?? ''),
        kind: s.kind === 'image' || s.kind === 'page' ? s.kind : 'text',
        titleSource:
          titleSource === 'toc' || titleSource === 'heading'
            ? titleSource
            : 'none',
        utf16Start: Number(s.utf16Start ?? 0),
        utf16End: Number(s.utf16End ?? 0),
        firstBlock: Number(s.firstBlock ?? 0),
        blockCount: Number(s.blockCount ?? 0),
      };
      const title = str(s.title);
      if (title) section.title = title;
      const label = str(s.label);
      if (label) section.label = label;
      return section;
    }),
    metadata,
  };
}
