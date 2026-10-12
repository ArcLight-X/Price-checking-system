/** research.ts —— 输入商品名，自动搜索 B站视频、抓评论并调用 DeepSeek 提取价格。 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fetchVideoSearch } from './bilibili/api.ts';
import { createBiliClient } from './bilibili/client.ts';
import { crawlVideoComments } from './comment-crawler.ts';
import { PROJECT_ROOT, loadConfig } from './config.ts';
import { assembleConversations, type ConversationSourceRow } from './conversation.ts';
import { createDeepSeekClient, parseModelJson } from './deepseek.ts';
import { insertComments, openDb, upsertVideo } from './db.ts';
import { buildPriceExtractionPrompt } from './extractor/prompt.ts';
import { validatePriceExtraction } from './extractor/validator.ts';
import { selectResearchConversations } from './research-selection.ts';
import type { CommentRow } from './types.ts';

const HELP_TEXT = `
输入商品名称，自动搜索 B站视频、抓取评论并使用 DeepSeek 分析价格

用法：
  node src/research.ts --product <商品名称> [选项]

选项：
  --product             必填，例如 "RTX 5070 Ti"
  --video-limit         搜索并处理多少个视频（默认 3）
  --conversation-limit  每个视频最多分析多少个价格候选对话（默认 10）
  --hot-limit           每个视频抓多少条热门一级评论（默认 20）
  --recent-limit        每个视频抓多少条最新一级评论（默认 10）
  --sub-limit           每条一级评论最多抓多少条楼中楼（默认 10）
  --out                 输出 JSONL 路径
  --db                  SQLite 数据库路径（默认 data/bilibili.db）
  -h, --help            显示帮助

需要在 .env 中配置 DEEPSEEK_API_KEY；建议同时配置 BILI_SESSDATA。
`;

function toPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeFileName(value: string): string {
  const cleaned = value.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, '-');
  return cleaned.slice(0, 80) || 'product';
}

function toConversationRow(row: CommentRow): ConversationSourceRow {
  return {
    rpid: row.rpid,
    parent: row.parent,
    root: row.root,
    is_root: row.isRoot ? 1 : 0,
    uname: row.uname,
    content: row.content,
    ctime: row.ctime,
    like_count: row.likeCount,
    sub_count: row.subCount,
    sub_fetched_count: row.subFetchedCount,
    sub_context_complete: row.subContextComplete === null ? null : row.subContextComplete ? 1 : 0,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      product: { type: 'string' },
      'video-limit': { type: 'string' },
      'conversation-limit': { type: 'string' },
      'hot-limit': { type: 'string' },
      'recent-limit': { type: 'string' },
      'sub-limit': { type: 'string' },
      out: { type: 'string' },
      db: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(HELP_TEXT);
    return;
  }
  const product = values.product?.trim() ?? '';
  if (!product) throw new Error('缺少 --product 参数，例如：--product "RTX 5070 Ti"');

  const config = loadConfig();
  if (!config.deepseekApiKey) {
    throw new Error('未配置 DEEPSEEK_API_KEY，请先在项目根目录的 .env 中填写');
  }

  const videoLimit = toPositiveInt(values['video-limit'], 3);
  const conversationLimit = toPositiveInt(values['conversation-limit'], 10);
  const hotLimit = toPositiveInt(values['hot-limit'], 20);
  const recentLimit = toPositiveInt(values['recent-limit'], 10);
  const subLimit = toPositiveInt(values['sub-limit'], 10);
  const dbFile = values.db ? path.resolve(PROJECT_ROOT, values.db) : config.dbFile;
  const outPath = values.out
    ? path.resolve(PROJECT_ROOT, values.out)
    : path.resolve(PROJECT_ROOT, 'data', `${safeFileName(product)}-research.jsonl`);

  const biliClient = createBiliClient({
    sessdata: config.sessdata,
    buvid3: config.buvid3,
    requestIntervalMs: config.requestIntervalMs,
    maxRetries: config.maxRetries,
    userAgent: config.userAgent,
  });
  const deepseek = createDeepSeekClient({
    apiKey: config.deepseekApiKey,
    baseUrl: config.deepseekBaseUrl,
    model: config.deepseekModel,
  });
  const db = openDb(dbFile);
  const outputLines: string[] = [];

  try {
    const searchKeyword = `${product} 价格`;
    console.log(`搜索商品相关视频：${searchKeyword}`);
    const videos = await fetchVideoSearch(biliClient, searchKeyword, videoLimit);
    if (videos.length === 0) throw new Error(`B站没有返回与“${product}”相关的视频`);

    console.table(videos.map((video, index) => ({
      序号: index + 1,
      BV号: video.bvid,
      标题: video.title,
      UP主: video.author,
      播放: video.play,
      评论: video.review,
    })));

    for (const [videoIndex, searchVideo] of videos.entries()) {
      console.log(`\n[视频 ${videoIndex + 1}/${videos.length}] ${searchVideo.bvid} ${searchVideo.title}`);
      try {
        const crawled = await crawlVideoComments(biliClient, searchVideo.bvid, {
          hotLimit,
          recentLimit,
          subLimit,
          pageSize: config.pageSize,
          withReplies: true,
        });
        upsertVideo(db, crawled.video);
        insertComments(db, crawled.rows);

        const conversations = assembleConversations(crawled.rows.map(toConversationRow));
        const candidates = selectResearchConversations(conversations, product, conversationLimit);
        console.log(
          `  抓取 ${crawled.selection.rows.length} 条一级评论，组装 ${conversations.length} 个对话，`
          + `筛出 ${candidates.length} 个价格候选`,
        );

        if (candidates.length === 0) {
          outputLines.push(JSON.stringify({
            product,
            bvid: searchVideo.bvid,
            videoTitle: crawled.video.title,
            ok: true,
            skipped: true,
            reason: '没有发现包含价格信号的评论对话',
          }));
          continue;
        }

        for (const [candidateIndex, conversation] of candidates.entries()) {
          console.log(`  [分析 ${candidateIndex + 1}/${candidates.length}] ${conversation.conversationLabel}`);
          const startedAt = Date.now();
          try {
            const response = await deepseek.extractJson(buildPriceExtractionPrompt(conversation, {
              targetProduct: product,
              videoTitle: crawled.video.title,
            }));
            const validation = validatePriceExtraction(parseModelJson(response.content), conversation);
            outputLines.push(JSON.stringify({
              product,
              bvid: searchVideo.bvid,
              videoTitle: crawled.video.title,
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
          } catch (error) {
            outputLines.push(JSON.stringify({
              product,
              bvid: searchVideo.bvid,
              videoTitle: crawled.video.title,
              rootRpid: conversation.rootRpid,
              conversationLabel: conversation.conversationLabel,
              durationMs: Date.now() - startedAt,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  视频处理失败：${message}`);
        outputLines.push(JSON.stringify({
          product,
          bvid: searchVideo.bvid,
          videoTitle: searchVideo.title,
          ok: false,
          error: message,
        }));
      }
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${outputLines.join('\n')}\n`, 'utf8');
    console.log(`\n商品研究完成：${outPath}`);
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