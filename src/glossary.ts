/**
 * glossary — 用語集（辞書）の単一の真実源と解決ロジック
 *
 * 法律・技術文書では用語の一貫性が品質の要。xCOMET はスコアであって用語一貫性を保証しない
 * （[[dtir-production-readiness]] ④）。ここでは **inline な用語対を真実源**とし、
 *  - LLM エンジン: プロンプトに用語対を注入（外部状態なし・決定論的）
 *  - DeepL エンジン: 事前作成済 glossary_id を source 言語ごとに適用（DeepL 本来の機構）
 * の両方へ同じ用語集から橋渡しする。glossary は翻訳設定であり文書構造ではないので
 * DTIR 契約には載せず、translate-mcp 内に閉じる。
 */

/** 1 用語の対応（source 言語の語 → target 言語の訳）。 */
export interface TermPair {
  source: string;
  target: string;
}

/**
 * 用語集。1 つの target 言語に対し、source 言語ごとの用語対を持つ。
 * 混在言語文書では source 言語が段落ごとに変わるため bySource で引く。
 */
export interface Glossary {
  /** 翻訳先 BCP47（この用語集が対象とする言語）。 */
  target: string;
  /**
   * source 言語(BCP47 例 'de-DE' / 'de')ごとの用語対。
   * キー `'*'` は source 非依存（全 source 共通）。LLM のみ適用（DeepL は source 必須）。
   */
  bySource: Record<string, TermPair[]>;
  /**
   * DeepL 用: source 言語(BCP47)→ 事前作成済 DeepL glossary_id。
   * DeeplHttpTranslator.createDeeplGlossary で作って得た id を入れる。
   */
  deeplIds?: Record<string, string>;
}

/**
 * (sourceLang, glossary) に適用すべき用語対を解決する。
 * 完全一致 → 主サブタグ(de-DE→de) → `'*'` の順に集め、source 語で重複排除（先勝ち）。
 */
export function resolveEntries(
  glossary: Glossary | undefined,
  sourceLang: string | null,
): TermPair[] {
  if (!glossary) return [];
  const keys: string[] = [];
  if (sourceLang) {
    keys.push(sourceLang);
    const primary = sourceLang.split('-')[0];
    if (primary !== sourceLang) keys.push(primary);
  }
  keys.push('*');

  const seen = new Set<string>();
  const out: TermPair[] = [];
  for (const k of keys) {
    for (const e of glossary.bySource[k] ?? []) {
      if (!seen.has(e.source)) {
        seen.add(e.source);
        out.push(e);
      }
    }
  }
  return out;
}

/**
 * DeepL glossary_id を解決する（source 言語必須・主サブタグでフォールバック）。
 * source 不明（auto 判定グループ）では DeepL glossary は使えないので undefined。
 */
export function resolveDeeplId(
  glossary: Glossary | undefined,
  sourceLang: string | null,
): string | undefined {
  if (!glossary?.deeplIds || !sourceLang) return undefined;
  return glossary.deeplIds[sourceLang] ?? glossary.deeplIds[sourceLang.split('-')[0]];
}

/** 用語対を DeepL glossaries API 用の TSV（source\ttarget 改行区切り）に整形。 */
export function glossaryToTsv(entries: TermPair[]): string {
  return entries
    .map((e) => `${e.source.replace(/\t/g, ' ')}\t${e.target.replace(/\t/g, ' ')}`)
    .join('\n');
}
