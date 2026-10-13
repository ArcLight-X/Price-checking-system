/**
 * check-auth.ts —— 诊断脚本：检查 .env 里的 BILI_SESSDATA 是否真的被 B站认可
 *
 * 【什么时候用】
 *   抓取时如果看到「只能抓到很少的评论」的警告，运行本脚本就能知道原因：
 *     · 提示未配置        → 去创建并填写 .env
 *     · 提示已配置但失效   → SESSDATA 过期了，重新登录 B站复制新的
 *
 * 【用法】
 *   npm run check:auth
 *   npm run check:auth -- BV1GJ411x7h7        （可选：指定用于测试的视频）
 *
 * 【安全说明】
 *   本脚本只输出「结构信息 + 结论」，不会打印 SESSDATA 明文。
 */

import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, loadConfig } from '../src/config.ts';
import { createBiliClient } from '../src/bilibili/client.ts';

// 默认拿这个视频做「能否正常翻页」的实测（B站官方 MV，评论量很大）
const DEFAULT_TEST_BVID = 'BV1GJ411x7h7';

/** 读取 .env 里 BILI_SESSDATA 那一行的原始文本（用于判断是否写了引号等格式问题） */
function readRawSessdataLine(): string {
  // 读取项目根目录的 .env；文件不存在就直接返回空串
  const envFile = path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(envFile)) return '';
  // 按行拆开，找到以 BILI_SESSDATA= 开头的那一行
  const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
  return lines.find((line) => line.trim().startsWith('BILI_SESSDATA=')) ?? '';
}

/** 主流程 */
async function main(): Promise<void> {
  // 命令行可选参数：指定测试用的视频
  const testBvid = process.argv[2] ?? DEFAULT_TEST_BVID;

  // 读配置（内部会自动加载 .env）
  const config = loadConfig();
  const sessdata = config.sessdata;

  console.log('='.repeat(70));
  console.log('B站登录态（SESSDATA）自检');
  console.log('='.repeat(70));

  // ——— 第 1 步：检查有没有配置 ———
  if (!sessdata) {
    console.log('\n❌ 未配置：.env 里的 BILI_SESSDATA 是空的。');
    console.log('   解决：复制 .env.example 为 .env，填入 SESSDATA 后重试。');
    process.exitCode = 1;
    return;
  }
  console.log(`\n✅ 已配置：长度 ${sessdata.length} 个字符`);

  // ——— 第 2 步：检查值的结构，排除「复制姿势不对」 ———
  const rawLine = readRawSessdataLine();
  const rawValue = rawLine.slice(rawLine.indexOf('=') + 1).trim();
  const issues: string[] = [];
  if (/^["']/.test(rawValue) || /["']$/.test(rawValue)) issues.push('值外面包了引号（请去掉引号）');
  if (sessdata.includes('SESSDATA=')) issues.push('值里重复带了 "SESSDATA=" 前缀（请只复制值）');
  if (sessdata !== sessdata.trim()) issues.push('值首尾有多余空白字符');
  if (/[^A-Za-z0-9%*_\-.]/.test(sessdata)) issues.push('值里出现了非常规字符（可能复制到了多余内容）');
  if ((sessdata.match(/%2C/gi) ?? []).length === 0) issues.push('值里没有 %2C（正常 SESSDATA 一定包含它，疑似复制不全）');
  // 常见事故：同一串值被粘贴了两遍（长度正好是两倍，前后半段完全相同）
  const halfLength = Math.floor(sessdata.length / 2);
  if (halfLength > 0 && sessdata.length % 2 === 0 && sessdata.slice(0, halfLength) === sessdata.slice(halfLength)) {
    issues.push(`值被粘贴了两遍（当前 ${sessdata.length} 字符，正确长度应为 ${halfLength} 字符，删掉重复的后半段即可）`);
  }

  if (issues.length > 0) {
    console.log('\n⚠️  值的格式看起来有问题：');
    for (const issue of issues) console.log(`    · ${issue}`);
  } else {
    console.log('✅ 值的格式正常（无引号、无多余空白、字符集符合 SESSDATA 特征）');
  }

  // ——— 第 3 步：拿这个登录态去问 B站「我登录了吗」 ———
  const navResponse = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: {
      'User-Agent': config.userAgent,
      Referer: 'https://www.bilibili.com/',
      Cookie: `SESSDATA=${sessdata}`,
    },
  });
  const nav = (await navResponse.json()) as {
    code: number;
    data?: { isLogin?: boolean; uname?: string };
  };

  console.log('\n向 B站接口 /x/web-interface/nav 验证登录态…');
  console.log(`    返回 code = ${nav.code}（0 = 成功，-101 = 未登录）`);
  console.log(`    isLogin   = ${String(nav.data?.isLogin)}`);
  console.log(`    昵称      = ${nav.data?.uname ?? '(未返回)'}`);

  const loggedIn = nav.code === 0 && nav.data?.isLogin === true;

  // ——— 第 4 步：实测评论接口能拿到多少条（端到端确认） ———
  console.log(`\n实测评论接口（视频 ${testBvid}）…`);
  // 用真实客户端请求（会自动带上 buvid3 等 Cookie，与抓取时的行为完全一致）
  const client = createBiliClient({
    sessdata,
    buvid3: config.buvid3,
    requestIntervalMs: config.requestIntervalMs,
    maxRetries: 1,
    userAgent: config.userAgent,
  });

  let repliesCount = -1;
  let totalCount = -1;
  try {
    const view = await client.request<{ aid: number }>(
      'https://api.bilibili.com/x/web-interface/view',
      { bvid: testBvid },
    );
    const page = await client.request<{
      replies: unknown[] | null;
      cursor: { is_end?: boolean; all_count?: number };
    }>(
      'https://api.bilibili.com/x/v2/reply/wbi/main',
      { oid: view.aid, type: 1, mode: 3, next: 0, ps: 20, plat: 1, web_location: 1315875 },
      { referer: `https://www.bilibili.com/video/${testBvid}` },
    );
    repliesCount = (page.replies ?? []).length;
    totalCount = page.cursor.all_count ?? -1;
  } catch (error) {
    console.log(`    请求失败：${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(`    该视频评论总数 = ${totalCount}`);
  console.log(`    本次返回条数   = ${repliesCount}（< 20 说明没拿到完整分页）`);

  // ——— 第 5 步：给出结论 ———
  console.log(`\n${'='.repeat(70)}`);
  if (loggedIn && repliesCount >= 20) {
    console.log('🎉 结论：登录态有效，可以正常翻页抓取。');
  } else if (loggedIn) {
    console.log('⚠️  结论：登录态有效，但评论条数依然很少。');
    console.log('    可能原因：该视频评论被 UP主/平台限制，或触发了风控。换个视频再试试。');
  } else {
    console.log('❌ 结论：B站没有认可这个 SESSDATA（返回 -101 未登录）。');
    console.log('    最常见的两个原因：');
    console.log('      1) 会话已过期（长时间未登录、在其他设备退出过登录、改过密码）');
    console.log('      2) 复制时值不完整（只复制了一部分），或复制的是旧值');
    console.log('    解决办法：重新登录 B站 → F12 → Application → Cookies → 复制全新的 SESSDATA');
    console.log('              粘贴到 .env 的 BILI_SESSDATA=（不要加引号、不要带 SESSDATA= 前缀）');
    process.exitCode = 1;
  }
  console.log('='.repeat(70));
}

// 顶层 await 执行主流程
try {
  await main();
} catch (error) {
  console.error('自检脚本异常：', error);
  process.exitCode = 1;
}
