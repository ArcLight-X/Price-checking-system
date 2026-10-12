/**
 * conversation.ts —— 把 comments 表中的扁平记录组装成可审计的评论对话。
 *
 * 这里不做价格抽取，只负责给每条证据稳定编号、恢复回复关系，并暴露上下文完整性。
 */

export interface ConversationSourceRow {
  rpid: string;
  parent: string;
  root: string;
  is_root: number;
  uname: string;
  content: string;
  ctime: number;
  like_count: number;
  sub_count: number;
  sub_fetched_count: number | null;
  sub_context_complete: number | null;
}

export type ConversationContextStatus = 'complete' | 'truncated' | 'unknown' | 'inconsistent';

export interface ConversationMessage {
  label: string;
  rpid: string;
  parentRpid: string | null;
  parentLabel: string | null;
  relation: 'root' | 'reply_to_root' | 'reply_to_reply' | 'missing_parent';
  uname: string;
  content: string;
  ctime: number;
  timeIso: string;
  likeCount: number;
}

export interface CommentConversation {
  conversationLabel: string;
  rootRpid: string;
  expectedReplyCount: number;
  storedReplyCount: number;
  contextStatus: ConversationContextStatus;
  messages: ConversationMessage[];
  text: string;
}

function compareRows(left: ConversationSourceRow, right: ConversationSourceRow): number {
  return left.ctime - right.ctime || left.rpid.localeCompare(right.rpid);
}

function toIsoTime(seconds: number): string {
  return seconds > 0 ? new Date(seconds * 1000).toISOString() : 'unknown';
}

function getContextStatus(root: ConversationSourceRow, storedReplyCount: number): ConversationContextStatus {
  if (root.sub_context_complete === 0) return 'truncated';
  if (root.sub_context_complete === 1) {
    return storedReplyCount >= root.sub_count ? 'complete' : 'inconsistent';
  }
  if (root.sub_count === 0 && storedReplyCount === 0) return 'complete';
  return 'unknown';
}

/** 组装对话。没有对应一级评论的孤立回复不会被静默丢弃，而会形成 unknown 对话。 */
export function assembleConversations(rows: ConversationSourceRow[]): CommentConversation[] {
  const roots = rows.filter((row) => row.is_root === 1).sort(compareRows);
  const repliesByRoot = new Map<string, ConversationSourceRow[]>();

  for (const row of rows) {
    if (row.is_root === 1) continue;
    const rootRpid = row.root !== '0' ? row.root : row.parent;
    const group = repliesByRoot.get(rootRpid) ?? [];
    group.push(row);
    repliesByRoot.set(rootRpid, group);
  }

  const rootIds = new Set(roots.map((root) => root.rpid));
  const orphanRootIds = [...repliesByRoot.keys()].filter((rootId) => !rootIds.has(rootId)).sort();
  const conversations: CommentConversation[] = [];

  function build(root: ConversationSourceRow | null, rootRpid: string, index: number): CommentConversation {
    const conversationLabel = `C${String(index + 1).padStart(3, '0')}`;
    const replies = (repliesByRoot.get(rootRpid) ?? []).sort(compareRows);
    const labels = new Map<string, string>();
    if (root) labels.set(root.rpid, conversationLabel);
    replies.forEach((reply, replyIndex) => {
      labels.set(reply.rpid, `${conversationLabel}-R${String(replyIndex + 1).padStart(3, '0')}`);
    });

    const messages: ConversationMessage[] = [];
    if (root) {
      messages.push({
        label: conversationLabel,
        rpid: root.rpid,
        parentRpid: null,
        parentLabel: null,
        relation: 'root',
        uname: root.uname,
        content: root.content,
        ctime: root.ctime,
        timeIso: toIsoTime(root.ctime),
        likeCount: root.like_count,
      });
    }

    for (const reply of replies) {
      const parentRpid = reply.parent === '0' ? rootRpid : reply.parent;
      const parentLabel = labels.get(parentRpid) ?? null;
      messages.push({
        label: labels.get(reply.rpid)!,
        rpid: reply.rpid,
        parentRpid,
        parentLabel,
        relation: parentLabel === null
          ? 'missing_parent'
          : parentRpid === rootRpid
            ? 'reply_to_root'
            : 'reply_to_reply',
        uname: reply.uname,
        content: reply.content,
        ctime: reply.ctime,
        timeIso: toIsoTime(reply.ctime),
        likeCount: reply.like_count,
      });
    }

    const contextStatus = root ? getContextStatus(root, replies.length) : 'unknown';
    const text = messages.map((message) => {
      const target = message.parentLabel ? ` -> ${message.parentLabel}` : message.relation === 'missing_parent' ? ' -> [缺失父评论]' : '';
      return `[${message.label}] ${message.timeIso} ${message.uname} (${message.relation}${target}, rpid=${message.rpid}): ${message.content}`;
    }).join('\n');

    return {
      conversationLabel,
      rootRpid,
      expectedReplyCount: root?.sub_count ?? replies.length,
      storedReplyCount: replies.length,
      contextStatus,
      messages,
      text,
    };
  }

  roots.forEach((root, index) => conversations.push(build(root, root.rpid, index)));
  orphanRootIds.forEach((rootId, orphanIndex) => {
    conversations.push(build(null, rootId, roots.length + orphanIndex));
  });
  return conversations;
}