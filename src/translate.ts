/**
 * translate — translateDtir: DTIR の translation(と任意で quality) を埋める
 *
 * パイプライン中央ステージ。reader が出した DTIR を受け、後段 writer へ渡す。
 *
 * 設計（DTIR 契約に忠実）:
 *  - **group(=source言語) 単位でバッチ翻訳**。段落数ぶんではなく言語数ぶんの
 *    リクエストに集約＝コスト爆発を防ぐ（元の DeepL Bridges 相談への回答）。
 *  - **境界保持**: 1リクエストは text[] 配列。連結しない。戻り配列長＝入力長を強制。
 *  - 翻訳エンジンは Translator 抽象で差し替え可（DeepL HTTP / LLM / 静的マップ）。
 *  - 品質は Evaluator 抽象（xCOMET）で任意に充填。lang 不要なので source/translation だけ渡す。
 *  - translatable=false は一切触らない。
 */
import type {
  ErrorSeverity,
  IRDocument,
  IRSegment,
} from '@shuji-bonji/doc-translation-ir';

export interface TranslateBatchOptions {
  /** BCP47。null/未指定でエンジン自動判定。 */
  sourceLang?: string | null;
  targetLang: string;
}

/** 翻訳エンジン抽象。**配列長を保つ**こと（境界保持の契約）。 */
export interface Translator {
  translateBatch(texts: string[], opts: TranslateBatchOptions): Promise<string[]>;
}

export interface EvalResult {
  score: number;
  hasCritical: boolean;
  errors: { text: string; start: number; end: number; severity: ErrorSeverity }[];
}

/** 品質評価抽象（xCOMET 等）。 */
export interface Evaluator {
  evaluate(source: string, translation: string): Promise<EvalResult>;
}

/**
 * translatable セグメントを group(source言語) でまとめる。
 * group が null のものは '' キー（＝エンジン自動判定）に集約。
 */
export function groupForTranslation(dtir: IRDocument): Map<string, IRSegment[]> {
  const groups = new Map<string, IRSegment[]>();
  for (const seg of dtir.segments) {
    if (!seg.translatable) continue;
    const key = seg.group ?? '';
    const arr = groups.get(key) ?? [];
    arr.push(seg);
    groups.set(key, arr);
  }
  return groups;
}

export interface TranslateDtirOptions {
  /** 既定は dtir.language.target。 */
  targetLang?: string;
  /** 指定すると各セグメントの quality を充填。 */
  evaluator?: Evaluator;
  /** translation.engine に入れる名前。 */
  engineName?: string;
}

export interface TranslateStats {
  /** 実際に翻訳した段落数。 */
  translated: number;
  /** バッチ呼び出し回数（＝言語グループ数）。 */
  batchCalls: number;
  /** 評価した段落数。 */
  evaluated: number;
}

/**
 * DTIR の translation（と任意で quality）を埋めて返す。
 * 入力 dtir を破壊的に更新し、同じ参照を返す（PoC）。
 */
export async function translateDtir(
  dtir: IRDocument,
  translator: Translator,
  options: TranslateDtirOptions = {},
): Promise<{ dtir: IRDocument; stats: TranslateStats }> {
  const target = options.targetLang ?? dtir.language.target;
  if (!target) throw new Error('targetLang が未指定（options か dtir.language.target に必要）');
  const engine = options.engineName ?? 'deepl';
  const now = () => new Date().toISOString();

  const groups = groupForTranslation(dtir);
  let translated = 0;
  let batchCalls = 0;

  for (const [group, segs] of groups) {
    const texts = segs.map((s) => s.text.source);
    const sourceLang = group === '' ? null : group;
    const out = await translator.translateBatch(texts, { sourceLang, targetLang: target });
    batchCalls++;
    if (out.length !== texts.length) {
      throw new Error(
        `境界破壊: batch 入力 ${texts.length} 件に対し戻り ${out.length} 件（group=${group}）`,
      );
    }
    segs.forEach((s, i) => {
      s.translation = {
        text: out[i],
        engine,
        sourceLangUsed: sourceLang,
        targetLang: target,
        at: now(),
      };
      translated++;
    });
  }

  let evaluated = 0;
  if (options.evaluator) {
    for (const seg of dtir.segments) {
      if (!seg.translatable || !seg.translation) continue;
      const q = await options.evaluator.evaluate(seg.text.source, seg.translation.text);
      seg.quality = { score: q.score, hasCritical: q.hasCritical, errors: q.errors };
      evaluated++;
    }
  }

  dtir.language.target = target;
  return { dtir, stats: { translated, batchCalls, evaluated } };
}

// ---------------------------------------------------------------------------
// Translator 実装
// ---------------------------------------------------------------------------

/** BCP47 → DeepL の言語コード。source は2文字、target は EN/PT のみ地域付き。 */
function toDeeplSource(bcp47: string): string {
  return bcp47.split('-')[0].toUpperCase();
}
function toDeeplTarget(bcp47: string): string {
  const [primary, region] = bcp47.split('-');
  const p = primary.toUpperCase();
  if ((p === 'EN' || p === 'PT') && region) return `${p}-${region.toUpperCase()}`;
  return p;
}

/**
 * DeepL HTTP API を直接叩く Translator。**group 単位で text[] 配列を1リクエスト**に
 * まとめる（DeepL の配列入力＝境界保持）。API キーは呼び出し側が渡す。
 */
export class DeeplHttpTranslator implements Translator {
  constructor(
    private readonly apiKey: string,
    private readonly apiUrl = 'https://api-free.deepl.com',
  ) {}

  async translateBatch(texts: string[], opts: TranslateBatchOptions): Promise<string[]> {
    if (texts.length === 0) return [];
    const body = new URLSearchParams();
    for (const t of texts) body.append('text', t);
    if (opts.sourceLang) body.set('source_lang', toDeeplSource(opts.sourceLang));
    body.set('target_lang', toDeeplTarget(opts.targetLang));

    const res = await fetch(`${this.apiUrl}/v2/translate`, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${this.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`DeepL API ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as { translations: { text: string }[] };
    return json.translations.map((t) => t.text);
  }
}

/**
 * 事前に用意した source→translation マップで翻訳する Translator。
 * テスト・オフライン再現・「外部で取得した訳を流し込む」用途。
 */
export class StaticMapTranslator implements Translator {
  /** バッチ呼び出し回数（テストでグループ数＝呼び出し数を検証する用）。 */
  public batchCalls = 0;
  constructor(private readonly map: Record<string, string>) {}

  async translateBatch(texts: string[]): Promise<string[]> {
    this.batchCalls++;
    return texts.map((t) => this.map[t] ?? t);
  }
}
