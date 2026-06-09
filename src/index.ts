#!/usr/bin/env node
/**
 * dtir-translate-mcp MCP server
 *
 * tool: translate_dtir — DTIR の translation を DeepL でバッチ充填して返す。
 * group(source言語)単位でまとめて呼ぶためコスト最小。translatable=false は不可触。
 *
 * 要 env: DEEPL_API_KEY（DeepL HTTP API キー）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DeeplHttpTranslator, translateDtir } from './translate.js';
import type { IRDocument } from './dtir.js';

const server = new McpServer({ name: 'dtir-translate-mcp', version: '0.0.1' });

server.tool(
  'translate_dtir',
  'DTIR の translatable セグメントを DeepL で翻訳し translation を充填する。' +
    'group(source言語)単位でバッチ集約しコストを抑える。translatable=false は触らない。',
  {
    dtirJson: z.string().describe('reader が出力した DTIR(IRDocument) の JSON'),
    targetLang: z.string().optional().describe('翻訳先 BCP47（既定: dtir.language.target）'),
    apiUrl: z
      .string()
      .optional()
      .describe('DeepL API ベースURL（既定 https://api-free.deepl.com）'),
  },
  async (args) => {
    const key = process.env.DEEPL_API_KEY;
    if (!key) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'DEEPL_API_KEY が未設定です' }],
      };
    }
    try {
      const dtir = JSON.parse(args.dtirJson) as IRDocument;
      const translator = new DeeplHttpTranslator(key, args.apiUrl);
      const { dtir: out, stats } = await translateDtir(dtir, translator, {
        targetLang: args.targetLang,
      });
      return {
        content: [
          { type: 'text', text: JSON.stringify({ stats, dtir: out }) },
        ],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: 'text', text: `translate_dtir failed: ${msg}` }] };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('dtir-translate-mcp MCP server running on stdio');
