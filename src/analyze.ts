/** analyze.ts —— 调用 DeepSeek，从已抓取评论中提取价格线索并导出 JSONL。 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PROJECT_ROOT, loadConfig } from './config.ts';
import { assembleConversations, type ConversationSourceRow } from './conversation.ts';
import { createDeepSeekClient, parseModelJson } from './deepseek.ts';
import { openDb } from './db.ts';
import { buildPriceExtractionPrompt } from './extractor/prompt.ts';
import { validatePriceExtraction } from './extractor/validator.ts';

const HELP_TEXT = `
使用 DeepSeek 分析已抓取的 B站评论对话

用法：
  node src/analyze.ts --video <BV号> [选项]

选项：
  --video    必填，已抓取视频的 BV 号
  --limit    最多分析多少个一级评论对话（默认 10）
  --out      输出 JSONL 路径（默认 data/<BV号>-price-analysis.jsonl）
  --db       SQLite 数据库路径（默认 data/bilibili.db）
  -h, --help 显示帮助

需要在 .env 中配置 DEEPSEEK_API_KEY。
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      video: { type: 'string' },
      limit: { type: 'string' },
      out: { type: 'string' },
      db: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(HELP_TEXT);
    return;
  }
  if (!values.video) throw new Error('缺少 --video 参数');

  const config = loadConfig();
  if (!config.deepseekApiKey) {
    throw new Error('未配置 DEEPSEEK_API_KEY，请先在项目根目录的 .env 中填写');
  }

  const limit = Math.max(1, Number.parseInt(values.limit ?? '10', 10) || 10);
  const dbFile = values.db ? path.resolve(PROJECT_ROOT, values.db) : config.dbFile;
  if (!fs.existsSync(dbFile)) throw new Error(`数据库不存在：${dbFile}`);

  const outPath = values.out
    ? path.resolve(PROJECT_ROOT, values.out)
    : path.resolve(PROJECT_ROOT, 'data', `${values.video}-price-analysis.jsonl`);
  const db = openDb(dbFile);

  try {
    const roots = db.prepare(
      `SELECT rpid, parent, root, is_root, uname, content, ctime, like_count,
              sub_count, sub_fetched_count, sub_context_complete
         FROM comments
        WHERE bvid = ? AND is_root = 1
        ORDER BY like_count DESC, ctime DESC
        LIMIT ?`,
    ).all(values.video, limit) as unknown as ConversationSourceRow[];

    if (roots.length === 0) throw new Error(`没有查到视频评论：${values.video}`);

    const rootIds = roots.map((root) => root.rpid);
    const placeholders = rootIds.map(() => '?').join(', ');
    const replies = db.prepare(
      `SELECT rpid, parent, root, is_root, uname, content, ctime, like_count,
              sub_count, sub_fetched_count, sub_context_complete
         FROM comments
        WHERE bvid = ? AND is_root = 0 AND root IN (${placeholders})
        ORDER BY ctime ASC, rpid ASC`,
    ).all(values.video, ...rootIds) as unknown as ConversationSourceRow[];

    const conversations = assembleConversations([...roots, ...replies]);
    const client = createDeepSeekClient({
      apiKey: config.deepseekApiKey,
      model: config.deepseekModel,
      baseUrl: config.deepseekBaseUrl,
    });
    const outputLines: string[] = [];

    console.log(`准备分析 ${conversations.length} 个对话，模型：${config.deepseekModel}`);
    for (const [index, conversation] of conversations.entries()) {
      console.log(`[${index + 1}/${conversations.length}] ${conversation.conversationLabel}（${conversation.contextStatus}）`);
      try {
        const startedAt = Date.now();
        const response = await client.extractJson(buildPriceExtractionPrompt(conversation));
        const parsed = parseModelJson(response.content);
        const validation = validatePriceExtraction(parsed, conversation);
        outputLines.push(JSON.stringify({
          bvid: values.video,
          rootRpid: conversation.rootRpid,
          conversationLabel: conversation.conversationLabel,
          model: response.model,
          requestId: response.requestId,
          durationMs: Date.now() - startedAt,
          usage: response.usage,
          ok: validation.ok,
          extraction: validation.value,
          issues: validation.issues,
        }));
        console.log(`  ${validation.ok ? '完成' : '校验未通过'}，价格主张：${validation.value?.claims.length ?? 0}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputLines.push(JSON.stringify({
          bvid: values.video,
          rootRpid: conversation.rootRpid,
          conversationLabel: conversation.conversationLabel,
          ok: false,
          error: message,
        }));
        console.error(`  失败：${message}`);
      }
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${outputLines.join('\n')}\n`, 'utf8');
    console.log(`分析完成，结果已写入：${outPath}`);
  } finally {
    db.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}