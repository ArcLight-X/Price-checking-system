import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ArkPrompt } from './ark.ts';
import type { PriceExtraction } from './extractor/types.ts';

export interface ResearchCacheRow {
  promptHash: string;
  ok: true;
  extraction: PriceExtraction;
  issues: unknown[];
  [key: string]: unknown;
}

/** 视频、模型、完整输入或缓存协议变化时均不复用旧输出。 */
export function promptFingerprint(model: string, prompt: ArkPrompt, bvid: string): string {
  return createHash('sha256').update(JSON.stringify({ model, prompt, bvid, cacheVersion: 1 })).digest('hex');
}

/** 只信任上次本程序生成的成功结果；格式不对或失败的记录会重新分析。 */
export function loadResearchCache(file: string, hash: string): ResearchCacheRow | null {
  if (!fs.existsSync(file)) return null;
  try {
    const row: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof row !== 'object' || row === null) return null;
    const record = row as Record<string, unknown>;
    if (record['ok'] !== true || record['promptHash'] !== hash
      || !Array.isArray(record['issues']) || !record['extraction']
      || typeof record['extraction'] !== 'object'
      || !Array.isArray((record['extraction'] as Record<string, unknown>)['claims'])) return null;
    return record as unknown as ResearchCacheRow;
  } catch {
    return null;
  }
}

export function saveResearchCache(file: string, row: ResearchCacheRow): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 12)}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(row), 'utf8');
    fs.renameSync(tempFile, file);
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
}