import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleConversations, type ConversationSourceRow } from '../src/conversation.ts';
import { fetchSubComments } from '../src/bilibili/api.ts';
import type { BiliClient } from '../src/bilibili/client.ts';
import type { BiliSubCommentData } from '../src/types.ts';

function row(overrides: Partial<ConversationSourceRow>): ConversationSourceRow {
  return {
    rpid: 'root-1', parent: '0', root: '0', is_root: 1, uname: '甲', content: '页面价 1999',
    ctime: 100, like_count: 1, sub_count: 2, sub_fetched_count: 2, sub_context_complete: 1,
    ...overrides,
  };
}

test('组装稳定编号、时间和回复关系', () => {
  const conversations = assembleConversations([
    row({}),
    row({ rpid: 'reply-2', parent: 'reply-1', root: 'root-1', is_root: 0, uname: '丙', content: '还要 10 元运费', ctime: 120, sub_count: 0 }),
    row({ rpid: 'reply-1', parent: 'root-1', root: 'root-1', is_root: 0, uname: '乙', content: '会员券后 1799', ctime: 110, sub_count: 0 }),
  ]);

  assert.equal(conversations.length, 1);
  assert.equal(conversations[0]?.contextStatus, 'complete');
  assert.deepEqual(conversations[0]?.messages.map((message) => message.label), ['C001', 'C001-R001', 'C001-R002']);
  assert.equal(conversations[0]?.messages[2]?.parentLabel, 'C001-R001');
  assert.match(conversations[0]?.text ?? '', /会员券后 1799/);
});

test('明确标记达到采集上限的截断上下文', () => {
  const conversations = assembleConversations([
    row({ sub_count: 20, sub_fetched_count: 5, sub_context_complete: 0 }),
  ]);
  assert.equal(conversations[0]?.contextStatus, 'truncated');
});

test('缺失父评论不会被静默串到根评论', () => {
  const conversations = assembleConversations([
    row({ sub_count: 1, sub_fetched_count: 1, sub_context_complete: 1 }),
    row({ rpid: 'reply-1', parent: 'missing', root: 'root-1', is_root: 0, content: '1799', ctime: 110, sub_count: 0 }),
  ]);
  assert.equal(conversations[0]?.messages[1]?.relation, 'missing_parent');
  assert.equal(conversations[0]?.messages[1]?.parentLabel, null);
});

test('历史数据未核实完整性时保持 unknown', () => {
  const conversations = assembleConversations([
    row({ sub_count: 2, sub_fetched_count: null, sub_context_complete: null }),
  ]);
  assert.equal(conversations[0]?.contextStatus, 'unknown');
});

function subReply(rpid: string) {
  return {
    rpid,
    oid: 1,
    root: 'root-1',
    parent: 'root-1',
    ctime: 100,
    like: 0,
    content: { message: rpid },
    member: { uname: '用户', mid: '1' },
  };
}

function mockClient(pages: BiliSubCommentData[]): BiliClient {
  let index = 0;
  return {
    async request<T>(): Promise<T> {
      const page = pages[index];
      index += 1;
      if (!page) throw new Error('测试请求超过预设页数');
      return page as T;
    },
    cookieSummary: () => '（测试）',
  };
}

test('楼中楼分页抓完时返回完整元数据', async () => {
  const result = await fetchSubComments(mockClient([
    { replies: [subReply('1'), subReply('2')], page: { count: 3, num: 1, size: 2 } },
    { replies: [subReply('3')], page: { count: 3, num: 2, size: 2 } },
  ]), { bvid: 'BV-test', oid: '1', root: 'root-1', ps: 2, maxReplies: 20 });

  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows.map((row) => row.rpid), ['1', '2', '3']);
  assert.equal(result.totalPages, 2);
  assert.equal(result.isComplete, true);
  assert.equal(result.truncatedByLimit, false);
});

test('楼中楼达到条数上限时明确返回截断', async () => {
  const result = await fetchSubComments(mockClient([
    { replies: [subReply('1'), subReply('2'), subReply('3')], page: { count: 5, num: 1, size: 3 } },
  ]), { bvid: 'BV-test', oid: '1', root: 'root-1', ps: 3, maxReplies: 2 });

  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map((row) => row.rpid), ['1', '2']);
  assert.equal(result.totalPages, 2);
  assert.equal(result.isComplete, false);
  assert.equal(result.truncatedByLimit, true);
});

test('楼中楼跨页重复 rpid 不会虚增完整性计数', async () => {
  const result = await fetchSubComments(mockClient([
    { replies: [subReply('1'), subReply('2')], page: { count: 3, num: 1, size: 2 } },
    { replies: [subReply('2'), subReply('3')], page: { count: 3, num: 2, size: 2 } },
  ]), { bvid: 'BV-test', oid: '1', root: 'root-1', ps: 2, maxReplies: 20 });

  assert.deepEqual(result.rows.map((row) => row.rpid), ['1', '2', '3']);
  assert.equal(result.isComplete, true);
});