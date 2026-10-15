/** research.ts —— 输入商品名，自动搜索 B站视频、抓评论并调用豆包 Seed 提取价格。 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fetchVideoSearch } from './bilibili/api.ts';
import { createBiliClient } from './bilibili/client.ts';
import { crawlVideoComments } from './comment-crawler.ts';
import { PROJECT_ROOT, loadConfig } from './config.ts';
import { assembleConversations, type CommentConversation, type ConversationSourceRow } from './conversation.ts';
import { createArkClient, isFatalArkApiError, parseModelJson } from './ark.ts';
import { insertComments, openDb, upsertVideo } from './db.ts';
import { buildPriceExtractionPrompt } from './extractor/prompt.ts';
import { validatePriceExtraction } from './extractor/validator.ts';
import {
  MIN_RESEARCH_VIDEO_PLAY,
  hasEnoughPlays,
  matchesRequestedProduct,
  selectResearchConversations,
} from './research-selection.ts';
import type { PriceClaim } from './extractor/types.ts';
import { forEachConcurrent } from './concurrency.ts';
import { summaryToCsv, toSummaryRow } from './research-output.ts';
import { loadResearchCache, promptFingerprint, saveResearchCache } from './research-cache.ts';

const HELP_TEXT = `
输入商品名称，自动搜索 B站视频、抓取评论并使用豆包 Seed 分析价格
只处理播放量不少于 ${MIN_RESEARCH_VIDEO_PLAY} 的视频。

用法：
  node src/research.ts --product <商品名称> [选项]

选项：
  --product             必填，例如 "RTX 5070 Ti"
  --video-limit         搜索并处理多少个视频（默认 3）
  --conversation-limit  每个视频最多分析多少个价格候选对话（默认 10）
  --llm-concurrency     同时调用模型的请求数（默认 3，设为 1 可恢复串行）
  --no-cache            不复用此前相同输入的成功模型分析（仍会保存新结果）
  --hot-limit           每个视频抓多少条热门一级评论（默认 20）
  --recent-limit        每个视频抓多少条最新一级评论（默认 10）
  --sub-limit           每条一级评论最多抓多少条楼中楼（默认 10）
  --out                 输出 JSONL 路径
  --csv                 摘要 CSV 路径（默认与 JSONL 同名，仅扩展名为 .csv）
  --db                  SQLite 数据库路径（默认 data/bilibili.db）
  -h, --help            显示帮助

需要在 .env 中配置 ARK_API_KEY；建议同时配置 BILI_SESSDATA。
`;

function toPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeFileName(value: string): string {
  const cleaned = value.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, '-');
  return cleaned.slice(0, 80) || 'product';
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[\s\-_+·.,，。/\\()[\]（）]/g, '');
}

function productParts(value: string): string[] {
  return value.toLowerCase().match(/[a-z]+|\d+[a-z]*|[\u4e00-\u9fff]{2,}/g) ?? [];
}

function loadStoredVideos(
  db: ReturnType<typeof openDb>,
): Awaited<ReturnType<typeof fetchVideoSearch>> {
  const rows = db.prepare(
    `SELECT bvid, title, up_name AS author, view_count AS play,
            reply_count AS review, pubdate
       FROM videos`,
  ).all() as Array<{
    bvid: string;
    title: string;
    author: string;
    play: number;
    review: number;
    pubdate: number;
  }>;
  return rows;
}

async function searchResearchVideos(
  client: ReturnType<typeof createBiliClient>,
  db: ReturnType<typeof openDb>,
  product: string,
  limit: number,
): Promise<Awaited<ReturnType<typeof fetchVideoSearch>>> {
  const keywords = [`${product} 价格`, `${product} 好价`, `${product} 入手价`];
  const rows: Awaited<ReturnType<typeof fetchVideoSearch>> = [];
  for (const keyword of keywords) {
    rows.push(...await fetchVideoSearch(client, keyword, 20));
  }
  rows.push(...loadStoredVideos(db));
  const unique = new Map(rows.map((row) => [row.bvid, row]));
  const normalizedProduct = normalizeSearchText(product);
  const targetParts = productParts(product).map(normalizeSearchText).filter((part) => part.length >= 2);
  return [...unique.values()]
    .filter(hasEnoughPlays)
    .filter((row) => matchesRequestedProduct(row.title, product))
    .map((row) => {
      const title = normalizeSearchText(row.title);
      const productMatch = title.includes(normalizedProduct);
      const matchedParts = targetParts.filter((part) => title.includes(part)).length;
      const priceIntent = /价格|好价|低价|入手|到手|多少钱|选购|优惠|双十一|618/i.test(row.title);
      const storedRows = loadStoredConversationRows(db, row.bvid);
      const hasStoredPriceCandidate = storedRows.length > 0
        && selectResearchConversations(
          assembleConversations(storedRows), product, 1, { videoTitle: row.title },
        ).length > 0;
      return {
        row,
        matchedParts,
        score: (hasStoredPriceCandidate ? 100 : 0) + (productMatch ? 20 : 0)
          + matchedParts * 4 + (priceIntent ? 10 : 0) + Math.log10(row.review + 1),
      };
    })
    .filter((item) => item.matchedParts > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item) => item.row);
}

function loadStoredConversationRows(
  db: ReturnType<typeof openDb>,
  bvid: string,
): ConversationSourceRow[] {
  return db.prepare(
    `SELECT rpid, parent, root, is_root, uname, content, ctime, like_count,
            sub_count, sub_fetched_count, sub_context_complete
       FROM comments
      WHERE bvid = ?
      ORDER BY is_root DESC, ctime ASC, rpid ASC`,
  ).all(bvid) as unknown as ConversationSourceRow[];
}

function createVideoTitleConversation(title: string): CommentConversation {
  return {
    conversationLabel: 'V001',
    rootRpid: 'video-title',
    expectedReplyCount: 0,
    storedReplyCount: 0,
    contextStatus: 'complete',
    messages: [{
      label: 'V001',
      rpid: 'video-title',
      parentRpid: null,
      parentLabel: null,
      relation: 'root',
      uname: '视频标题',
      content: title,
      ctime: 0,
      timeIso: 'unknown',
      likeCount: 0,
    }],
    text: `[V001] 视频标题: ${title}`,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      product: { type: 'string' },
      'video-limit': { type: 'string' },
      'conversation-limit': { type: 'string' },
      'llm-concurrency': { type: 'string' },
      'no-cache': { type: 'boolean', default: false },
      'hot-limit': { type: 'string' },
      'recent-limit': { type: 'string' },
      'sub-limit': { type: 'string' },
      out: { type: 'string' },
      csv: { type: 'string' },
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
  if (!config.arkApiKey) {
    throw new Error('未配置 ARK_API_KEY，请先在项目根目录的 .env 中填写');
  }

  const videoLimit = toPositiveInt(values['video-limit'], 3);
  const conversationLimit = toPositiveInt(values['conversation-limit'], 10);
  const llmConcurrency = toPositiveInt(values['llm-concurrency'], 3);
  const cacheDir = path.resolve(PROJECT_ROOT, 'data', 'research-cache');
  const runStartedAt = Date.now();
  const hotLimit = toPositiveInt(values['hot-limit'], 20);
  const recentLimit = toPositiveInt(values['recent-limit'], 10);
  const subLimit = toPositiveInt(values['sub-limit'], 10);
  const dbFile = values.db ? path.resolve(PROJECT_ROOT, values.db) : config.dbFile;
  const outPath = values.out
    ? path.resolve(PROJECT_ROOT, values.out)
    : path.resolve(PROJECT_ROOT, 'data', `${safeFileName(product)}-research.jsonl`);
  const csvPath = values.csv
    ? path.resolve(PROJECT_ROOT, values.csv)
    : path.join(path.dirname(outPath), `${path.parse(outPath).name}.csv`);
  if (csvPath.toLowerCase() === outPath.toLowerCase()) throw new Error('CSV 路径不能与 JSONL 路径相同');

  const biliClient = createBiliClient({
    sessdata: config.sessdata,
    buvid3: config.buvid3,
    requestIntervalMs: config.requestIntervalMs,
    maxRetries: config.maxRetries,
    userAgent: config.userAgent,
  });
  const ark = createArkClient({
    apiKey: config.arkApiKey,
    baseUrl: config.arkBaseUrl,
    model: config.arkModel,
  });
  const db = openDb(dbFile);
  const outputLines: string[] = [];
  const summaryRows: Record<string, unknown>[] = [];
  let failedCount = 0;
  let analyzedCount = 0;
  let cacheHits = 0;

  try {
    const searchStartedAt = Date.now();
    console.log(`搜索商品相关视频：${product}（价格 / 好价 / 入手价，播放量 >= ${MIN_RESEARCH_VIDEO_PLAY}）`);
    const videos = await searchResearchVideos(biliClient, db, product, videoLimit);
    console.log(`搜索耗时：${((Date.now() - searchStartedAt) / 1000).toFixed(1)} 秒；模型并发：${llmConcurrency}`);
    if (videos.length === 0) throw new Error(`没有找到播放量达到 ${MIN_RESEARCH_VIDEO_PLAY} 的“${product}”相关视频`);

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
        const crawlStartedAt = Date.now();
        const crawled = await crawlVideoComments(biliClient, searchVideo.bvid, {
          hotLimit,
          recentLimit,
          subLimit,
          pageSize: config.pageSize,
          withReplies: true,
        });
        upsertVideo(db, crawled.video);
        insertComments(db, crawled.rows);
        console.log(`  抓取耗时：${((Date.now() - crawlStartedAt) / 1000).toFixed(1)} 秒`);

        // 使用数据库中该视频的全部历史抓取结果，避免接口临时只返回少量评论时丢掉已有楼中楼。
        const storedRows = loadStoredConversationRows(db, searchVideo.bvid);
        const conversations = assembleConversations(storedRows);
        const titleCandidates = selectResearchConversations(
          [createVideoTitleConversation(crawled.video.title)], product, 1,
        );
        const commentCandidates = selectResearchConversations(
          conversations, product, conversationLimit, { videoTitle: crawled.video.title },
        );
        const candidates = [...titleCandidates, ...commentCandidates].slice(0, conversationLimit);
        console.log(
          `  抓取 ${crawled.selection.rows.length} 条一级评论，组装 ${conversations.length} 个对话，`
          + `筛出 ${candidates.length} 个价格候选${titleCandidates.length > 0 ? '（含视频标题价格）' : ''}`,
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

        const analysisStartedAt = Date.now();
        await forEachConcurrent(candidates, llmConcurrency, async (conversation, candidateIndex) => {
          console.log(`  [分析 ${candidateIndex + 1}/${candidates.length}] ${conversation.conversationLabel}`);
          const startedAt = Date.now();
          try {
            const prompt = buildPriceExtractionPrompt(conversation, {
              targetProduct: product,
              videoTitle: crawled.video.title,
            });
            const promptHash = promptFingerprint(config.arkModel, prompt, searchVideo.bvid);
            const cached = values['no-cache'] ? null : loadResearchCache(path.join(cacheDir, `${promptHash}.json`), promptHash);
            let record: Record<string, unknown>;
            if (cached) {
              cacheHits += 1;
              record = {
                ...cached, product, bvid: searchVideo.bvid, videoTitle: crawled.video.title,
                rootRpid: conversation.rootRpid, conversationLabel: conversation.conversationLabel,
                cached: true, durationMs: 0,
              };
            } else {
              const response = await ark.extractJson(prompt);
              const validation = validatePriceExtraction(parseModelJson(response.content), conversation, {
                targetProduct: product,
              });
              analyzedCount += 1;
              record = {
                product, bvid: searchVideo.bvid, videoTitle: crawled.video.title,
                rootRpid: conversation.rootRpid, conversationLabel: conversation.conversationLabel,
                promptHash, model: response.model, requestId: response.requestId,
                durationMs: Date.now() - startedAt, usage: response.usage,
                ok: validation.ok, extraction: validation.value, issues: validation.issues,
                rawModelOutput: validation.ok ? undefined : response.content,
              };
              if (validation.ok && validation.value) {
                try {
                  saveResearchCache(path.join(cacheDir, `${promptHash}.json`), {
                    ...record, promptHash, ok: true, extraction: validation.value, issues: validation.issues,
                  });
                } catch (cacheError) {
                  console.warn(`  缓存写入失败（仍保留本次分析结果）：${cacheError instanceof Error ? cacheError.message : String(cacheError)}`);
                }
              }
            }
            outputLines.push(JSON.stringify(record));
            const extraction = record['extraction'] as { claims?: PriceClaim[] } | null;
            for (const claim of extraction?.claims ?? []) {
              const row = toSummaryRow(claim, product, searchVideo.bvid);
              if (row) summaryRows.push(row);
            }
          } catch (error) {
            if (isFatalArkApiError(error)) throw error;
            failedCount += 1;
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
        });
        console.log(`  分析耗时：${((Date.now() - analysisStartedAt) / 1000).toFixed(1)} 秒`);
      } catch (error) {
        if (isFatalArkApiError(error)) throw error;
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

    console.log('\n价格与购买方案摘要：');
    if (summaryRows.length > 0) {
      console.table(summaryRows);
      console.log('注意：以上来自评论历史报告或未核验线索，不代表当前仍可购买。');
    } else {
      console.log(`没有同时提取到明确金额和具体方案。新分析 ${analyzedCount} 个候选，缓存命中 ${cacheHits} 个，对话失败 ${failedCount} 个。`);
      console.log('可以提高 --video-limit、--hot-limit、--recent-limit 或 --conversation-limit 后重试。');
    }
    console.log(`完整结果：${outPath}`);
    console.log(`筛选摘要 CSV：${csvPath}`);
    console.log(`新分析 ${analyzedCount} 个，复用缓存 ${cacheHits} 个，失败 ${failedCount} 个。`);
    console.log(`总耗时：${((Date.now() - runStartedAt) / 1000).toFixed(1)} 秒`);
  } finally {
    try {
      // 包括致命 API 错误：已完成的模型结果仍应保留，避免下次重做已付费请求。
      if (outputLines.length > 0) {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, `${outputLines.join('\n')}\n`, 'utf8');
        fs.mkdirSync(path.dirname(csvPath), { recursive: true });
        fs.writeFileSync(csvPath, summaryToCsv(summaryRows), 'utf8');
      }
    } finally {
      db.close();
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}