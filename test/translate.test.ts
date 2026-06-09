/**
 * vitest spec — translateDtir の主要不変条件（mock Translator・reader 非依存）。
 * 入力は doc-translation-ir 同梱の reader 出力 DTIR（静的）。
 * 実 DeepL を使う end-to-end は dtir-docx-pipeline リポジトリに在る。
 */
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { readerDtirPath, schemaPath } from '@shuji-bonji/doc-translation-ir/fixtures';
import { validateDtir } from '@shuji-bonji/doc-translation-ir/validate';
import type { IRDocument } from '@shuji-bonji/doc-translation-ir';
import {
  StaticMapTranslator,
  groupForTranslation,
  translateDtir,
  type Evaluator,
  type Translator,
} from '../src/translate.js';

const TARGET = 'en-GB';
/** 同梱の reader 出力 DTIR を毎回フレッシュに読む（translateDtir は破壊的更新）。 */
const loadDtir = () => JSON.parse(readFileSync(readerDtirPath, 'utf8')) as IRDocument;
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

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
    const dtir = loadDtir();
    const groups = groupForTranslation(dtir);
    const spy = new SpyTranslator();
    const { stats } = await translateDtir(dtir, spy, { targetLang: TARGET });
    expect(spy.calls.length).toBe(groups.size); // 段落数ではなく言語グループ数
    expect(stats.batchCalls).toBe(groups.size);
    for (const c of spy.calls) expect(c.targetLang).toBe(TARGET);
  });

  it('preserves boundaries: each translatable segment gets its own translation', async () => {
    const dtir = loadDtir();
    await translateDtir(dtir, new SpyTranslator(), { targetLang: TARGET });
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
    const bad: Translator = { async translateBatch() { return []; } };
    await expect(translateDtir(loadDtir(), bad, { targetLang: TARGET })).rejects.toThrow(/境界破壊/);
  });

  it('fills quality when an evaluator is provided, output stays valid', async () => {
    const dtir = loadDtir();
    const { stats } = await translateDtir(dtir, new StaticMapTranslator({}), {
      targetLang: TARGET,
      evaluator: mockEval,
    });
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
