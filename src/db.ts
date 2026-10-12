/**
 * db.ts —— SQLite 数据库层（建库、建表、写入封装）
 *
 * 【为什么用 SQLite】
 *   1. 单文件，拷走就能用，不需要安装和启动任何数据库服务
 *   2. 任何 SQL 工具都能直接打开，数据「可进一步读取」这点天然满足
 *   3. 用的是 Node 24 内置的 node:sqlite 模块，连 npm 依赖都不需要
 *
 * 【三张表】
 *   videos     一个视频一行：标题、UP主、播放量、评论总数等
 *   comments   一条评论一行：一级评论和楼中楼都在这张表里，用 is_root 区分
 *   crawl_logs 每次抓取的流水日志：抓了几页、存了几条、成功还是失败
 */

// Node 内置文件系统模块，用来创建数据目录
import fs from 'node:fs';
// Node 内置路径模块，用来解析数据库文件的父目录
import path from 'node:path';
// Node 内置 SQLite（Node 22.5+ 提供，本阶段直接用，无需 npm install）
import { DatabaseSync } from 'node:sqlite';
// 只做类型引用
import type { CommentRow, VideoRow } from './types.ts';

/**
 * 建表语句。全部使用 IF NOT EXISTS，所以反复执行是安全的（幂等），
 * 每次启动程序都可以无脑跑一遍，不用担心把已有数据清掉。
 */
const SCHEMA_SQL = `
-- ============ 表 1：视频元信息 ============
CREATE TABLE IF NOT EXISTS videos (
  bvid         TEXT PRIMARY KEY,   -- BV 号，主键
  aid          INTEGER NOT NULL,   -- av 号（评论接口要用它当 oid）
  title        TEXT,               -- 视频标题
  up_name      TEXT,               -- UP主昵称
  up_mid       TEXT,               -- UP主 uid（字符串存，防精度丢失）
  pubdate      INTEGER,            -- 发布时间（秒级时间戳）
  duration     INTEGER,            -- 时长（秒）
  view_count   INTEGER,            -- 播放量
  danmaku_cnt  INTEGER,            -- 弹幕数
  reply_count  INTEGER,            -- 评论总数（B站统计值）
  like_count   INTEGER,            -- 点赞数
  coin_count   INTEGER,            -- 投币数
  fav_count    INTEGER,            -- 收藏数
  description  TEXT,               -- 视频简介
  url          TEXT,               -- 视频页面地址
  crawled_at   INTEGER NOT NULL    -- 本行最后一次写入时间
);

-- ============ 表 2：评论（一级评论 + 楼中楼共用） ============
CREATE TABLE IF NOT EXISTS comments (
  rpid       TEXT PRIMARY KEY,     -- 评论 id（字符串存，防精度丢失）
  bvid       TEXT NOT NULL,        -- 所属视频 BV 号
  oid        TEXT NOT NULL,        -- 评论区归属 id（= aid）
  parent     TEXT NOT NULL,        -- 父评论 id，一级评论为 '0'
  root       TEXT NOT NULL,        -- 根评论 id，一级评论为 '0'
  is_root    INTEGER NOT NULL,     -- 1 = 一级评论，0 = 楼中楼
  uname      TEXT,                 -- 评论者昵称（只存公开昵称）
  content    TEXT NOT NULL,        -- 评论正文（后续价格抽取的输入）
  like_count INTEGER,              -- 点赞数
  ctime      INTEGER,              -- 评论时间（秒级时间戳）
  location   TEXT,                 -- IP 归属地
  sub_count  INTEGER,              -- 楼中楼条数
  sub_fetched_count INTEGER,       -- 已抓楼中楼数量；NULL = 未展开/未知
  sub_context_complete INTEGER,    -- NULL = 未核实，0 = 截断，1 = 已抓完
  raw        TEXT,                 -- B站原始 JSON，便于以后重新解析
  crawled_at INTEGER NOT NULL      -- 抓取时间
);

-- ============ 表 3：抓取流水日志 ============
CREATE TABLE IF NOT EXISTS crawl_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT, -- 自增主键
  bvid        TEXT NOT NULL,      -- 本次抓的是哪个视频
  started_at  INTEGER NOT NULL,   -- 开始时间
  finished_at INTEGER,            -- 结束时间（没结束就是 NULL）
  pages       INTEGER DEFAULT 0,  -- 抓了多少页
  saved       INTEGER DEFAULT 0,  -- 写入/更新了多少条评论
  status      TEXT NOT NULL,      -- running / success / failed
  error       TEXT                -- 失败原因
);

-- 索引：按视频查评论是最常用的查询，必须建索引，否则数据一多就慢
CREATE INDEX IF NOT EXISTS idx_comments_bvid   ON comments(bvid);
-- 索引：按时间排序/过滤（判断价格时效性会用到）
CREATE INDEX IF NOT EXISTS idx_comments_ctime  ON comments(ctime);
-- 索引：展开某个一级评论的楼中楼时用
CREATE INDEX IF NOT EXISTS idx_comments_root   ON comments(root);
-- 索引：遍历所有视频时用
CREATE INDEX IF NOT EXISTS idx_crawl_logs_bvid ON crawl_logs(bvid);
`;

/**
 * 打开数据库并确保表结构存在。
 * @param file 数据库文件的绝对路径
 * @returns SQLite 数据库连接对象
 */
export function openDb(file: string): DatabaseSync {
  // SQLite 不会自动创建目录，所以先手动把父目录建出来（recursive 相当于 mkdir -p）
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // 建立连接（文件不存在会自动创建）
  const db = new DatabaseSync(file);

  // 开启 WAL 日志模式：读和写可以并发，避免写入时查询被阻塞（对我们这种「边抓边查」的场景很关键）
  db.exec('PRAGMA journal_mode = WAL;');
  // 开启外键约束（当前没用到外键，先养成好习惯）
  db.exec('PRAGMA foreign_keys = ON;');
  // 执行建表语句（幂等，重复跑不会丢数据）
  db.exec(SCHEMA_SQL);
  // 旧数据库需要补上后续版本新增的列。SQLite 没有 ADD COLUMN IF NOT EXISTS，
  // 因此先读表结构再迁移；默认 NULL 表示“历史数据完整性未知”，不会误标为完整。
  const commentColumns = db.prepare('PRAGMA table_info(comments)').all() as Array<{ name: string }>;
  const commentColumnNames = new Set(commentColumns.map((column) => column.name));
  if (!commentColumnNames.has('sub_fetched_count')) {
    db.exec('ALTER TABLE comments ADD COLUMN sub_fetched_count INTEGER;');
  }
  if (!commentColumnNames.has('sub_context_complete')) {
    db.exec('ALTER TABLE comments ADD COLUMN sub_context_complete INTEGER;');
  }

  return db;
}

/**
 * 写入/更新一条视频记录。
 * 用 ON CONFLICT ... DO UPDATE（UPSERT），这样重复抓同一个视频时是「更新统计数字」，
 * 而不是插入一条重复数据 —— 这就是「幂等」，任务可以随便重跑。
 * @param db 数据库连接
 * @param video 视频数据行
 */
export function upsertVideo(db: DatabaseSync, video: VideoRow): void {
  // 预编译 SQL（用 ? 占位符，参数单独传，避免 SQL 注入风险）
  const statement = db.prepare(`
    INSERT INTO videos (
      bvid, aid, title, up_name, up_mid, pubdate, duration,
      view_count, danmaku_cnt, reply_count, like_count, coin_count, fav_count,
      description, url, crawled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bvid) DO UPDATE SET
      aid         = excluded.aid,
      title       = excluded.title,
      up_name     = excluded.up_name,
      up_mid      = excluded.up_mid,
      pubdate     = excluded.pubdate,
      duration    = excluded.duration,
      view_count  = excluded.view_count,
      danmaku_cnt = excluded.danmaku_cnt,
      reply_count = excluded.reply_count,
      like_count  = excluded.like_count,
      coin_count  = excluded.coin_count,
      fav_count   = excluded.fav_count,
      description = excluded.description,
      url         = excluded.url,
      crawled_at  = excluded.crawled_at
  `);

  // 执行写入，参数顺序必须和上面的 ? 一一对应
  statement.run(
    video.bvid,
    video.aid,
    video.title,
    video.upName,
    video.upMid,
    video.pubdate,
    video.duration,
    video.view,
    video.danmaku,
    video.reply,
    video.like,
    video.coin,
    video.favorite,
    video.desc,
    video.url,
    Math.floor(Date.now() / 1000), // crawled_at：当前时间（秒）
  );
}

/**
 * 批量写入评论（一批放在一个事务里，速度比逐条提交快几十倍）。
 * 同样是 UPSERT：重复抓到同一条评论时，更新点赞数、正文和抓取时间，
 * 因为评论发布后点赞数会变、作者也可能修改内容。
 * @param db 数据库连接
 * @param rows 评论数据行数组
 * @returns 实际处理的条数
 */
export function insertComments(db: DatabaseSync, rows: CommentRow[]): number {
  // 空数组直接返回，省得开事务
  if (rows.length === 0) return 0;

  // 预编译插入语句
  const statement = db.prepare(`
    INSERT INTO comments (
      rpid, bvid, oid, parent, root, is_root, uname, content,
      like_count, ctime, location, sub_count, sub_fetched_count,
      sub_context_complete, raw, crawled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(rpid) DO UPDATE SET
      like_count = excluded.like_count,
      content    = excluded.content,
      sub_count  = excluded.sub_count,
      sub_fetched_count = COALESCE(excluded.sub_fetched_count, comments.sub_fetched_count),
      sub_context_complete = COALESCE(excluded.sub_context_complete, comments.sub_context_complete),
      location   = excluded.location,
      raw        = excluded.raw,
      crawled_at = excluded.crawled_at
  `);

  // 当前时间，整批共用一个值，省掉重复计算
  const now = Math.floor(Date.now() / 1000);

  // node:sqlite 没有内置事务辅助函数，所以手动 BEGIN / COMMIT / ROLLBACK
  db.exec('BEGIN');
  try {
    // 逐条执行写入
    for (const row of rows) {
      statement.run(
        row.rpid,
        row.bvid,
        row.oid,
        row.parent,
        row.root,
        row.isRoot ? 1 : 0, // 布尔值转成 SQLite 认识的 0/1
        row.uname,
        row.content,
        row.likeCount,
        row.ctime,
        row.location,
        row.subCount,
        row.subFetchedCount,
        row.subContextComplete === null ? null : row.subContextComplete ? 1 : 0,
        row.raw,
        now,
      );
    }
    // 全部成功才提交
    db.exec('COMMIT');
  } catch (error) {
    // 任意一条失败就整体回滚，避免留下写了一半的脏数据
    db.exec('ROLLBACK');
    throw error;
  }

  return rows.length;
}

/**
 * 开始一次抓取日志，返回日志 id，结束后用 finishCrawlLog 收尾。
 * 有了这张表，任何一次抓取的成败都能事后追溯。
 * @param db 数据库连接
 * @param bvid 本次抓取的视频
 * @returns crawl_logs 表的新行 id
 */
export function startCrawlLog(db: DatabaseSync, bvid: string): number {
  // 插入一条 status = 'running' 的记录
  const statement = db.prepare(
    `INSERT INTO crawl_logs (bvid, started_at, status) VALUES (?, ?, 'running')`,
  );
  // run() 的返回值里有 lastInsertRowid，就是我们需要的日志 id
  const result = statement.run(bvid, Math.floor(Date.now() / 1000));
  // lastInsertRowid 可能是 bigint（大整数），统一转成 number 返回
  return Number(result.lastInsertRowid);
}

/**
 * 结束一次抓取日志。
 * @param db 数据库连接
 * @param logId startCrawlLog 返回的 id
 * @param status success 或 failed
 * @param pages 抓取页数
 * @param saved 写入/更新的评论条数
 * @param error 失败时的错误信息（成功传空字符串即可）
 */
export function finishCrawlLog(
  db: DatabaseSync,
  logId: number,
  status: 'success' | 'failed',
  pages: number,
  saved: number,
  error = '',
): void {
  // 更新这条日志的结束时间、状态和统计数字
  const statement = db.prepare(`
    UPDATE crawl_logs
       SET finished_at = ?, status = ?, pages = ?, saved = ?, error = ?
     WHERE id = ?
  `);
  statement.run(Math.floor(Date.now() / 1000), status, pages, saved, error, logId);
}
