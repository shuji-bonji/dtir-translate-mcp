/**
 * vitest spec — 用語集（glossary）の解決と、LLM/DeepL 両エンジンへの適用。
 * fetch をモックして実 API 無しで検証する（reader 非依存）。
 */
import { describe, expect, it } from 'vitest';
import {
  DeeplHttpTranslator,
  LlmTranslator,
  resolveEntries,
  resolveDeeplId,
  glossaryToTsv,
  type Glossary,
} from '../src/translate.js';

const glossary: Glossary = {
  target: 'en-GB',
  bySource: {
    'de-DE': [{ source: 'Vertrag', target: 'Agreement' }],
    de: [{ source: 'Vertrag', target: 'Contract' }], // 主サブタグ（de-DE が優先される）
    fr: [{ source: 'résiliation', target: 'termination' }],
    '*': [{ source: 'GDPR', target: 'GDPR' }],
  },
  deeplIds: { 'de-DE': 'gid-de-en', fr: 'gid-fr-en' },
};

describe('resolveEntries', () => {
  it('完全一致 → 主サブタグ → * の順で集め、source で先勝ち重複排除', () => {
    const de = resolveEntries(glossary, 'de-DE');
    // de-DE の Vertrag=Agreement が de の Vertrag=Contract に勝ち、* の GDPR も入る
    expect(de).toEqual([
      { source: 'Vertrag', target: 'Agreement' },
      { source: 'GDPR', target: 'GDPR' },
    ]);
  });

  it('主サブタグだけ一致する source でも引ける', () => {
    const fr = resolveEntries(glossary, 'fr-FR');
    expect(fr).toEqual([
      { source: 'résiliation', target: 'termination' },
      { source: 'GDPR', target: 'GDPR' },
    ]);
  });

  it('source 不明では * のみ', () => {
    expect(resolveEntries(glossary, null)).toEqual([{ source: 'GDPR', target: 'GDPR' }]);
  });

  it('glossary 未指定なら空', () => {
    expect(resolveEntries(undefined, 'de-DE')).toEqual([]);
  });
});

describe('resolveDeeplId', () => {
  it('source 言語の glossary_id を返す（主サブタグでフォールバック）', () => {
    expect(resolveDeeplId(glossary, 'de-DE')).toBe('gid-de-en');
    expect(resolveDeeplId(glossary, 'fr-FR')).toBe('gid-fr-en'); // fr に一致
  });
  it('source 不明 / 未登録なら undefined', () => {
    expect(resolveDeeplId(glossary, null)).toBeUndefined();
    expect(resolveDeeplId(glossary, 'nl-NL')).toBeUndefined();
  });
});

describe('LlmTranslator × glossary', () => {
  it('解決した用語対をプロンプトへ注入し、source 言語ごとに内容が変わる', async () => {
    const prompts: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const user = body.messages.find((m: { role: string }) => m.role === 'user');
      prompts.push(String(user.content));
      const items = JSON.parse(String(user.content).match(/items: (\[[\s\S]*\])/)![1]) as string[];
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ translations: items }) } }] }),
      } as unknown as Response;
    }) as typeof fetch;

    const t = new LlmTranslator({ model: 'test', glossary, fetchImpl });
    await t.translateBatch(['Der Vertrag'], { sourceLang: 'de-DE', targetLang: 'en-GB' });
    await t.translateBatch(['La résiliation'], { sourceLang: 'fr-FR', targetLang: 'en-GB' });

    expect(prompts[0]).toContain('Glossary (MANDATORY)');
    expect(prompts[0]).toContain('"Vertrag" => "Agreement"');
    expect(prompts[0]).not.toContain('résiliation'); // de バッチに fr 用語は入らない
    expect(prompts[1]).toContain('"résiliation" => "termination"');
  });

  it('glossary 無しならプロンプトに Glossary 節を出さない', async () => {
    let prompt = '';
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      prompt = String(body.messages.find((m: { role: string }) => m.role === 'user').content);
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ translations: ['x'] }) } }] }),
      } as unknown as Response;
    }) as typeof fetch;
    const t = new LlmTranslator({ model: 'test', fetchImpl });
    await t.translateBatch(['y'], { sourceLang: 'de-DE', targetLang: 'en-GB' });
    expect(prompt).not.toContain('Glossary');
  });
});

describe('DeeplHttpTranslator × glossary', () => {
  const okResp = (n: number) =>
    ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ translations: Array.from({ length: n }, () => ({ text: 'EN' })) }),
    } as unknown as Response);

  it('source に対応する glossary_id を body に付与する', async () => {
    let body: URLSearchParams | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = init?.body as URLSearchParams;
      return okResp(1);
    }) as typeof fetch;
    const t = new DeeplHttpTranslator('key', undefined, glossary, fetchImpl);
    await t.translateBatch(['Der Vertrag'], { sourceLang: 'de-DE', targetLang: 'en-GB' });
    expect(body?.get('glossary_id')).toBe('gid-de-en');
    expect(body?.get('source_lang')).toBe('DE');
  });

  it('source 不明では glossary_id を付けない', async () => {
    let body: URLSearchParams | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = init?.body as URLSearchParams;
      return okResp(1);
    }) as typeof fetch;
    const t = new DeeplHttpTranslator('key', undefined, glossary, fetchImpl);
    await t.translateBatch(['x'], { sourceLang: null, targetLang: 'en-GB' });
    expect(body?.get('glossary_id')).toBeNull();
  });

  it('createDeeplGlossary は TSV を POST し glossary_id を返す', async () => {
    let sent: URLSearchParams | undefined;
    let url = '';
    const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => {
      url = String(u);
      sent = init?.body as URLSearchParams;
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ glossary_id: 'gid-new' }) } as unknown as Response;
    }) as typeof fetch;
    const id = await DeeplHttpTranslator.createDeeplGlossary('key', {
      name: 'legal', sourceLang: 'de-DE', targetLang: 'en-GB',
      entries: [{ source: 'Vertrag', target: 'Agreement' }],
      fetchImpl,
    });
    expect(id).toBe('gid-new');
    expect(url).toContain('/v2/glossaries');
    expect(sent?.get('entries')).toBe('Vertrag\tAgreement');
    expect(sent?.get('entries_format')).toBe('tsv');
  });
});

describe('glossaryToTsv', () => {
  it('タブ区切り・改行連結（値内のタブは空白化）', () => {
    expect(glossaryToTsv([{ source: 'a', target: 'b' }, { source: 'c\td', target: 'e' }])).toBe('a\tb\nc d\te');
  });
});
