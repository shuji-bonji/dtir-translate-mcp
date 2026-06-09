#!/usr/bin/env node
/**
 * dtir-translate-mcp MCP server
 *
 * tool: translate_dtir — DTIR の translation を翻訳エンジンでバッチ充填して返す。
 * group(source言語)単位でまとめて呼ぶためコスト最小。translatable=false は不可触。
 *
 * エンジン選択（tool 引数 engine、なければ env で自動）:
 *  - 'deepl' : 要 env DEEPL_API_KEY
 *  - 'llm'   : 要 env LLM_MODEL（OpenAI 互換）。任意 LLM_BASE_URL / LLM_API_KEY / LLM_JSON_MODE
 *              例: クラウド = 既定 https://api.openai.com/v1、
 *                  ローカル = LLM_BASE_URL=http://localhost:11434/v1（Ollama）
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DeeplHttpTranslator, LlmTranslator, translateDtir, type Translator } from './translate.js';
import type { IRDocument } from '@shuji-bonji/doc-translation-ir';

const server = new McpServer({ name: 'dtir-translate-mcp', version: '0.0.1' });

function makeTranslator(engine: 'deepl' | 'llm', apiUrl?: string): Translator {
  if (engine === 'llm') {
    const model = process.env.LLM_MODEL;
    if (!model) throw new Error('engine=llm だが LLM_MODEL が未設定です');
    return new LlmTranslator({
      model,
      baseUrl: process.env.LLM_BASE_URL,
      apiKey: process.env.LLM_API_KEY,
      jsonMode: process.env.LLM_JSON_MODE !== 'false',
    });
  }
  const key = process.env.DEEPL_API_KEY;
  if (!key) throw new Error('engine=deepl だが DEEPL_API_KEY が未設定です');
  return new DeeplHttpTranslator(key, apiUrl);
}

server.tool(
  'translate_dtir',
  'DTIR の translatable セグメントを翻訳し translation を充填する。group(source言語)単位で' +
    'バッチ集約しコストを抑える。translatable=false は触らない。エンジンは DeepL かローカル/クラウドLLM。',
  {
    dtirJson: z.string().describe('reader が出力した DTIR(IRDocument) の JSON'),
    targetLang: z.string().optional().describe('翻訳先 BCP47（既定: dtir.language.target）'),
    engine: z
      .enum(['deepl', 'llm'])
      .optional()
      .describe('翻訳エンジン（既定: LLM_MODEL があれば llm、なければ deepl）'),
    apiUrl: z.string().optional().describe('DeepL API ベースURL（既定 https://api-free.deepl.com）'),
  },
  async (args) => {
    try {
      const engine = args.engine ?? (process.env.LLM_MODEL ? 'llm' : 'deepl');
      const translator = makeTranslator(engine, args.apiUrl);
      const dtir = JSON.parse(args.dtirJson) as IRDocument;
      const { dtir: out, stats } = await translateDtir(dtir, translator, {
        targetLang: args.targetLang,
        engineName: engine,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ engine, stats, dtir: out }) }] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: 'text', text: `translate_dtir failed: ${msg}` }] };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('dtir-translate-mcp MCP server running on stdio');
