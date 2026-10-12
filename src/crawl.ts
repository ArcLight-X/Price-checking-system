/**
 * crawl.ts —— 【入口 1】抓取一个 B站视频的评论区，写入本地数据库
 *
 * 【用法示例】
 *   node src/crawl.ts --video BV1GJ411x7h7
 *   node src/crawl.ts --video https://www.bilibili.com/video/BV1GJ411x7h7 --with-replies
 *   node src/crawl.ts --video BV1GJ411x7h7 --hot-limit 50 --recent-limit 30
 *   node src/crawl.ts --video BV1GJ411x7h7 --db data/test.db
 *
 * 【参数说明】
 *   --video        必填。BV 号 / 完整视频链接 / b23.tv 短链
 *   --hot-limit    按热度选多少条一级评论，默认 50
 *   --recent-limit 按时间选多少条最新一级评论，默认 30
 *   --with-replies 是否顺带把每条一级评论下的楼中楼也抓下来（价格方案常藏在问答里）
 *   --sub-limit    每条一级评论最多保留多少条楼中楼，默认 20
 *   --db           数据库文件路径，默认 data/bilibili.db
 *   -h, --help     打印帮助
 */

// Node 内置的命令行参数解析器，比手写 process.argv 判断可靠得多
import { parseArgs } from 'node:util';
// Node 内置路径模块，用来把相对路径解析成绝对路径
import path from 'node:path';
// 配置：数据库路径、请求间隔、SESSDATA 等
import { PROJECT_ROOT, loadConfig } from './config.ts';
// 数据库层：建库、写视频、写评论、写抓取日志
import { finishCrawlLog, insertComments, openDb, startCrawlLog, upsertVideo } from './db.ts';
// B站客户端：自动处理签名、限速、重试、Cookie
import { createBiliClient } from './bilibili/client.ts';
// B站业务接口：解析 BV 号、取视频信息、取评论
import { COMMENT_MODE, fetchCommentPage, fetchSubComments, fetchVideoInfo, parseBvid } from './bilibili/api.ts';
import { selectRootComments } from './comment-selection.ts';
import type { CommentRow } from './types.ts';

/** 命令行帮助文本 */
const HELP_TEXT = `
抓取 B站视频评论区并存入本地 SQLite 数据库

用法：
  node src/crawl.ts --video <BV号或链接> [选项]

选项：
  --video        必填，BV 号 / 视频链接 / b23.tv 短链
  --hot-limit    按热度选取的一级评论数（默认 50）
  --recent-limit 按时间选取的最新一级评论数（默认 30）
  --with-replies 顺带抓取楼中楼回复
  --sub-limit    每条一级评论最多保留多少条楼中楼（默认 20，仅 --with-replies 时生效）
  --db           数据库文件路径（默认 data/bilibili.db）
  -h, --help     显示本帮助

示例：
  node src/crawl.ts --video BV1GJ411x7h7
  node src/crawl.ts --video BV1GJ411x7h7 --with-replies --sub-limit 20
`;

/**
 * 把命令行传来的字符串安全地转成整数，非法值回退到默认值。
 * @param raw 原始字符串（可能为 undefined）
 * @param fallback 默认值
 */
function toInt(raw: string | undefined, fallback: number): number {
  // parseInt 解析失败会得到 NaN，用 isFinite 过滤
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 秒级时间戳 → 本地时间字符串，用于打印日志。
 * @param seconds 秒级 Unix 时间戳
 */
function formatTime(seconds: number): string {
  // 0 或负数说明没有有效时间，直接返回占位符
  if (!seconds || seconds <= 0) return '-';
  // 乘 1000 转成毫秒，再用中文区域格式输出
  return new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false });
}

/**
 * 截断过长的文本，避免把控制台刷爆。
 * @param text 原始文本
 * @param maxLength 保留的最大字符数
 */
function truncate(text: string, maxLength: number): string {
  // 先去掉换行符（评论里经常有换行，会把表格撑坏）
  const single = text.replace(/\s+/g, ' ').trim();
  // 超过长度就截断并加省略号
  return single.length > maxLength ? `${single.slice(0, maxLength)}…` : single;
}

interface RootStreamResult {
  rows: CommentRow[];
  pagesFetched: number;
  endedEarly: boolean;
  totalCount: number;
}

/** 按指定排序模式分页抓取一级评论，直到拿够目标条数或接口到底。 */
async function fetchRootStream(
  client: ReturnType<typeof createBiliClient>,
  args: { bvid: string; oid: string; mode: number; limit: number; pageSize: number },
): Promise<RootStreamResult> {
  const rows: CommentRow[] = [];
  const seen = new Set<string>();
  let cursorNext = 0;
  let pagesFetched = 0;
  let endedEarly = false;
  let totalCount = 0;

  while (rows.length < args.limit) {
    const page = await fetchCommentPage(client, {
      bvid: args.bvid,
      oid: args.oid,
      mode: args.mode,
      next: cursorNext,
      ps: args.pageSize,
    });
    pagesFetched += 1;
    totalCount = page.cursor.all_count ?? totalCount;

    for (const row of page.rows) {
      if (seen.has(row.rpid)) continue;
      seen.add(row.rpid);
      rows.push(row);
      if (rows.length >= args.limit) break;
    }

    if (page.cursor.is_end || page.rows.length === 0) {
      endedEarly = totalCount > rows.length;
      break;
    }
    cursorNext = page.cursor.next;
  }

  return { rows, pagesFetched, endedEarly, totalCount };
}

/**
 * 主流程。写成独立函数是为了能用 try/finally 保证数据库被正确关闭。
 */
async function main(): Promise<void> {
  // ——— 第 1 步：解析命令行参数 ———
  const { values } = parseArgs({
    options: {
      video: { type: 'string' }, // 视频标识
      'hot-limit': { type: 'string' }, // 热门一级评论条数
      'recent-limit': { type: 'string' }, // 最新一级评论条数
      'with-replies': { type: 'boolean', default: false }, // 是否抓楼中楼
      'sub-limit': { type: 'string' }, // 楼中楼条数上限
      db: { type: 'string' }, // 数据库路径
      help: { type: 'boolean', short: 'h', default: false }, // 帮助开关
    },
  });

  // 用户要看帮助，或者没给必填参数，都打印帮助后退出
  if (values.help || !values.video) {
    console.log(HELP_TEXT);
    // 没给 --video 属于用法错误，用非 0 退出码提示脚本调用方
    process.exitCode = values.help ? 0 : 1;
    return;
  }

  // ——— 第 2 步：把参数整理成最终值（命令行 > 配置文件 > 代码默认值） ———
  const hotLimit = Math.max(0, toInt(values['hot-limit'], 50));
  const recentLimit = Math.max(0, toInt(values['recent-limit'], 30));
  const withReplies = values['with-replies']; // 是否抓楼中楼
  const subLimit = Math.max(1, toInt(values['sub-limit'], 20)); // 每个对话最多保留 20 条楼中楼
  const config = loadConfig(); // 读 .env + 默认值
  // 数据库路径：命令行 --db 优先，否则用配置里的默认值
  const dbFile = values.db ? path.resolve(PROJECT_ROOT, values.db) : config.dbFile;

  // ——— 第 3 步：解析 BV 号 ———
  const bvid = await parseBvid(values.video);
  console.log('='.repeat(72));
  console.log(`目标视频：${bvid}`);
  console.log(`数据库：  ${dbFile}`);
  console.log(`一级评论：热门 ${hotLimit} 条 + 最新 ${recentLimit} 条（按 rpid 去重）`);
  console.log(`楼中楼：${withReplies ? `开启（每条一级评论最多保留前 ${subLimit} 条）` : '关闭'}`);
  console.log('='.repeat(72));

  // ——— 第 4 步：打开数据库 + 创建 B站客户端 ———
  const db = openDb(dbFile); // 建库建表（幂等）
  const client = createBiliClient({
    sessdata: config.sessdata, // 登录态（可选）
    buvid3: config.buvid3, // 设备指纹（可选，为空会自动申领）
    requestIntervalMs: config.requestIntervalMs, // 请求最小间隔
    maxRetries: config.maxRetries, // 重试次数
    userAgent: config.userAgent, // 伪装 UA
  });
  console.log(`Cookie 字段：${client.cookieSummary()}（SESSDATA 未配置时只能抓到前几页，且更容易被风控）`);

  // 开一条抓取日志，方便事后追溯本次抓取的成败
  const logId = startCrawlLog(db, bvid);
  // 统计变量：抓了多少页、处理了多少条评论
  let pageCount = 0;
  let savedCount = 0;
  // 视频的 av 号，评论接口要拿它当 oid 参数（先声明再在下面赋值，便于循环里使用）
  let videoAid = 0;

  try {
    // ——— 第 5 步：拿视频基本信息并入库 ———
    console.log('\n[1/2] 获取视频信息…');
    const video = await fetchVideoInfo(client, bvid);
    upsertVideo(db, video); // 写入（重复抓取会更新而不是新增）
    videoAid = video.aid; // 记住 aid，下面抓评论要用
    console.log(`  标题：${video.title}`);
    console.log(`  UP主：${video.upName}`);
    console.log(`  发布：${formatTime(video.pubdate)}｜播放：${video.view}｜B站统计评论数：${video.reply}`);
  } catch (error) {
    // 拿不到视频信息（比如 BV 号错误、视频已删除）就没必要继续了
    const message = error instanceof Error ? error.message : String(error);
    finishCrawlLog(db, logId, 'failed', pageCount, savedCount, message);
    db.close();
    console.error(`\n抓取失败：${message}`);
    process.exitCode = 1;
    return;
  }

  console.log('\n[2/2] 开始抓取评论…');

  // ——— 第 6 步：分别抓热门与最新评论，合并后再展开楼中楼 ———
  // try/catch/finally 保证无论成功还是失败，都会写日志、关数据库
  try {
    console.log(`  抓取热门评论候选（目标 ${hotLimit} 条）…`);
    const hotResult = await fetchRootStream(client, {
      bvid,
      oid: String(videoAid),
      mode: COMMENT_MODE.hot,
      limit: hotLimit,
      pageSize: config.pageSize,
    });
    pageCount += hotResult.pagesFetched;
    console.log(`    热门流：${hotResult.pagesFetched} 页，取得 ${hotResult.rows.length} 条`);

    console.log(`  抓取最新评论候选（目标 ${recentLimit} 条）…`);
    const recentResult = await fetchRootStream(client, {
      bvid,
      oid: String(videoAid),
      mode: COMMENT_MODE.time,
      limit: recentLimit,
      pageSize: config.pageSize,
    });
    pageCount += recentResult.pagesFetched;
    console.log(`    最新流：${recentResult.pagesFetched} 页，取得 ${recentResult.rows.length} 条`);

    const selection = selectRootComments(hotResult.rows, recentResult.rows, hotLimit, recentLimit);
    const collected = [...selection.rows];
    console.log(
      `  一级评论合并：热门 ${selection.hotRows.length} + 最新 ${selection.recentRows.length}`
      + ` - 重叠 ${selection.overlapCount} = 去重后 ${selection.rows.length} 条`,
    );

    // 可选：每条已去重的一级评论最多展开前 N 条楼中楼。
    if (withReplies) {
      for (const [index, row] of selection.rows.entries()) {
        if (row.subCount <= 0) continue;
        const subResult = await fetchSubComments(client, {
          bvid,
          oid: String(videoAid),
          root: row.rpid,
          ps: config.pageSize,
          maxReplies: subLimit,
        });
        row.subFetchedCount = subResult.rows.length;
        row.subContextComplete = subResult.isComplete;
        collected.push(...subResult.rows);
        console.log(
          `    [${index + 1}/${selection.rows.length}] 楼中楼 ${row.rpid}：`
          + `${subResult.rows.length}${subResult.totalCount === null ? '' : `/${subResult.totalCount}`} 条`
          + `${subResult.truncatedByLimit ? '（已截断）' : ''}`,
        );
      }
    }

    savedCount = insertComments(db, collected);
    console.log(`  本次处理：一级评论 ${selection.rows.length} 条，含楼中楼共 ${savedCount} 条`);

    // 两条流都提前结束时才提示分页受限；这里只陈述成功响应的观察结果，不伪造 -101。
    if (hotResult.endedEarly && recentResult.endedEarly) {
      const observedTotal = Math.max(hotResult.totalCount, recentResult.totalCount);
      const lines = [
        '',
        '⚠️  热门流和最新流都在达到目标条数前结束：',
        `    B站显示约有 ${observedTotal} 条评论，本次热门取得 ${hotResult.rows.length} 条、最新取得 ${recentResult.rows.length} 条。`,
      ];
      if (config.sessdata) {
        lines.push(
          '    这次响应本身没有返回 -101，不能仅凭条数断言登录失效。',
          '    请运行 `npm run check:auth` 独立核实登录态，也可能是视频限制、接口策略或临时风控。',
        );
      } else {
        lines.push(
          '    未配置 SESSDATA 时 B站通常只放行少量评论。请配置后运行 `npm run check:auth` 验证。',
        );
      }
      lines.push('');
      console.warn(lines.join('\n'));
    }

    // 标记本次抓取成功
    finishCrawlLog(db, logId, 'success', pageCount, savedCount);

    // ——— 第 7 步：打印摘要（同时证明「数据确实存进去了」） ———
    // 直接查库统计这个视频真实有多少条评论（比 savedCount 更准确：重复抓取时不会重复计数）
    const total = db
      .prepare('SELECT COUNT(*) AS n FROM comments WHERE bvid = ?')
      .get(bvid) as { n: number } | undefined;

    console.log(`\n${'='.repeat(72)}`);
    console.log(`抓取完成：主评论接口共请求 ${pageCount} 页，数据库中该视频现有评论 ${total?.n ?? 0} 条`);
    console.log('='.repeat(72));

    // 打印点赞最高的 10 条一级评论，快速确认抓到的内容是否正常
    const topRows = db
      .prepare(
        `SELECT uname AS 昵称, like_count AS 点赞, content AS 内容
           FROM comments
          WHERE bvid = ? AND is_root = 1
          ORDER BY like_count DESC
          LIMIT 10`,
      )
      .all(bvid);
    console.log('\n点赞最高的 10 条评论：');
    console.table(topRows);

    // 提示下一步如何读取这批数据（对应 query.ts 的用法）
    console.log('\n下一步这样读取数据：');
    console.log('  node src/query.ts videos');
    console.log(`  node src/query.ts comments --video ${bvid} --limit 20`);
    console.log(`  node src/query.ts search --video ${bvid} --regex "\\d{3,5}"`);
  } catch (error) {
    // 出错时把失败原因写进日志表，方便事后查看
    const message = error instanceof Error ? error.message : String(error);
    finishCrawlLog(db, logId, 'failed', pageCount, savedCount, message);
    console.error(`\n抓取中断：${message}`);
    process.exitCode = 1;
  } finally {
    // 无论成功失败都要关闭数据库连接，确保 WAL 日志落盘
    db.close();
  }
}

// 顶层 await 在 ESM 中合法（package.json 里声明了 "type": "module"）
// 用 try/catch 兜住所有未预期错误，保证进程退出码正确（方便将来接入调度器）
try {
  await main();
} catch (error) {
  console.error('程序异常退出：', error);
  process.exitCode = 1;
}
