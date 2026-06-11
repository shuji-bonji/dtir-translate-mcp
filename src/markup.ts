/**
 * markup — 段内書式保持（脱collapse, v0.2）のためのインラインタグ変換
 *
 * 段落内の各ラン（太字・色・ハイパーリンク等で書式が違う連続テキスト）を
 * `<x id="i">…</x>` で包んで翻訳エンジンに渡す。エンジン（DeepL の tag_handling=xml /
 * タグ保持を指示した LLM）は **タグを訳語の対応スパンへ移動**して返すので、戻りのタグから
 * ラン別の訳文を復元できる。これにより writer は各ランの rPr を保ったまま訳を分配できる。
 *
 * 失敗（タグ欠落・タグ外への漏れ）は **fail-safe**: parse は null を返し、呼び出し側は
 * 素の訳（collapse）にフォールバックする。文書は壊れない。
 */
import type { SegmentRun } from '@shuji-bonji/doc-translation-ir';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const unesc = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * source を runs のオフセットで切り、各ランを `<x id="i">…</x>` で包んだマークアップを返す。
 * runs は contiguous で source 全域を被覆している前提（reader/validate が保証）。
 */
export function wrapRunsMarkup(source: string, runs: SegmentRun[]): string {
  return runs
    .map((r, i) => `<x id="${i}">${esc(source.slice(r.start, r.end))}</x>`)
    .join('');
}

/** マークアップからタグを除いた素テキスト（fallback の訳文・表示用）。 */
export function stripMarkup(marked: string): string {
  return unesc(marked.replace(/<x id="\d+">/g, '').replace(/<\/x>/g, ''));
}

/**
 * 訳側マークアップを **ラン別訳文の配列**（長さ runCount）に復元する。
 * 復元できない（id 欠落・タグ外に非空白テキストが漏れている）場合は null（→ collapse）。
 */
export function parseRunsMarkup(marked: string, runCount: number): string[] | null {
  const out = new Array<string>(runCount).fill('');
  const seen = new Set<number>();
  const re = /<x id="(\d+)">([\s\S]*?)<\/x>/g;
  let m: RegExpExecArray | null;
  let consumed = '';
  // biome-ignore lint/suspicious/noAssignInExpressions: 走査の定石
  while ((m = re.exec(marked)) !== null) {
    const id = Number(m[1]);
    consumed += m[0];
    if (id < 0 || id >= runCount) return null; // 想定外 id
    out[id] += unesc(m[2]);
    seen.add(id);
  }
  if (seen.size !== runCount) return null; // ラン欠落
  // タグ外に非空白テキストが漏れていないか（エンジンがタグ外へ訳を出した場合は信頼しない）
  const outside = marked.replace(re, '');
  if (/\S/.test(outside)) return null;
  return out;
}
