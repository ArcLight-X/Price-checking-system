import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommentConversation } from '../src/conversation.ts';
import { selectResearchConversations } from '../src/research-selection.ts';

function conversation(label: string, content: string, likeCount = 0): CommentConversation {
  return {
    conversationLabel: label,
    rootRpid: label,
    expectedReplyCount: 0,
    storedReplyCount: 0,
    contextStatus: 'complete',
    messages: [{
      label,
      rpid: label,
      parentRpid: null,
      parentLabel: null,
      relation: 'root',
      uname: '用户',
      content,
      ctime: 1,
      timeIso: '1970-01-01T00:00:01.000Z',
      likeCount,
    }],
    text: content,
  };
}

test('商品研究只保留价格候选并优先完整命中目标型号', () => {
  const selected = selectResearchConversations([
    conversation('C001', '这个视频讲得很好', 1000),
    conversation('C002', 'RTX 5070 Ti 京东券后 4999 元入手', 2),
    conversation('C003', '显卡价格大概 5999 元', 100),
  ], 'RTX 5070 Ti', 2);

  assert.deepEqual(selected.map((item) => item.conversationLabel), ['C002', 'C003']);
});