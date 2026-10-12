/**
 * crawl.ts —— 【入口 1】抓取一个 B站视频的评论区，写入本地数据库
 *
 * 【用法示例】
 *   node src/crawl.ts --video BV1GJ411x7h7
 *   node src/crawl.ts --video https://www.bilibili.com/video/BV1GJ411x7h7 --pages 5
 *   node src/crawl.ts --video BV1GJ411x7h7 --mode 2 --with-replies
 *   node src/crawl.ts --video BV1GJ411x7h7 --db data/test.db
 *
 * 【参数说明】
 *   --video        必填。BV 号 / 完整视频链接 / b23.tv 短链
 *   --pages        最多抓多少页主评论，默认 3（每页 20 条）
 *   --mode         排序方式：3 = 热度排序（默认，高赞评论里信息更密）/ 2 = 时间排序
 *   --with-replies 是否顺带把每条一级评论下的楼中楼也抓下来（价格方案常藏在问答里）
 *   --sub-pages    每条一级评论最多抓多少页楼中楼，默认 5
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

/** 命令行帮助文本 */
const HELP_TEXT = `
抓取 B站视频评论区并存入本地 SQLite 数据库

用法：
  node src/crawl.ts --video <BV号或链接> [选项]

选项：
  --video        必填，BV 号 / 视频链接 / b23.tv 短链
  --pages        最多抓多少页主评论（默认 3，每页 20 条）
  --mode         3 = 热度排序（默认），2 = 时间排序
  --with-replies 顺带抓取楼中楼回复
  --sub-pages    每条一级评论最多抓多少页楼中楼（默认 5，仅 --with-replies 时生效）
  --db           数据库文件路径（默认 data/bilibili.db）
  -h, --help     显示本帮助

示例：
  node src/crawl.ts --video BV1GJ411x7h7 --pages 3
  node src/crawl.ts --video BV1GJ411x7h7 --pages 2 --with-replies
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

/**
 * 主流程。写成独立函数是为了能用 try/finally 保证数据库被正确关闭。
 */
async function main(): Promise<void> {
  // ——— 第 1 步：解析命令行参数 ———
  const { values } = parseArgs({
    options: {
      video: { type: 'string' }, // 视频标识
      pages: { type: 'string' }, // 抓取页数
      mode: { type: 'string' }, // 排序方式
      'with-replies': { type: 'boolean', default: false }, // 是否抓楼中楼
      'sub-pages': { type: 'string' }, // 楼中楼页数上限
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
  const maxPages = toInt(values.pages, 3); // 最多抓 3 页主评论
  const orderMode = toInt(values.mode, COMMENT_MODE.hot); // 默认热度排序
  const withReplies = values['with-replies']; // 是否抓楼中楼
  const subPages = toInt(values['sub-pages'], 5); // 楼中楼页数上限
  const config = loadConfig(); // 读 .env + 默认值
  // 数据库路径：命令行 --db 优先，否则用配置里的默认值
  const dbFile = values.db ? path.resolve(PROJECT_ROOT, values.db) : config.dbFile;

  // ——— 第 3 步：解析 BV 号 ———
  const bvid = await parseBvid(values.video);
  console.log('='.repeat(72));
  console.log(`目标视频：${bvid}`);
  console.log(`数据库：  ${dbFile}`);
  console.log(`排序方式：${orderMode === COMMENT_MODE.hot ? '热度' : '时间'}｜最多 ${maxPages} 页｜楼中楼：${withReplies ? `开启（每条最多 ${subPages} 页）` : '关闭'}`);
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

  // ——— 第 6 步：循环抓取评论页 ———
  // try/catch/finally 保证无论成功还是失败，都会写日志、关数据库
  try {
    // 翻页游标：第一页固定传 0，之后用上一页返回的 cursor.next
    let cursorNext = 0;

    // 一直抓到「达到页数上限」或「评论区到底」
    while (pageCount < maxPages) {
      // 抓一页主评论
      const page = await fetchCommentPage(client, {
        bvid, // 视频 BV 号
        oid: String(videoAid), // 评论区归属 id（视频就是 aid）
        mode: orderMode, // 排序方式
        next: cursorNext, // 翻页游标（只靠它翻页）
        ps: config.pageSize, // 每页条数
      });
      // 页数 +1
      pageCount += 1;

      // 本页要写库的全部评论：先放一级评论
      const collected = [...page.rows];

      // 可选：顺带展开楼中楼（价格方案经常藏在「怎么买的？」「买会员+抢券」这种对话里）
      if (withReplies) {
        for (const row of page.rows) {
          // 没有回复的评论直接跳过，省掉一次请求（这一步能大幅减少请求量）
          if (row.subCount <= 0) continue;
          // 抓这条一级评论下的楼中楼
          const subResult = await fetchSubComments(client, {
            bvid,
            oid: String(videoAid),
            root: row.rpid, // 要展开的一级评论 id
            ps: config.pageSize,
            maxPages: subPages, // 页数上限，防止极端评论刷爆请求量
          });
          // 完整性写回一级评论，供后续对话组装和 LLM 判断证据是否缺上下文。
          row.subFetchedCount = subResult.rows.length;
          row.subContextComplete = subResult.isComplete;
          // 追加到本批数据里
          collected.push(...subResult.rows);
          if (subResult.truncatedByLimit) {
            console.warn(
              `  ⚠️  一级评论 ${row.rpid} 的楼中楼达到 ${subPages} 页上限：已抓 ${subResult.rows.length}`
              + `${subResult.totalCount === null ? ' 条，总数未知' : `/${subResult.totalCount} 条`}，上下文已标记为不完整。`,
            );
          }
        }
      }

      // 整页（含楼中楼）一次性写库。UPSERT 保证重复抓取不会产生重复行
      const saved = insertComments(db, collected);
      savedCount += saved;

      // 打印本页进度
      console.log(
        `  第 ${pageCount} 页：一级评论 ${page.rows.length} 条，本页处理 ${saved} 条（累计 ${savedCount} 条）`,
      );

      // 这里只观察到了“成功响应但分页提前结束”，没有拿到 -101，不能直接断言登录失效。
      const totalCount = page.cursor.all_count ?? 0; // 评论区总条数
      if (pageCount === 1 && page.cursor.is_end && totalCount > page.rows.length) {
        const lines = [
          '',
          '⚠️  检测到「只能抓到很少的评论」：',
          `    B站显示该视频共有 ${totalCount} 条评论，但本次只返回了 ${page.rows.length} 条就结束了。`,
        ];
        if (config.sessdata) {
          lines.push(
            '    已配置 BILI_SESSDATA，但这次响应本身没有返回 -101，不能仅凭条数断言登录失效。',
            '    可能原因包括登录态未被认可、视频评论限制、接口策略或临时风控。',
            '    请运行 `npm run check:auth` 独立核实登录态，再根据结果处理。',
          );
        } else {
          lines.push(
            '    原因：未登录状态下 B站只放行少量评论（浏览器里也会提示“登录后查看更多评论”）。',
            '    解决：在项目根目录创建 .env 文件，填入 BILI_SESSDATA=你的SESSDATA 后重新运行。',
            '    获取方法见 .env.example 的说明；配置完可用 `npm run check:auth` 验证是否生效。',
          );
        }
        lines.push('');
        console.warn(lines.join('\n'));
      }

      // 已经到底，或这一页没有数据，就结束循环
      if (page.cursor.is_end || page.rows.length === 0) {
        console.log('  已到达评论区末尾');
        break;
      }

      // 更新游标，准备抓下一页（只用 cursor.next 这一个字段）
      cursorNext = page.cursor.next;
    }

    // 标记本次抓取成功
    finishCrawlLog(db, logId, 'success', pageCount, savedCount);

    // ——— 第 7 步：打印摘要（同时证明「数据确实存进去了」） ———
    // 直接查库统计这个视频真实有多少条评论（比 savedCount 更准确：重复抓取时不会重复计数）
    const total = db
      .prepare('SELECT COUNT(*) AS n FROM comments WHERE bvid = ?')
      .get(bvid) as { n: number } | undefined;

    console.log(`\n${'='.repeat(72)}`);
    console.log(`抓取完成：共 ${pageCount} 页，数据库中该视频现有评论 ${total?.n ?? 0} 条`);
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
