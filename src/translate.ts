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

// LLM 翻訳エンジン（OpenAI 互換・クラウド/ローカル両対応）を同じサブパスから提供。
export { LlmTranslator, parseTranslations, type LlmTranslatorOptions } from './llm.js';

// 用語集（辞書）— LLM/DeepL 双方へ橋渡しする単一の真実源。
export {
  resolveEntries,
  resolveDeeplId,
  glossaryToTsv,
  type Glossary,
  type TermPair,
} from './glossary.js';
import { type Glossary, resolveDeeplId, glossaryToTsv } from './glossary.js';

// 段内書式保持（脱collapse）— インラインタグ変換。
export { wrapRunsMarkup, parseRunsMarkup, stripMarkup } from './markup.js';
import { wrapRunsMarkup, parseRunsMarkup, stripMarkup } from './markup.js';

export interface TranslateBatchOptions {
  /** BCP47。null/未指定でエンジン自動判定。 */
  sourceLang?: string | null;
  targetLang: string;
  /**
   * true のとき各 text は `<x id="i">…</x>` のインラインタグを含むマークアップ。
   * エンジンはタグを保持・移動して返す（DeepL tag_handling=xml / LLM へのタグ保持指示）。
   * 段内書式保持（脱collapse）で使う。
   */
  markup?: boolean;
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

/**
 * 1 バッチ呼び出しのサイズ上限。単一言語の長文が「言語グループ＝1巨大バッチ」になって
 * DeepL のリクエスト上限や LLM のコンテキスト上限を超えるのを防ぐ
 * （[[dtir-production-readiness]] ③）。**セグメント境界は割らない**＝チャンクは常に
 * セグメントの整数個で、単一セグメントが maxChars を超える場合はそれだけで1チャンク。
 */
export interface BatchLimits {
  /** 1 呼び出しの最大セグメント数。 */
  maxItems: number;
  /** 1 呼び出しの最大合計文字数（source 文字数の和）。 */
  maxChars: number;
}

/** 既定上限。小さい文書では従来どおり「言語グループ＝1バッチ」になる程度に緩い（DeepL 寄り）。 */
export const DEFAULT_BATCH_LIMITS: BatchLimits = { maxItems: 50, maxChars: 120_000 };

/**
 * セグメント列を **maxItems / maxChars でチャンク分割**する（順序保持・境界不可分）。
 * 貪欲に詰め、次を足すと上限超過になる手前で切る。単一セグメントが maxChars 超でも
 * 分割せず単独チャンクにする（段落テキストは割らない）。
 */
export function chunkBySegments(segs: IRSegment[], limits: BatchLimits): IRSegment[][] {
  const chunks: IRSegment[][] = [];
  let cur: IRSegment[] = [];
  let curChars = 0;
  for (const s of segs) {
    const len = s.text.source.length;
    const exceeds =
      cur.length > 0 && (cur.length >= limits.maxItems || curChars + len > limits.maxChars);
    if (exceeds) {
      chunks.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(s);
    curChars += len;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

export interface TranslateDtirOptions {
  /** 既定は dtir.language.target。 */
  targetLang?: string;
  /** 指定すると各セグメントの quality を充填。 */
  evaluator?: Evaluator;
  /** translation.engine に入れる名前。 */
  engineName?: string;
  /** バッチのサイズ上限（既定 DEFAULT_BATCH_LIMITS）。 */
  limits?: BatchLimits;
  /**
   * 段内書式（太字・色・リンク）の扱い。
   *  - 'collapse'（既定）: 段落全体を素のテキストで翻訳。writer は先頭ランへ集約（書式喪失）。
   *  - 'runs': 複数ランの段落をインラインタグで翻訳し、訳をラン別に復元（translation.runTexts）。
   *    writer が各ランの rPr を保って分配できる。タグ復元に失敗した段落は collapse にフォールバック。
   */
  inlineFormatting?: 'collapse' | 'runs';
}

export interface TranslateStats {
  /** 実際に翻訳した段落数。 */
  translated: number;
  /** バッチ呼び出し回数（＝言語グループ数 × サイズチャンク数の総和）。 */
  batchCalls: number;
  /** サイズ上限で分割が起きた（batchCalls > 言語グループ数の）回数。 */
  chunked: number;
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

  const limits = options.limits ?? DEFAULT_BATCH_LIMITS;
  const useRuns = options.inlineFormatting === 'runs';
  const groups = groupForTranslation(dtir);
  let translated = 0;
  let batchCalls = 0;
  let chunked = 0;

  /** マークアップ翻訳対象（複数ラン＋オフセットあり）か。 */
  const isMultiRun = (s: IRSegment): boolean =>
    useRuns && !!s.text.runs && s.text.runs.length > 1;

  /**
   * セグメント群を render（送信テキスト）／apply（戻り適用）でチャンク翻訳する。
   * markup=true のときエンジンにインラインタグを解釈させる。
   */
  const runPass = async (
    segs: IRSegment[],
    sourceLang: string | null,
    render: (s: IRSegment) => string,
    apply: (s: IRSegment, returned: string) => void,
    markup: boolean,
  ): Promise<void> => {
    if (segs.length === 0) return;
    const chunks = chunkBySegments(segs, limits);
    if (chunks.length > 1) chunked += chunks.length - 1;
    for (const chunk of chunks) {
      const texts = chunk.map(render);
      const out = await translator.translateBatch(texts, { sourceLang, targetLang: target, markup });
      batchCalls++;
      if (out.length !== texts.length) {
        throw new Error(
          `境界破壊: batch 入力 ${texts.length} 件に対し戻り ${out.length} 件（markup=${markup}）`,
        );
      }
      chunk.forEach((s, i) => {
        apply(s, out[i]);
        translated++;
      });
    }
  };

  for (const [group, segs] of groups) {
    const sourceLang = group === '' ? null : group;
    const plain = segs.filter((s) => !isMultiRun(s));
    const marked = segs.filter((s) => isMultiRun(s));

    // 素テキスト（単一ラン or collapse モード）
    await runPass(
      plain,
      sourceLang,
      (s) => s.text.source,
      (s, returned) => {
        s.translation = {
          text: returned,
          engine,
          sourceLangUsed: sourceLang,
          targetLang: target,
          at: now(),
        };
      },
      false,
    );

    // マークアップ翻訳（複数ラン・runs モード）→ ラン別訳文を復元
    await runPass(
      marked,
      sourceLang,
      (s) => wrapRunsMarkup(s.text.source, s.text.runs ?? []),
      (s, returned) => {
        const runTexts = parseRunsMarkup(returned, (s.text.runs ?? []).length);
        const base = {
          engine,
          sourceLangUsed: sourceLang,
          targetLang: target,
          at: now(),
        };
        // 復元できれば runTexts を付与（writer がラン分配）。失敗時はタグ除去した素訳（collapse）。
        s.translation = runTexts
          ? { text: runTexts.join(''), ...base, runTexts }
          : { text: stripMarkup(returned), ...base };
      },
      true,
    );
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
  return { dtir, stats: { translated, batchCalls, chunked, evaluated } };
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
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  constructor(
    private readonly apiKey: string,
    apiUrl?: string,
    /** 用語集（source 言語ごとの DeepL glossary_id を適用）。 */
    private readonly glossary?: Glossary,
    /** fetch 差し替え（テスト用）。 */
    fetchImpl?: typeof fetch,
  ) {
    // apiUrl 未指定時はキー末尾 ":fx" で Free/Pro エンドポイントを自動判定する
    // （DeepL 公式 SDK と同方式。Free キーは ":fx" で終わる）。明示指定が優先。
    this.apiUrl = (
      apiUrl ??
      (apiKey.trim().endsWith(':fx')
        ? 'https://api-free.deepl.com'
        : 'https://api.deepl.com')
    ).replace(/\/$/, '');
    this.fetchImpl = fetchImpl ?? fetch;
  }

  async translateBatch(texts: string[], opts: TranslateBatchOptions): Promise<string[]> {
    if (texts.length === 0) return [];
    const body = new URLSearchParams();
    for (const t of texts) body.append('text', t);
    if (opts.sourceLang) body.set('source_lang', toDeeplSource(opts.sourceLang));
    body.set('target_lang', toDeeplTarget(opts.targetLang));
    // 用語集: source 言語に対応する glossary_id があれば適用（DeepL は source 必須）。
    const glossaryId = resolveDeeplId(this.glossary, opts.sourceLang ?? null);
    if (glossaryId && opts.sourceLang) body.set('glossary_id', glossaryId);
    // 段内書式保持: <x> インラインタグを DeepL に解釈・移動させる。
    if (opts.markup) {
      body.set('tag_handling', 'xml');
      body.set('outline_detection', '0');
    }

    const res = await this.fetchImpl(`${this.apiUrl}/v2/translate`, {
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

  /**
   * inline な用語対から DeepL glossary を作成し glossary_id を返す（事前準備用）。
   * 得た id を Glossary.deeplIds[sourceLang] に入れて DeeplHttpTranslator へ渡す。
   * DeepL の言語コードは2文字（de/en/fr…）。glossary は source→target ペアに紐づく。
   */
  static async createDeeplGlossary(
    apiKey: string,
    args: {
      name: string;
      sourceLang: string;
      targetLang: string;
      entries: TermPairLike[];
      apiUrl?: string;
      fetchImpl?: typeof fetch;
    },
  ): Promise<string> {
    const fetchImpl = args.fetchImpl ?? fetch;
    const apiUrl = (
      args.apiUrl ??
      (apiKey.trim().endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com')
    ).replace(/\/$/, '');
    const body = new URLSearchParams();
    body.set('name', args.name);
    body.set('source_lang', toDeeplSource(args.sourceLang));
    body.set('target_lang', toDeeplSource(args.targetLang));
    body.set('entries', glossaryToTsv(args.entries));
    body.set('entries_format', 'tsv');

    const res = await fetchImpl(`${apiUrl}/v2/glossaries`, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`DeepL glossaries API ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as { glossary_id: string };
    return json.glossary_id;
  }
}

/** createDeeplGlossary が受け取る用語対（TermPair と同形）。 */
interface TermPairLike {
  source: string;
  target: string;
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
