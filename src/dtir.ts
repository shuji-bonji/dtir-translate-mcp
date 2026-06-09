/**
 * DTIR 型のローカルミラー（正本は ../../doc-translation-ir/src/types.ts, v0.1）。
 * PoC のため複製。将来は `@shuji-bonji/doc-translation-ir` への依存に置き換える。
 * 出力は JSON Schema（doc-translation-ir/schema/dtir-0.1.schema.json）で検証するので、
 * 万一この複製がドリフトしてもテストが検出する。
 */
export type Bcp47 = string;
export const DTIR_VERSION = '0.1' as const;
export type DocFormat = 'docx' | 'pdf';
export type LanguageSource = 'tag' | 'detect' | 'inherit' | 'default' | 'declared';
export type SkipReason =
  | 'field'
  | 'non-linguistic-zxx'
  | 'numeric'
  | 'locked'
  | 'empty'
  | null;
export type SegmentRole =
  | 'heading'
  | 'body'
  | 'caption'
  | 'footnote'
  | 'endnote'
  | 'table-cell'
  | 'header'
  | 'footer'
  | 'toc'
  | 'list-item'
  | 'textbox'
  | 'other';
export type ErrorSeverity = 'minor' | 'major' | 'critical';

export interface IRAnchor {
  format: DocFormat;
  ref: Record<string, unknown>;
}
export interface LanguageCandidate {
  value: Bcp47;
  confidence: number;
}
export interface SegmentLanguage {
  value: Bcp47 | null;
  confidence: number;
  source: LanguageSource;
  candidates?: LanguageCandidate[];
}
export interface SegmentRun {
  runId: string;
  start: number;
  end: number;
}
export interface SegmentText {
  source: string;
  hasInlineFormatting: boolean;
  runs?: SegmentRun[];
  space: 'default' | 'preserve';
}
export interface SegmentContext {
  prev: string | null;
  next: string | null;
  parent: string | null;
}
export interface SegmentTranslation {
  text: string;
  engine: string;
  sourceLangUsed: Bcp47 | null;
  targetLang: Bcp47;
  at: string;
}
export interface QualityError {
  text: string;
  start: number;
  end: number;
  severity: ErrorSeverity;
  suggestion?: string | null;
}
export interface SegmentQuality {
  score: number;
  hasCritical: boolean;
  errors: QualityError[];
}
export interface IRSegment {
  id: string;
  order: number;
  anchor: IRAnchor;
  role: SegmentRole;
  text: SegmentText;
  language: SegmentLanguage;
  translatable: boolean;
  skipReason: SkipReason;
  group: string | null;
  context: SegmentContext;
  translation: SegmentTranslation | null;
  quality: SegmentQuality | null;
}
export interface DocumentLanguage {
  default: { value: Bcp47 | null; source: 'container-default' | 'none' };
  target: Bcp47 | null;
  multilingual: {
    isMultilingual: boolean;
    score: number;
    method:
      | 'declared'
      | 'tag-diversity'
      | 'script-diversity'
      | 'whole-doc-detect'
      | 'per-segment';
    languagesPresent: Bcp47[];
  };
}
export interface DocumentSource {
  format: DocFormat;
  fileName: string;
  sha256: string;
  byteSize: number;
}
export interface DocumentStats {
  segmentCount: number;
  translatableCount: number;
  groupCount: number;
}
export interface IRDocument {
  irVersion: typeof DTIR_VERSION;
  source: DocumentSource;
  language: DocumentLanguage;
  segments: IRSegment[];
  stats: DocumentStats;
  extensions?: Record<string, unknown>;
}
