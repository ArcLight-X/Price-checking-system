/**
 * inspect-db.mjs —— 临时只读脚本：查看 SQLite 数据库文件里到底存了什么
 * 用法：node scripts/inspect-db.mjs [数据库路径]
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const dbFile = process.argv[2] ?? 'data/bilibili.db';

// 1) 文件层面的信息：大小 + 文件头魔数
const sizeBytes = fs.statSync(dbFile).size;
// SQLite 每个文件的前 16 字节固定是 "SQLite format 3\0"，这是它作为二进制格式的身份标识
const magicHeader = fs.readFileSync(dbFile).subarray(0, 16).toString('latin1');

console.log('=========== 文件信息 ===========');
console.log(`路径      ：${dbFile}`);
console.log(`大小      ：${(sizeBytes / 1024).toFixed(1)} KB (${sizeBytes} 字节)`);
console.log(`文件头    ：${JSON.stringify(magicHeader)}  <- SQLite 的固定标识`);
console.log(`页大小    ：${fs.readFileSync(dbFile).readUInt16BE(16)} 字节（SQLite 按页存储数据）`);

const db = new DatabaseSync(dbFile);

// 2) 表结构
console.log('\n=========== 所有表与索引 ===========');
console.table(
  db
    .prepare("SELECT type AS 类型, name AS 名称 FROM sqlite_master WHERE type IN ('table','index') ORDER BY type DESC, name")
    .all(),
);

// 3) 各表行数
console.log('\n=========== 各表行数 ===========');
for (const table of ['videos', 'comments', 'crawl_logs']) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  console.log(`  ${table.padEnd(12)} ${row.n} 行`);
}

// 4) videos 表实际内容
console.log('\n=========== videos 表（视频元信息）===========');
console.table(
  db.prepare('SELECT bvid, aid, title, up_name, reply_count AS 站方评论数, view_count AS 播放量 FROM videos').all(),
);

// 5) comments 表的列定义
console.log('\n=========== comments 表的列 ===========');
console.table(
  db
    .prepare('PRAGMA table_info(comments)')
    .all()
    .map((c) => ({ 列名: c.name, 类型: c.type, 非空: c.notnull, 主键: c.pk })),
);

// 6) comments 表实际数据（截断 content，避免刷屏）
console.log('\n=========== comments 表：点赞最高的 5 条 ===========');
console.table(
  db
    .prepare(
      `SELECT rpid, uname, is_root AS 一级, like_count AS 点赞, substr(content, 1, 28) AS 内容
         FROM comments ORDER BY like_count DESC LIMIT 5`,
    )
    .all(),
);

// 7) 抓取日志
console.log('\n=========== crawl_logs 表（抓取流水）===========');
console.table(db.prepare('SELECT * FROM crawl_logs').all());

db.close();
