/**
 * llm — LlmTranslator: OpenAI 互換 chat completions で翻訳する Translator
 *
 * クラウド（OpenAI / 互換ゲートウェイ）とローカル（Ollama / llama.cpp / vLLM /
 * LM Studio の `/v1/chat/completions`）の**両方**を、baseUrl とモデル名の差し替えだけで扱う。
 * 外部 SDK に依存せず global fetch のみ。
 *
 * LLM は DeepL と違い「N件入れてもN件返す」保証が無い（件数を変える・順序を崩す・
 * 注釈を足す）。そこで:
 *  - **構造化出力**を要求（{"translations":[...]} の JSON）
 *  - **配列長を検証**し、不一致なら是正メッセージ付きで**リトライ**
 *  - それでも揃わなければ例外（translateDtir の境界保証を満たすため）
 */
import type { TranslateBatchOptions, Translator } from './translate.js';

export interface LlmTranslatorOptions {
  /** モデル名（例: 'gpt-4o-mini' / 'qwen2.5:7b' / 'gemma2'）。 */
  model: string;
  /** API ベースURL。既定 https://api.openai.com/v1（ローカルは http://localhost:11434/v1 等）。 */
  baseUrl?: string;
  /** API キー。ローカルエンドポイントでは不要なことが多い。 */
  apiKey?: string;
  /** 既定 0（決定論寄り）。 */
  temperature?: number;
  /** 長さ不一致時の再試行回数。既定 2。 */
  maxRetries?: number;
  /** response_format=json_object を付ける。ローカルが未対応なら false。既定 true。 */
  jsonMode?: boolean;
  /** リクエストタイムアウト ms。既定 60000。 */
  timeoutMs?: number;
  /** system プロンプト上書き（任意）。 */
  systemPrompt?: (targetLang: string) => string;
  /** fetch 差し替え（テスト用）。 */
  fetchImpl?: typeof fetch;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const defaultSystem = (_target: string): string =>
  'You are a professional document translator. Output strictly valid JSON only. Never add commentary, notes, or markdown fences.';

function buildUserPrompt(texts: string[], opts: TranslateBatchOptions): string {
  const hint = opts.sourceLang
    ? `Source language hint: ${opts.sourceLang} (the items may be mixed-language; translate every item regardless).`
    : 'The items may be in mixed languages; translate every item regardless of its source language.';
  return [
    `Translate each item in "items" into ${opts.targetLang}.`,
    hint,
    'Rules: preserve meaning and tone; do NOT translate numbers, currency amounts, codes, URLs or identifiers (keep them verbatim); translate every item even if short.',
    `Return JSON only in this exact shape: {"translations": [ /* exactly ${texts.length} strings, SAME order as items */ ]}.`,
    `items: ${JSON.stringify(texts)}`,
  ].join('\n');
}

/** assistant の本文から訳の配列を取り出す（JSONモード/素のテキスト両対応）。 */
export function parseTranslations(content: string): string[] | null {
  const tryExtract = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      // テキスト中の最初の {...} か [...] を拾う
      const obj = raw.match(/\{[\s\S]*\}/);
      const arr = raw.match(/\[[\s\S]*\]/);
      const cand = obj?.[0] ?? arr?.[0];
      if (!cand) return null;
      try {
        return JSON.parse(cand);
      } catch {
        return null;
      }
    }
  };
  const parsed = tryExtract(content);
  if (parsed == null) return null;
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { translations?: unknown }).translations)
      ? (parsed as { translations: unknown[] }).translations
      : null;
  if (!arr) return null;
  return arr.map((x) => (typeof x === 'string' ? x : String(x)));
}

export class LlmTranslator implements Translator {
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly temperature: number;
  private readonly jsonMode: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly systemPrompt: (t: string) => string;

  constructor(private readonly opts: LlmTranslatorOptions) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.maxRetries = opts.maxRetries ?? 2;
    this.temperature = opts.temperature ?? 0;
    this.jsonMode = opts.jsonMode ?? true;
    this.timeoutMs = opts.timeoutMs ?? 60000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.systemPrompt = opts.systemPrompt ?? defaultSystem;
  }

  async translateBatch(texts: string[], opts: TranslateBatchOptions): Promise<string[]> {
    if (texts.length === 0) return [];
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt(opts.targetLang) },
      { role: 'user', content: buildUserPrompt(texts, opts) },
    ];

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const content = await this.call(messages);
      const out = parseTranslations(content);
      if (out && out.length === texts.length) return out;
      // 是正リトライ
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content:
          `You must return exactly ${texts.length} translations as {"translations":[...]} in the SAME order. ` +
          `You returned ${out ? out.length : 'invalid/non-JSON'}. Output JSON only.`,
      });
    }
    throw new Error(
      `LlmTranslator: ${texts.length} 件の訳を得られませんでした（model=${this.opts.model}, maxRetries=${this.maxRetries}）`,
    );
  }

  private async call(messages: ChatMessage[]): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.opts.model,
          temperature: this.temperature,
          messages,
          ...(this.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
      if (!res.ok) {
        throw new Error(`LLM API ${res.status} ${res.statusText}`);
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return json.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
  }
}
