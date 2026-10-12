/**
 * types.ts —— 所有类型定义的集中营
 *
 * 说明：本文件几乎全部是 interface / type，运行时会被 Node 的「类型擦除」删掉，
 *       只服务于编辑器的智能提示和 tsc 类型检查，不产生任何实际代码。
 */

/* ============================== 一、数据库行结构 ============================== */

/** videos 表的一行：一个 B站视频的元信息 */
export interface VideoRow {
  /** BV 号，主键，例如 BV1GJ411x7h7 */
  bvid: string;
  /** av 号（数字型视频 id），评论接口需要用它当 oid 参数 */
  aid: number;
  /** 视频标题 */
  title: string;
  /** UP主昵称 */
  upName: string;
  /** UP主的 uid，用字符串存避免超出 JS 安全整数范围 */
  upMid: string;
  /** 发布时间（秒级时间戳） */
  pubdate: number;
  /** 视频时长（秒） */
  duration: number;
  /** 播放量 */
  view: number;
  /** 弹幕数 */
  danmaku: number;
  /** 评论总数（B站统计值，不等于我们能抓到的数量） */
  reply: number;
  /** 点赞数 */
  like: number;
  /** 投币数 */
  coin: number;
  /** 收藏数 */
  favorite: number;
  /** 视频简介 */
  desc: string;
  /** 视频页面地址 */
  url: string;
}

/** comments 表的一行：一条评论（一级评论和楼中楼共用这张表，用 isRoot 区分） */
export interface CommentRow {
  /** 评论 id，字符串存储（B站 rpid 可能超过 JS 安全整数范围） */
  rpid: string;
  /** 所属视频 BV 号 */
  bvid: string;
  /** 评论区归属的 oid（这里就等于 aid） */
  oid: string;
  /** 父评论 id；一级评论固定为 "0" */
  parent: string;
  /** 根评论 id；一级评论固定为 "0"，楼中楼指向它所属的一级评论 */
  root: string;
  /** true = 一级评论，false = 楼中楼回复 */
  isRoot: boolean;
  /** 评论者昵称（只存公开昵称，不存 uid，降低合规风险） */
  uname: string;
  /** 评论正文 */
  content: string;
  /** 点赞数 */
  likeCount: number;
  /** 评论发布时间（秒级时间戳） */
  ctime: number;
  /** IP 归属地，例如 "广东" */
  location: string;
  /** 该评论下有多少条楼中楼回复 */
  subCount: number;
  /** 本次已抓到多少条楼中楼；null 表示本次没有展开，不能据此判断完整性 */
  subFetchedCount: number | null;
  /** 楼中楼上下文是否完整；null = 未核实，false = 明确截断，true = 已抓完 */
  subContextComplete: boolean | null;
  /** 原始 JSON 文本，保留下来便于以后重新解析，不用重新抓 */
  raw: string;
}

/* ==================== 二、B站接口返回结构（只声明用得到的字段） ==================== */

/** 所有 B站接口统一的响应信封格式 */
export interface BiliEnvelope<T> {
  /** 业务状态码，0 表示成功 */
  code: number;
  /** 提示信息 */
  message: string;
  /** 真正的数据 */
  data: T;
}

/** /x/web-interface/view 接口返回的视频信息（只挑我们要用的字段） */
export interface BiliVideoInfo {
  bvid: string;
  aid: number;
  title: string;
  desc: string;
  pubdate: number;
  duration: number;
  /** UP主信息 */
  owner: { mid: number; name: string };
  /** 统计数据 */
  stat: {
    view: number;
    danmaku: number;
    reply: number;
    like: number;
    coin: number;
    favorite: number;
  };
}

/** 评论对象。一级评论和楼中楼回复用的是同一种结构 */
export interface BiliReply {
  /** 评论 id。可能是数字（原始 JSON 里的大整数会被我们转成字符串） */
  rpid: number | string;
  /** 数字版本的评论 id（B站部分接口会额外给这个字段） */
  rpid_str?: string;
  /** 评论区归属 id，等于 aid */
  oid: number | string;
  /** 父评论 id（楼中楼才有意义） */
  root?: number | string;
  parent?: number | string;
  /** 评论发布时间（秒级时间戳） */
  ctime: number;
  /** 点赞数 */
  like: number;
  /** 评论正文 */
  content: { message: string };
  /** 评论者信息 */
  member: { uname: string; mid: string | number };
  /** 评论控制信息，里面带 IP 归属地 */
  reply_control?: { location?: string };
  /** 楼中楼回复数量（一级评论才有） */
  rcount?: number;
  /** 楼中楼回复数量（另一个字段名，部分场景才返回） */
  count?: number;
}

/** 评论接口的翻页游标 */
export interface BiliCommentCursor {
  /** 是否已经到底了 */
  is_end: boolean;
  /** 下一页游标的数字值，直接作为下一次请求的 next 参数 */
  next: number;
  /** 排序模式（2 = 时间排序，3 = 热度排序） */
  mode?: number;
  /** 评论区总条数 */
  all_count?: number;
  /**
   * B站返回的另一种分页游标（形如 { next_offset: "CAEiAggC" }）。
   *
   * ⚠️ 实测结论：它**不能**拿来当请求参数用 —— 一旦把 next_offset 作为
   * pagination_str 传回去，接口会返回 -400 请求错误。翻页请只用上面的 next 字段。
   * 这里保留字段只是为了如实描述接口的返回结构。
   */
  pagination_reply?: { next_offset?: string };
}

/** /x/v2/reply/wbi/main 接口返回的一页评论数据 */
export interface BiliCommentPage {
  cursor: BiliCommentCursor;
  /** 评论列表。到底时可能是 null */
  replies: BiliReply[] | null;
}

/** /x/v2/reply/reply（楼中楼）接口返回的数据 */
export interface BiliSubCommentData {
  /** 楼中楼列表 */
  replies: BiliReply[] | null;
  /** 分页信息，page.count 是总页数，page.size 是每页条数 */
  page?: { count: number; num: number; size: number };
}
