/**
 * query.ts —— 【入口 2】从数据库里读取数据
 *
 * 这个文件的存在，是为了证明「抓下来的数据确实可以被进一步读取和使用」。
 * 后续的价格抽取（从评论里抽出「1799 元 + 京东会员 + 10点抢券」）就是接在这一步之后。
 *
 * 【用法示例】
 *   node src/query.ts videos
 *   node src/query.ts comments --video BV1GJ411x7h7 --limit 20
 *   node src/query.ts comments --video BV1GJ411x7h7 --order like --root-only
 *   node src/query.ts search   --video BV1GJ411x7h7 --regex "\d{3,5}\s*(元|块)?"
 *   node src/query.ts export   --video BV1GJ411x7h7 --out data/BV1GJ411x7h7.jsonl
 *   node src/query.ts logs --limit 5
 *
 * 所有子命令都支持 --db 指定数据库文件（默认 data/bilibili.db）
 */

// Node 内置命令行参数解析器
import { parseArgs } from 'node:util';
// Node 内置文件系统模块（导出 JSONL 时要用）
import fs from 'node:fs';
// Node 内置路径模块
import path from 'node:path';
// 配置与项目根目录
import { PROJECT_ROOT, loadConfig } from './config.ts';
// 数据库层（读操作也复用同一个 openDb，保证表结构存在）
import { openDb } from './db.ts';
import { assembleConversations, type ConversationSourceRow } from './conversation.ts';

/** 帮助文本 */
const HELP_TEXT = `
从本地数据库读取 B站评论数据

用法：
  node src/query.ts <子命令> [选项]

子命令：
  videos     列出数据库里已有的视频
  comments   列出某个视频的评论
  conversations 组装一级评论与楼中楼，显示编号、时间、回复关系和上下文完整性
  search     在某个视频的评论里按正则搜索（价格抽取的第一步就是找数字）
  export     把某个视频的全部评论导出成 JSONL 文件
  logs       查看抓取日志

通用选项：
  --db       数据库文件路径（默认 data/bilibili.db）

  comments / conversations / search / export 选项：
  --video    视频 BV 号（必填）
  --limit    最多返回多少条（默认 20）
  --order    like = 按点赞数降序（默认），time = 按时间降序
  --root-only 只显示一级评论（不含楼中楼）
  --regex    正则表达式（仅 search 使用）
  --out      输出文件路径（export / conversations 使用）
`;

/** comments 表查询出来的一行（字段名对应数据库列名） */
interface CommentListRow {
  rpid: string; // 评论 id
  uname: string; // 昵称
  like_count: number; // 点赞数
  ctime: number; // 评论时间（秒级时间戳）
  sub_count: number; // 楼中楼条数
  is_root: number; // 1 一级评论 / 0 楼中楼
  content: string; // 正文
}

/** 把秒级时间戳格式化成可读时间 */
function formatTime(seconds: number): string {
  // 无效时间返回占位符
  if (!seconds || seconds <= 0) return '-';
  return new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false });
}

/** 把评论行整理成适合终端表格展示的形状（时间可读、正文截断） */
function toDisplayRows(rows: CommentListRow[]): Record<string, unknown>[] {
  return rows.map((row) => ({
    评论ID: row.rpid,
    昵称: row.uname,
    点赞: row.like_count,
    时间: formatTime(row.ctime),
    回复数: row.sub_count,
    类型: row.is_root === 1 ? '一级' : '楼中楼',
    // 正文太长会把表格撑爆，截断到 50 字
    内容: row.content.replace(/\s+/g, ' ').slice(0, 50),
  }));
}

/**
 * 主流程
 */
async function main(): Promise<void> {
  // 解析参数。子命令是「位置参数」（不带 -- 前缀），所以需要 allowPositionals
  const { values, positionals } = parseArgs({
    options: {
      db: { type: 'string' }, // 数据库路径
      video: { type: 'string' }, // 视频 BV 号
      limit: { type: 'string' }, // 条数上限
      order: { type: 'string' }, // 排序方式
      'root-only': { type: 'boolean', default: false }, // 只看一级评论
      regex: { type: 'string' }, // 正则
      out: { type: 'string' }, // 导出路径
      help: { type: 'boolean', short: 'h', default: false }, // 帮助
    },
    allowPositionals: true, // 允许位置参数（子命令）
  });

  // 第一个位置参数就是子命令
  const command = positionals[0] ?? '';

  // 没给子命令或明确要看帮助 → 打印帮助
  if (values.help || command === '' || command === 'help') {
    console.log(HELP_TEXT);
    return;
  }

  // 决定数据库文件路径
  const config = loadConfig();
  const dbFile = values.db ? path.resolve(PROJECT_ROOT, values.db) : config.dbFile;

  // 读数据前先确认数据库文件存在，否则提示用户先去抓取
  if (!fs.existsSync(dbFile)) {
    console.error(`数据库不存在：${dbFile}`);
    console.error('请先运行抓取命令，例如：node src/crawl.ts --video BV1GJ411x7h7');
    process.exitCode = 1;
    return;
  }

  // 打开数据库（openDb 内部会执行幂等的建表语句）
  const db = openDb(dbFile);
  // 条数上限：默认 20
  const limit = Number.parseInt(values.limit ?? '20', 10) || 20;

  try {
    // ---------- 子命令 1：videos ----------
    if (command === 'videos') {
      // 把所有视频按抓取时间倒序列出
      const rows = db
        .prepare(
          `SELECT v.bvid,
                  v.title,
                  v.up_name        AS UP主,
                  v.reply_count    AS 站方评论数,
                  COUNT(c.rpid)    AS 已入库评论数,
                  v.view_count     AS 播放量,
                  v.crawled_at     AS 抓取时间
             FROM videos v
             LEFT JOIN comments c ON c.bvid = v.bvid
            GROUP BY v.bvid
            ORDER BY v.crawled_at DESC`,
        )
        .all();

      // 空库时给出友好的提示
      if (rows.length === 0) {
        console.log('数据库里还没有视频，请先运行：node src/crawl.ts --video <BV号>');
        return;
      }

      console.log(`共 ${rows.length} 个视频：`);
      console.table(rows);
      return;
    }

    // ---------- 子命令 2：comments ----------
    if (command === 'comments') {
      // --video 是必填的，缺了就报错退出
      if (!values.video) {
        console.error('缺少 --video 参数，例如：--video BV1GJ411x7h7');
        process.exitCode = 1;
        return;
      }

      // 排序方式：like = 点赞降序，time = 时间降序
      const orderBy = values.order === 'time' ? 'ctime DESC' : 'like_count DESC';
      // 是否只查一级评论
      const rootFilter = values['root-only'] ? 'AND is_root = 1' : '';

      // 拼 SQL（orderBy 和 rootFilter 都来自固定枚举，不存在注入风险）
      const rows = db
        .prepare(
          `SELECT rpid, uname, like_count, ctime, sub_count, is_root, content
             FROM comments
            WHERE bvid = ? ${rootFilter}
            ORDER BY ${orderBy}
            LIMIT ?`,
        )
        .all(values.video, limit) as unknown as CommentListRow[];

      // 没有数据时提示可能的原因
      if (rows.length === 0) {
        console.log(`没有查到评论，请确认 BV 号是否正确：${values.video}`);
        return;
      }

      console.log(`视频 ${values.video} 的评论（最多 ${limit} 条，按${values.order === 'time' ? '时间' : '点赞'}排序）：`);
      console.table(toDisplayRows(rows));
      return;
    }

    // ---------- 子命令 3：conversations（为 LLM 组装可审计上下文） ----------
    if (command === 'conversations') {
      if (!values.video) {
        console.error('缺少 --video 参数，例如：--video BV1GJ411x7h7');
        process.exitCode = 1;
        return;
      }

      // limit 限制的是一级评论/对话数量，不是消息数量。先选根评论，再一次性取其回复，
      // 避免 SQL LIMIT 把某个对话从中间截断。
      const roots = db
        .prepare(
          `SELECT rpid, parent, root, is_root, uname, content, ctime, like_count,
                  sub_count, sub_fetched_count, sub_context_complete
             FROM comments
            WHERE bvid = ? AND is_root = 1
            ORDER BY like_count DESC, ctime ASC
            LIMIT ?`,
        )
        .all(values.video, limit) as unknown as ConversationSourceRow[];

      if (roots.length === 0) {
        console.log(`没有可组装的一级评论：${values.video}`);
        return;
      }

      const rootIds = roots.map((root) => root.rpid);
      const placeholders = rootIds.map(() => '?').join(', ');
      const replies = db
        .prepare(
          `SELECT rpid, parent, root, is_root, uname, content, ctime, like_count,
                  sub_count, sub_fetched_count, sub_context_complete
             FROM comments
            WHERE bvid = ? AND is_root = 0 AND root IN (${placeholders})
            ORDER BY ctime ASC, rpid ASC`,
        )
        .all(values.video, ...rootIds) as unknown as ConversationSourceRow[];

      const conversations = assembleConversations([...roots, ...replies]);
      const summary = conversations.map((conversation) => ({
        编号: conversation.conversationLabel,
        根评论ID: conversation.rootRpid,
        站方回复数: conversation.expectedReplyCount,
        已入库回复数: conversation.storedReplyCount,
        上下文状态: conversation.contextStatus,
      }));
      console.log(`视频 ${values.video}：组装 ${conversations.length} 个对话、${roots.length + replies.length} 条消息`);
      console.table(summary);

      for (const conversation of conversations) {
        console.log(`\n--- ${conversation.conversationLabel}｜context=${conversation.contextStatus}｜replies=${conversation.storedReplyCount}/${conversation.expectedReplyCount} ---`);
        console.log(conversation.text);
      }

      if (values.out) {
        const outPath = path.resolve(PROJECT_ROOT, values.out);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(
          outPath,
          `${conversations.map((conversation) => JSON.stringify(conversation)).join('\n')}\n`,
          'utf8',
        );
        console.log(`\n已导出对话 JSONL → ${outPath}`);
      }
      return;
    }

    // ---------- 子命令 4：search（价格抽取的第一步） ----------
    if (command === 'search') {
      // 两个必填参数校验
      if (!values.video) {
        console.error('缺少 --video 参数');
        process.exitCode = 1;
        return;
      }
      if (!values.regex) {
        console.error('缺少 --regex 参数，例如：--regex "\\d{3,5}"');
        process.exitCode = 1;
        return;
      }

      // 编译用户给的正则；用户可能写出非法正则，这里必须捕获异常
      let pattern: RegExp;
      try {
        // u 标志让正则在 Unicode 语义下工作，处理中文更安全
        pattern = new RegExp(values.regex, 'u');
      } catch (error) {
        console.error(`正则表达式非法：${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
      }

      // 取出该视频的全部评论（含楼中楼），按点赞降序
      // 【设计说明】SQLite 默认不带 REGEXP 函数，所以我们在 JS 内存里过滤。
      // 单视频的评论量通常在万级以内，内存过滤完全够用；等以后数据上百万条时再换 ES 或全文索引。
      const allRows = db
        .prepare(
          `SELECT rpid, uname, like_count, ctime, sub_count, is_root, content
             FROM comments
            WHERE bvid = ?
            ORDER BY like_count DESC`,
        )
        .all(values.video) as unknown as CommentListRow[];

      // 用正则筛出命中的评论（价格相关的句子必然包含数字）
      const matched = allRows.filter((row) => pattern.test(row.content));

      console.log(`共扫描 ${allRows.length} 条评论，命中 ${matched.length} 条（下面显示前 ${Math.min(limit, matched.length)} 条）`);

      // 没有命中时给出明确提示
      if (matched.length === 0) {
        console.log('没有命中任何评论，可以试试换个正则，例如："\\d{3,5}" 或 "(元|块|入手|拿下|到手)"');
        return;
      }

      // 把命中片段单独抓出来展示 —— 这就是「价格候选」的雏形
      const displayRows = matched.slice(0, limit).map((row) => {
        // 取第一次命中的原文片段
        const hit = pattern.exec(row.content);
        return {
          评论ID: row.rpid,
          昵称: row.uname,
          点赞: row.like_count,
          时间: formatTime(row.ctime),
          类型: row.is_root === 1 ? '一级' : '楼中楼',
          命中片段: hit?.[0] ?? '',
          内容: row.content.replace(/\s+/g, ' ').slice(0, 60),
        };
      });
      console.table(displayRows);
      return;
    }

    // ---------- 子命令 5：export（导出成 JSONL，方便其他程序消费） ----------
    if (command === 'export') {
      // 必填参数校验
      if (!values.video) {
        console.error('缺少 --video 参数');
        process.exitCode = 1;
        return;
      }

      // 导出全部字段、按时间正序，便于阅读上下文
      const rows = db
        .prepare('SELECT * FROM comments WHERE bvid = ? ORDER BY ctime ASC')
        .all(values.video) as unknown[];

      // 没有数据就不用建文件了
      if (rows.length === 0) {
        console.log(`没有可导出的评论：${values.video}`);
        return;
      }

      // 决定输出路径：命令行 --out 优先，否则默认 data/<BV号>.jsonl
      const outPath = values.out
        ? path.resolve(PROJECT_ROOT, values.out)
        : path.resolve(PROJECT_ROOT, 'data', `${values.video}.jsonl`);
      // 确保目录存在
      fs.mkdirSync(path.dirname(outPath), { recursive: true });

      // JSONL = 一行一个 JSON 对象。相比一个大数组，它支持流式读取，
      // 以后用 Python / Go / Node 逐行处理都不会爆内存
      const content = rows.map((row) => JSON.stringify(row)).join('\n');
      // 末尾补一个换行符，符合 Unix 文本文件习惯
      fs.writeFileSync(outPath, `${content}\n`, 'utf8');

      console.log(`已导出 ${rows.length} 条评论 → ${outPath}`);
      return;
    }

    // ---------- 子命令 6：logs（抓取流水） ----------
    if (command === 'logs') {
      // 按 id 倒序取最近的几条
      const rows = db
        .prepare(
          `SELECT id, bvid, status, pages AS 页数, saved AS 处理条数, error AS 错误, started_at AS 开始时间
             FROM crawl_logs
            ORDER BY id DESC
            LIMIT ?`,
        )
        .all(limit);
      console.log('最近的抓取日志：');
      console.table(rows);
      return;
    }

    // ---------- 未知子命令 ----------
    console.error(`未知的子命令：${command}`);
    console.log(HELP_TEXT);
    process.exitCode = 1;
  } finally {
    // 无论哪个分支返回，都要关闭数据库连接
    db.close();
  }
}

// 顶层 await 执行主流程，并把异常转成非 0 退出码
try {
  await main();
} catch (error) {
  console.error('程序异常退出：', error);
  process.exitCode = 1;
}
