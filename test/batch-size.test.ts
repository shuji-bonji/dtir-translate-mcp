/**
 * vitest spec — サイズバッチ（③）。chunkBySegments の分割規則と、translateDtir が
 * 言語グループをサイズ上限でチャンク化して境界・順序を保つことを検証する。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readerDtirPath } from '@shuji-bonji/doc-translation-ir/fixtures';
import type { IRDocument, IRSegment } from '@shuji-bonji/doc-translation-ir';
import {
  chunkBySegments,
  groupForTranslation,
  translateDtir,
  type BatchLimits,
  type Translator,
} from '../src/translate.js';

/** text.source だけ持つ最小セグメント（chunkBySegments は source 長しか見ない）。 */
const seg = (id: string, len: number): IRSegment =>
  ({ id, text: { source: 'x'.repeat(len) } }) as unknown as IRSegment;

function loadDtir(): IRDocument {
  return JSON.parse(readFileSync(readerDtirPath, 'utf8')) as IRDocument;
}

/** 入力をそのまま返す（順序検証用）。呼び出しごとの入力長を記録。 */
class EchoTranslator implements Translator {
  public callSizes: number[] = [];
  async translateBatch(texts: string[]): Promise<string[]> {
    this.callSizes.push(texts.length);
    return texts.map((t) => `T:${t}`);
  }
}

describe('chunkBySegments', () => {
  it('maxItems で分割', () => {
    const segs = [seg('a', 1), seg('b', 1), seg('c', 1), seg('d', 1), seg('e', 1)];
    const chunks = chunkBySegments(segs, { maxItems: 2, maxChars: 1000 });
    expect(chunks.map((c) => c.length)).toEqual([2, 2, 1]);
  });

  it('maxChars で分割（境界を割らず貪欲詰め）', () => {
    const segs = [seg('a', 30), seg('b', 30), seg('c', 30)];
    const chunks = chunkBySegments(segs, { maxItems: 100, maxChars: 50 });
    // 30 → +30=60>50 で切る → [a][b][c] ではなく [a],[b],[c]（各 30、2つ目で超過）
    expect(chunks.map((c) => c.length)).toEqual([1, 1, 1]);
  });

  it('maxChars 内なら同一チャンクにまとめる', () => {
    const segs = [seg('a', 20), seg('b', 20), seg('c', 20)];
    const chunks = chunkBySegments(segs, { maxItems: 100, maxChars: 50 });
    expect(chunks.map((c) => c.length)).toEqual([2, 1]); // 20+20=40 ok, +20=60>50
  });

  it('単一セグメントが maxChars 超でも分割せず単独チャンク', () => {
    const segs = [seg('big', 500), seg('a', 1)];
    const chunks = chunkBySegments(segs, { maxItems: 100, maxChars: 50 });
    expect(chunks.map((c) => c.length)).toEqual([1, 1]);
    expect(chunks[0][0].id).toBe('big');
  });

  it('順序を保つ', () => {
    const segs = [seg('a', 1), seg('b', 1), seg('c', 1)];
    const ids = chunkBySegments(segs, { maxItems: 2, maxChars: 1000 })
      .flat()
      .map((s) => s.id);
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});

describe('translateDtir × サイズバッチ', () => {
  const tinyLimits: BatchLimits = { maxItems: 1, maxChars: 1_000_000 };

  it('小 limit で言語グループをさらに分割し、batchCalls=翻訳件数・chunked>0', async () => {
    const dtir = loadDtir();
    const groups = groupForTranslation(dtir).size;
    const translatable = dtir.segments.filter((s) => s.translatable).length;
    const t = new EchoTranslator();
    const { stats } = await translateDtir(dtir, t, { targetLang: 'en-GB', limits: tinyLimits });

    expect(stats.translated).toBe(translatable);
    expect(stats.batchCalls).toBe(translatable); // maxItems=1 → 1件=1チャンク
    expect(stats.chunked).toBe(translatable - groups);
    expect(t.callSizes.every((n) => n === 1)).toBe(true);
  });

  it('既定 limit では従来どおり言語グループ＝1バッチ（chunked=0）', async () => {
    const dtir = loadDtir();
    const groups = groupForTranslation(dtir).size;
    const t = new EchoTranslator();
    const { stats } = await translateDtir(dtir, t, { targetLang: 'en-GB' });
    expect(stats.batchCalls).toBe(groups);
    expect(stats.chunked).toBe(0);
  });

  it('訳文と id 対応が分割後も保たれる', async () => {
    const dtir = loadDtir();
    await translateDtir(dtir, new EchoTranslator(), { targetLang: 'en-GB', limits: tinyLimits });
    for (const s of dtir.segments) {
      if (s.translatable) expect(s.translation?.text).toBe(`T:${s.text.source}`);
      else expect(s.translation).toBeNull();
    }
  });
});
