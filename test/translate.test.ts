/**
 * vitest spec — translateDtir の主要不変条件（mock Translator）。
 * 実 DeepL を使う end-to-end は test/pipeline-e2e.ts（npm run test:e2e）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { docxToDtir } from '../../dtir-ooxml-reader-mcp/src/reader.js';
import { validateDtir } from '../../doc-translation-ir/tools/validate-dtir.js';
import {
  StaticMapTranslator,
  groupForTranslation,
  translateDtir,
  type Evaluator,
  type Translator,
} from '../src/translate.js';

const here = dirname(fileURLToPath(import.meta.url));
const irRoot = resolve(here, '../../doc-translation-ir');
const fixture = resolve(irRoot, 'fixtures/docx/mixed-nl-fr-de-tricky.docx');
const schema = JSON.parse(readFileSync(resolve(irRoot, 'schema/dtir-0.1.schema.json'), 'utf8'));

/** バッチ呼び出しごとに source 言語と件数を記録する spy。 */
class SpyTranslator implements Translator {
  public calls: { count: number; sourceLang: string | null; targetLang: string }[] = [];
  async translateBatch(texts: string[], opts: { sourceLang?: string | null; targetLang: string }) {
    this.calls.push({ count: texts.length, sourceLang: opts.sourceLang ?? null, targetLang: opts.targetLang });
    return texts.map((t) => `<${opts.sourceLang ?? 'auto'}→${opts.targetLang}>${t}`);
  }
}

const mockEval: Evaluator = {
  async evaluate(_s, t) {
    return { score: t.length > 0 ? 0.9 : 0, hasCritical: false, errors: [] };
  },
};

describe('translateDtir', () => {
  it('batches by language group (言語数ぶんの呼び出し)', async () => {
    const dtir = await docxToDtir(readFileSync(fixture), { targetLang: 'en-GB' });
    const groups = groupForTranslation(dtir);
    const spy = new SpyTranslator();
    const { stats } = await translateDtir(dtir, spy, {});
    // バッチ呼び出し回数＝distinct group 数（段落数ではない）
    expect(spy.calls.length).toBe(groups.size);
    expect(stats.batchCalls).toBe(groups.size);
    // 各バッチの source は単一言語
    for (const c of spy.calls) expect(c.targetLang).toBe('en-GB');
  });

  it('preserves boundaries: each translatable segment gets its own translation', async () => {
    const dtir = await docxToDtir(readFileSync(fixture), { targetLang: 'en-GB' });
    await translateDtir(dtir, new SpyTranslator(), {});
    for (const s of dtir.segments) {
      if (s.translatable) {
        expect(s.translation).not.toBeNull();
        expect(s.translation?.text).toContain(s.text.source); // 連結されず1対1対応
      } else {
        expect(s.translation).toBeNull(); // 非translatableは不可触
      }
    }
  });

  it('throws on boundary violation (戻り配列長の不一致)', async () => {
    const dtir = await docxToDtir(readFileSync(fixture), { targetLang: 'en-GB' });
    const bad: Translator = { async translateBatch() { return []; } };
    await expect(translateDtir(dtir, bad, {})).rejects.toThrow(/境界破壊/);
  });

  it('fills quality when an evaluator is provided, output stays valid', async () => {
    const dtir = await docxToDtir(readFileSync(fixture), { targetLang: 'en-GB' });
    const { stats } = await translateDtir(dtir, new StaticMapTranslator({}), { evaluator: mockEval });
    expect(stats.evaluated).toBe(stats.translated);
    for (const s of dtir.segments) {
      if (s.translatable) expect(s.quality?.score).toBeGreaterThan(0);
    }
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    expect(ajv.compile(schema)(dtir)).toBe(true);
    expect(validateDtir(dtir)).toEqual([]);
  });
});
