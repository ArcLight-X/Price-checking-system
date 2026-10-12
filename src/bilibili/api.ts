/**
 * api.ts —— B站业务接口封装
 *
 * 【职责】只做两件事：
 *   1. 拼装正确的参数去调用 client（签名、限速、重试都由 client 负责）
 *   2. 把 B站返回的原始结构，转换成我们自己的数据结构（也就是要写进数据库的行）
 * 这样上层 crawl.ts 就完全不用关心 B站接口长什么样，将来接口变了也只改这里。
 */

// 只做类型引用（运行时会被擦除）
import type { BiliClient } from './client.ts';
import type {
  BiliCommentPage,
  BiliReply,
  BiliSubCommentData,
  BiliVideoInfo,
  CommentRow,
  VideoRow,
} from '../types.ts';

/** 视频信息接口：用 BV 号换标题、UP主、评论总数等 */
const VIDEO_INFO_API = 'https://api.bilibili.com/x/web-interface/view';
/** 主评论接口（新版，必须 WBI 签名） */
const COMMENT_MAIN_API = 'https://api.bilibili.com/x/v2/reply/wbi/main';
/** 楼中楼接口：取某条一级评论下面的所有回复 */
const COMMENT_SUB_API = 'https://api.bilibili.com/x/v2/reply/reply';

/** BV 号的格式：BV + 10 位大小写字母数字 */
const BV_PATTERN = /BV[0-9A-Za-z]{10}/;

/** 排序模式常量：避免代码里出现看不懂的魔法数字 */
export const COMMENT_MODE = {
  /** 按时间排序（2） */
  time: 2,
  /** 按热度排序（3），默认用这个，因为高赞评论里更可能藏有效信息 */
  hot: 3,
} as const;

/**
 * 从用户输入里解析出 BV 号。
 * 支持三种输入：纯 BV 号、完整视频链接、b23.tv 短链。
 * @param input 命令行传入的 --video 参数
 */
export async function parseBvid(input: string): Promise<string> {
  // 去掉首尾空白，避免复制粘贴时带上空格
  const trimmed = input.trim();

  // 情况一：输入里直接包含 BV 号（纯 BV 号或完整链接都能命中）
  const matched = BV_PATTERN.exec(trimmed);
  // 用 ?. 和 ?? 处理「匹配失败」的情况，满足严格模式的类型要求
  if (matched?.[0]) return matched[0];

  // 情况二：b23.tv 短链，先跟随跳转拿到最终地址，再从地址里抠 BV 号
  if (trimmed.includes('b23.tv')) {
    const response = await fetch(trimmed, { redirect: 'follow' });
    const fromFinalUrl = BV_PATTERN.exec(response.url);
    if (fromFinalUrl?.[0]) return fromFinalUrl[0];
  }

  // 都没解析出来就报错，并提示用户正确用法
  throw new Error(
    `无法从输入中解析出 BV 号：${input}（示例：BV1GJ411x7h7 或 https://www.bilibili.com/video/BV1GJ411x7h7）`,
  );
}

/**
 * 获取视频基本信息。
 * @param client 已创建的 B站客户端
 * @param bvid BV 号
 * @returns 可以直接写进 videos 表的数据行
 */
export async function fetchVideoInfo(client: BiliClient, bvid: string): Promise<VideoRow> {
  // 调接口拿原始数据（这个接口其实不需要签名，但统一走签名流程更省心）
  const data = await client.request<BiliVideoInfo>(VIDEO_INFO_API, { bvid });

  // 逐字段做兜底：接口字段可能缺失，用 ?? 给默认值，避免写入 null 导致后续查询报错
  return {
    bvid: data.bvid, // 接口回传的 BV 号
    aid: data.aid ?? 0, // av 号，评论接口要拿它当 oid
    title: data.title ?? '', // 标题
    upName: data.owner?.name ?? '', // UP主昵称
    upMid: String(data.owner?.mid ?? ''), // UP主 uid 转字符串存
    pubdate: data.pubdate ?? 0, // 发布时间
    duration: data.duration ?? 0, // 时长（秒）
    view: data.stat?.view ?? 0, // 播放量
    danmaku: data.stat?.danmaku ?? 0, // 弹幕数
    reply: data.stat?.reply ?? 0, // 评论总数（B站统计值）
    like: data.stat?.like ?? 0, // 点赞数
    coin: data.stat?.coin ?? 0, // 投币数
    favorite: data.stat?.favorite ?? 0, // 收藏数
    desc: data.desc ?? '', // 简介
    url: `https://www.bilibili.com/video/${data.bvid}`, // 拼一个可点击的视频地址
  };
}

/** fetchCommentPage 的参数 */
export interface FetchCommentPageArgs {
  /** 视频 BV 号（用于拼 Referer 和写库） */
  bvid: string;
  /** 评论区归属 id，等于视频的 aid */
  oid: string;
  /** 排序模式：2 时间 / 3 热度 */
  mode: number;
  /**
   * 翻页游标：第一页传 0，之后传上一页返回的 cursor.next。
   * 【实测结论】本接口翻页只认这一个参数；B站另外返回的
   * cursor.pagination_reply.next_offset 一旦作为 pagination_str 回传就会返回 -400，
   * 所以这里刻意不提供那个参数。
   */
  next: number;
  /** 每页条数 */
  ps: number;
}

/** fetchCommentPage 的返回值：游标 + 转换好的数据行 */
export interface FetchCommentPageResult {
  /** 游标，含是否到底（is_end）和下一页位置 */
  cursor: BiliCommentPage['cursor'];
  /** 这一页的评论（已转换成本项目的数据结构） */
  rows: CommentRow[];
}

/**
 * 拉取一页主评论。
 * @param client B站客户端
 * @param args 分页参数
 */
export async function fetchCommentPage(
  client: BiliClient,
  args: FetchCommentPageArgs,
): Promise<FetchCommentPageResult> {
  // 组装主评论接口需要的参数。这几个参数一个都不能少，否则会返回 -400 或 -403
  const params: Record<string, string | number> = {
    oid: args.oid, // 评论区归属（视频就是 aid）
    type: 1, // 评论区类型：1 = 视频，12 = 专栏，17 = 动态
    mode: args.mode, // 排序方式：2 时间 / 3 热度
    next: args.next, // 翻页游标
    ps: args.ps, // 每页条数
    plat: 1, // 平台标识：1 = web
    web_location: 1315875, // 前端埋点参数，B站会校验，必须带上
  };
  // 注意：这里不要额外传 pagination_str（用 cursor.pagination_reply.next_offset），
  // 实测传了会返回 -400，翻页只靠 next 这一个参数就够了。

  // 发起请求，Referer 用视频页地址，行为最接近真实浏览器
  const data = await client.request<BiliCommentPage>(COMMENT_MAIN_API, params, {
    referer: `https://www.bilibili.com/video/${args.bvid}`,
  });

  // 到底时 replies 可能是 null，统一转成空数组，让上层不用做空值判断
  const replies = data.replies ?? [];

  // 把每条原始回复转换成本项目的数据结构
  return {
    cursor: data.cursor,
    rows: replies.map((reply) => toCommentRow(reply, args.bvid, args.oid, true)),
  };
}

/** fetchSubComments 的参数 */
export interface FetchSubCommentsArgs {
  /** 视频 BV 号 */
  bvid: string;
  /** 评论区归属 id（aid） */
  oid: string;
  /** 要展开的一级评论 id */
  root: string;
  /** 每页条数 */
  ps: number;
  /** 最多保留多少条楼中楼；默认 20，超过后直接截断 */
  maxReplies?: number;
}

/** 楼中楼抓取结果。调用方必须保留完整性信息，不能把截断上下文当成完整对话。 */
export interface FetchSubCommentsResult {
  rows: CommentRow[];
  pagesFetched: number;
  totalCount: number | null;
  totalPages: number | null;
  isComplete: boolean;
  truncatedByLimit: boolean;
}

/**
 * 拉取某条一级评论下的全部楼中楼回复。
 * 【为什么需要】价格信息经常出现在「问：怎么买的？答：xxx」这种对话里，值得单独抓。
 */
export async function fetchSubComments(
  client: BiliClient,
  args: FetchSubCommentsArgs,
): Promise<FetchSubCommentsResult> {
  // 收集结果的数组
  const rows: CommentRow[] = [];
  // 接口数据变化时相邻分页可能出现重复 rpid；在 API 层去重，避免完整性计数虚高。
  const seenRpids = new Set<string>();
  // 楼中楼也分页，从第 1 页开始
  let pageNumber = 1;
  // 默认只保留前 20 条：通常高价值追问集中在前排，同时控制 LLM 上下文长度。
  const maxReplies = Math.max(1, args.maxReplies ?? 20);
  let pagesFetched = 0;
  let totalCount: number | null = null;
  let totalPages: number | null = null;
  let reachedEnd = false;

  // 一直取到最后一页，或达到回复条数上限。
  while (rows.length < maxReplies) {
    const remaining = maxReplies - rows.length;
    // 请求楼中楼接口
    const data = await client.request<BiliSubCommentData>(
      COMMENT_SUB_API,
      { oid: args.oid, type: 1, root: args.root, ps: args.ps, pn: pageNumber },
      { referer: `https://www.bilibili.com/video/${args.bvid}` },
    );

    // 取出这一页的回复列表
    const replies = data.replies ?? [];
    pagesFetched += 1;
    // 转换后收集起来（isRoot 传 false，表示这是楼中楼）。达到条数上限立即停止。
    for (const reply of replies) {
      const row = toCommentRow(reply, args.bvid, args.oid, false);
      if (seenRpids.has(row.rpid)) continue;
      seenRpids.add(row.rpid);
      rows.push(row);
      if (rows.length >= maxReplies) break;
    }

    // 该接口的 page.count 是回复总条数，不是总页数；总页数要除以 page.size 向上取整。
    if (data.page) {
      totalCount = data.page.count;
      const pageSize = data.page.size > 0 ? data.page.size : args.ps;
      totalPages = Math.max(1, Math.ceil(data.page.count / pageSize));
    }
    // 已经到最后一页，或者这一页没数据，就结束循环
    if ((totalPages !== null && pageNumber >= totalPages) || replies.length === 0) {
      reachedEnd = true;
      break;
    }
    // 否则翻到下一页继续
    pageNumber += 1;
  }

  // 接口没返回分页信息时，只能通过空页或不足一页判断到底；
  // 不能因为“正好抓到 20 条”就猜完整。
  const isComplete = reachedEnd || (totalCount !== null && rows.length >= totalCount);
  return {
    rows,
    pagesFetched,
    totalCount,
    totalPages,
    isComplete,
    truncatedByLimit: !isComplete && rows.length >= maxReplies,
  };
}

/**
 * 把 B站返回的一条 reply 转换成本项目 comments 表的一行。
 * @param reply B站原始评论对象
 * @param bvid 所属视频 BV 号
 * @param oid 评论区归属 id
 * @param isRoot 是否为一级评论
 */
function toCommentRow(
  reply: BiliReply,
  bvid: string,
  oid: string,
  isRoot: boolean,
): CommentRow {
  return {
    // 优先用 rpid_str（字符串版本），没有就强行把 rpid 转成字符串，避免大整数精度丢失
    rpid: String(reply.rpid_str ?? reply.rpid),
    bvid, // 所属视频
    // 接口回传的 oid 优先，没有就用外部传入的
    oid: String(reply.oid ?? oid),
    // 父评论 id，一级评论固定为 "0"
    parent: String(reply.parent ?? '0'),
    // 根评论 id，一级评论固定为 "0"
    root: String(reply.root ?? '0'),
    isRoot, // 是否一级评论
    uname: reply.member?.uname ?? '', // 评论者昵称（只存公开昵称，不存 uid）
    content: reply.content?.message ?? '', // 评论正文
    likeCount: reply.like ?? 0, // 点赞数
    ctime: reply.ctime ?? 0, // 评论时间（秒级时间戳）
    location: reply.reply_control?.location ?? '', // IP 归属地
    // 楼中楼数量：不同场景字段名不同，依次兜底
    subCount: reply.rcount ?? reply.count ?? 0,
    // 一级评论没有回复时天然完整；有回复但尚未展开时必须保持“未知”。
    subFetchedCount: isRoot && (reply.rcount ?? reply.count ?? 0) === 0 ? 0 : null,
    subContextComplete: isRoot && (reply.rcount ?? reply.count ?? 0) === 0 ? true : null,
    // 原始 JSON 完整保留，方便以后重新解析（比如做价格抽取时发现漏了字段）
    raw: JSON.stringify(reply),
  };
}
