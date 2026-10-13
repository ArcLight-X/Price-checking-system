import type { BiliClient } from './bilibili/client.ts';
import {
  COMMENT_MODE,
  fetchCommentPage,
  fetchSubComments,
  fetchVideoInfo,
} from './bilibili/api.ts';
import { selectRootComments, type RootCommentSelection } from './comment-selection.ts';
import type { CommentRow, VideoRow } from './types.ts';

interface RootStreamResult {
  rows: CommentRow[];
  pagesFetched: number;
  endedEarly: boolean;
  totalCount: number;
}

export interface CrawlVideoCommentsOptions {
  hotLimit?: number;
  recentLimit?: number;
  subLimit?: number;
  pageSize?: number;
  withReplies?: boolean;
}

export interface CrawlVideoCommentsResult {
  video: VideoRow;
  selection: RootCommentSelection;
  rows: CommentRow[];
  pagesFetched: number;
  hotEndedEarly: boolean;
  recentEndedEarly: boolean;
}

async function fetchRootStream(
  client: BiliClient,
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

/** 抓取一个视频的热门/最新评论和楼中楼，但不负责写数据库。 */
export async function crawlVideoComments(
  client: BiliClient,
  bvid: string,
  options: CrawlVideoCommentsOptions = {},
): Promise<CrawlVideoCommentsResult> {
  const hotLimit = Math.max(0, options.hotLimit ?? 20);
  const recentLimit = Math.max(0, options.recentLimit ?? 10);
  const subLimit = Math.max(1, options.subLimit ?? 10);
  const pageSize = Math.max(1, options.pageSize ?? 20);
  const withReplies = options.withReplies ?? true;
  const video = await fetchVideoInfo(client, bvid);
  const oid = String(video.aid);

  const hot = await fetchRootStream(client, {
    bvid, oid, mode: COMMENT_MODE.hot, limit: hotLimit, pageSize,
  });
  const recent = await fetchRootStream(client, {
    bvid, oid, mode: COMMENT_MODE.time, limit: recentLimit, pageSize,
  });
  const selection = selectRootComments(hot.rows, recent.rows, hotLimit, recentLimit);
  const rows = [...selection.rows];

  if (withReplies) {
    for (const root of selection.rows) {
      if (root.subCount <= 0) continue;
      const replies = await fetchSubComments(client, {
        bvid,
        oid,
        root: root.rpid,
        ps: pageSize,
        maxReplies: subLimit,
      });
      root.subFetchedCount = replies.rows.length;
      root.subContextComplete = replies.isComplete;
      rows.push(...replies.rows);
    }
  }

  return {
    video,
    selection,
    rows,
    pagesFetched: hot.pagesFetched + recent.pagesFetched,
    hotEndedEarly: hot.endedEarly,
    recentEndedEarly: recent.endedEarly,
  };
}