import type { CommentRow } from './types.ts';

export interface RootCommentSelection {
  /** 最终去重后的一级评论：热门组在前，随后追加未重复的最新组。 */
  rows: CommentRow[];
  hotRows: CommentRow[];
  recentRows: CommentRow[];
  overlapCount: number;
}

function uniqueByRpid(rows: CommentRow[]): CommentRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.rpid)) return false;
    seen.add(row.rpid);
    return true;
  });
}

/**
 * 从两条候选流中选择“高价值 + 有时效”的一级评论。
 * 热门组按点赞降序，最新组按时间降序；两组重叠时只保留一次。
 */
export function selectRootComments(
  hotCandidates: CommentRow[],
  recentCandidates: CommentRow[],
  hotLimit = 50,
  recentLimit = 30,
): RootCommentSelection {
  const safeHotLimit = Math.max(0, hotLimit);
  const safeRecentLimit = Math.max(0, recentLimit);

  const hotRows = uniqueByRpid([...hotCandidates]
    .sort((left, right) => right.likeCount - left.likeCount || right.ctime - left.ctime))
    .slice(0, safeHotLimit);
  const recentRows = uniqueByRpid([...recentCandidates]
    .sort((left, right) => right.ctime - left.ctime || right.likeCount - left.likeCount))
    .slice(0, safeRecentLimit);

  // 同一评论可能在两个接口结果中都出现。recentRows 是后抓取的数据，字段通常更新，优先使用它。
  const latestByRpid = new Map<string, CommentRow>();
  hotRows.forEach((row) => latestByRpid.set(row.rpid, row));
  recentRows.forEach((row) => latestByRpid.set(row.rpid, row));

  const hotIds = hotRows.map((row) => row.rpid);
  const hotIdSet = new Set(hotIds);
  const recentOnlyIds = recentRows.map((row) => row.rpid).filter((rpid) => !hotIdSet.has(rpid));
  const rows = [...hotIds, ...recentOnlyIds].map((rpid) => latestByRpid.get(rpid)!);

  return {
    rows,
    hotRows,
    recentRows,
    overlapCount: recentRows.length - recentOnlyIds.length,
  };
}