/**
 * vitest spec — LlmTranslator（fetch をモックして実LLM無しで検証）。
 * 長さ保証・順序・リトライ・例外・寛容パース・translateDtir 統合を確認。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readerDtirPath } from '@shuji-bonji/doc-translation-ir/fixtures';
import { validateDtir } from '@shuji-bonji/doc-translation-ir/validate';
import type { IRDocument } from '@shuji-bonji/doc-translation-ir';
import { LlmTranslator, parseTranslations, groupForTranslation, translateDtir } from '../src/translate.js';

/** リクエスト body から items 配列を取り出す（items は最初の user メッセージに在る）。 */
function extractItems(init: RequestInit | undefined): string[] {
  const body = JSON.parse(String(init?.body));
  const user = body.messages.find((m: { role: string }) => m.role === 'user');
  const m = String(user.content).match(/items: (\[[\s\S]*\])/);
  return JSON.parse(m![1]);
}

/** OpenAI 風レスポンス（最小）を返す fetch モック。calls() で呼び出し回数を取れる。 */
function makeFetch(contentFor: (items: string[], callIndex: number) => string) {
  let calls = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const items = extractItems(init);
    const content = contentFor(items, calls++);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ choices: [{ message: { content } }] }),
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

const jsonOut = (arr: string[]) => JSON.stringify({ translations: arr });
const up = (s: string) => s.toUpperCase();

describe('parseTranslations', () => {
  it('parses object, bare array, and fenced JSON', () => {
    expect(parseTranslations('{"translations":["a","b"]}')).toEqual(['a', 'b']);
    expect(parseTranslations('["a","b"]')).toEqual(['a', 'b']);
    expect(parseTranslations('Sure!\n```json\n{"translations":["x"]}\n```')).toEqual(['x']);
    expect(parseTranslations('not json at all')).toBeNull();
  });
});

describe('LlmTranslator', () => {
  it('returns same length & order', async () => {
    const { fetchImpl } = makeFetch((items) => jsonOut(items.map(up)));
    const t = new LlmTranslator({ model: 'mock', fetchImpl });
    const out = await t.translateBatch(['alpha', 'béta', 'γ'], { targetLang: 'en' });
    expect(out).toEqual(['ALPHA', 'BÉTA', 'Γ']);
  });

  it('retries on length mismatch then succeeds', async () => {
    const mf = makeFetch((items, call) =>
      call === 0 ? jsonOut(items.slice(1).map(up)) : jsonOut(items.map(up)),
    );
    const t = new LlmTranslator({ model: 'mock', fetchImpl: mf.fetchImpl });
    const out = await t.translateBatch(['a', 'b', 'c'], { targetLang: 'en' });
    expect(out).toEqual(['A', 'B', 'C']);
    expect(mf.calls()).toBe(2); // 1回目失敗→是正リトライで成功
  });

  it('throws when length never matches', async () => {
    const { fetchImpl } = makeFetch((items) => jsonOut(items.slice(1).map(up))); // 常に1件少ない
    const t = new LlmTranslator({ model: 'mock', maxRetries: 1, fetchImpl });
    await expect(t.translateBatch(['a', 'b'], { targetLang: 'en' })).rejects.toThrow(/件の訳を得られませんでした/);
  });

  it('tolerates prose-wrapped JSON (non-json-mode models)', async () => {
    const { fetchImpl } = makeFetch((items) => `Here:\n\`\`\`json\n${jsonOut(items.map(up))}\n\`\`\``);
    const t = new LlmTranslator({ model: 'mock', jsonMode: false, fetchImpl });
    const out = await t.translateBatch(['x', 'y'], { targetLang: 'en' });
    expect(out).toEqual(['X', 'Y']);
  });

  it('drops into translateDtir end-to-end (per-group batching, valid output)', async () => {
    const dtir = JSON.parse(readFileSync(readerDtirPath, 'utf8')) as IRDocument;
    const groups = groupForTranslation(dtir);
    const mf = makeFetch((items) => jsonOut(items.map((s) => `EN:${s}`)));
    const t = new LlmTranslator({ model: 'mock', fetchImpl: mf.fetchImpl });
    const { stats } = await translateDtir(dtir, t, { targetLang: 'en-GB' });

    expect(mf.calls()).toBe(groups.size); // 言語グループ数ぶんの呼び出し
    expect(stats.batchCalls).toBe(groups.size);
    for (const s of dtir.segments) {
      if (s.translatable) expect(s.translation?.text).toBe(`EN:${s.text.source}`);
      else expect(s.translation).toBeNull();
    }
    expect(validateDtir(dtir)).toEqual([]);
  });
});
