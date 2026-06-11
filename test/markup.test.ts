/**
 * vitest spec — 段内書式保持（脱collapse, ②）。
 * markup ヘルパのラウンドトリップと、translateDtir の inlineFormatting:'runs' を検証する。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tortureReaderDtirPath } from '@shuji-bonji/doc-translation-ir/fixtures';
import { validateDtir } from '@shuji-bonji/doc-translation-ir/validate';
import type { IRDocument } from '@shuji-bonji/doc-translation-ir';
import {
  wrapRunsMarkup,
  parseRunsMarkup,
  stripMarkup,
  translateDtir,
  type Translator,
  type TranslateBatchOptions,
} from '../src/translate.js';

const loadTorture = (): IRDocument =>
  JSON.parse(readFileSync(tortureReaderDtirPath, 'utf8')) as IRDocument;

/** タグを保持し内側だけ大文字化する（タグ保持エンジンの模擬）。 */
class TagPreservingMock implements Translator {
  async translateBatch(texts: string[], opts: TranslateBatchOptions): Promise<string[]> {
    if (opts.markup) {
      return texts.map((t) =>
        t.replace(/(<x id="\d+">)([\s\S]*?)(<\/x>)/g, (_, a, inner, b) => a + String(inner).toUpperCase() + b),
      );
    }
    return texts.map((t) => t.toUpperCase());
  }
}

describe('markup helpers', () => {
  const src = 'Payment is mandatory now.';
  const runs = [
    { runId: 'a', start: 0, end: 11 },
    { runId: 'b', start: 11, end: 20 },
    { runId: 'c', start: 20, end: src.length },
  ];

  it('wrap → parse でラン別テキストに戻る', () => {
    const wrapped = wrapRunsMarkup(src, runs);
    expect(wrapped).toBe('<x id="0">Payment is </x><x id="1">mandatory</x><x id="2"> now.</x>');
    expect(parseRunsMarkup(wrapped, 3)).toEqual(['Payment is ', 'mandatory', ' now.']);
    expect(stripMarkup(wrapped)).toBe(src);
  });

  it('特殊文字をエスケープ・アンエスケープする', () => {
    const w = wrapRunsMarkup('a<b>&c', [{ runId: 'x', start: 0, end: 6 }]);
    expect(w).toBe('<x id="0">a&lt;b&gt;&amp;c</x>');
    expect(parseRunsMarkup(w, 1)).toEqual(['a<b>&c']);
  });

  it('タグ欠落・タグ外漏れは null（→ collapse フォールバック）', () => {
    expect(parseRunsMarkup('<x id="0">a</x><x id="2">c</x>', 3)).toBeNull(); // id1 欠落
    expect(parseRunsMarkup('<x id="0">a</x>STRAY<x id="1">b</x>', 2)).toBeNull(); // タグ外
    expect(parseRunsMarkup('<x id="5">a</x>', 1)).toBeNull(); // 想定外 id
  });
});

describe("translateDtir inlineFormatting:'runs'", () => {
  it('複数ラン段落は runTexts を復元、単一ランは付けない、整合性 OK', async () => {
    const dtir = loadTorture();
    await translateDtir(dtir, new TagPreservingMock(), {
      targetLang: 'en-GB',
      engineName: 'mock',
      inlineFormatting: 'runs',
    });
    expect(validateDtir(dtir)).toEqual([]); // runTexts.join==text かつ件数一致

    const bold = dtir.segments.find((s) => s.text.source === 'Payment is mandatory now.');
    expect(bold?.translation?.runTexts).toEqual(['PAYMENT IS ', 'MANDATORY', ' NOW.']);
    expect(bold?.translation?.text).toBe('PAYMENT IS MANDATORY NOW.');

    const cell = dtir.segments.find((s) => s.text.source === 'Artikel 1'); // 単一ラン
    expect(cell?.translation?.runTexts).toBeUndefined();
    expect(cell?.translation?.text).toBe('ARTIKEL 1');
  });

  it("既定（collapse）では runTexts を付けない", async () => {
    const dtir = loadTorture();
    await translateDtir(dtir, new TagPreservingMock(), { targetLang: 'en-GB' });
    for (const s of dtir.segments) {
      if (s.translatable) expect(s.translation?.runTexts).toBeUndefined();
    }
  });
});
