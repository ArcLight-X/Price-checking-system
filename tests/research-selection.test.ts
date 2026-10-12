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
    conversation('C004', '价格这么高谁买啊', 10000),
  ], 'RTX 5070 Ti', 2);

  assert.deepEqual(selected.map((item) => item.conversationLabel), ['C002']);
});

test('识别评论区常见的省略货币单位口语价格', () => {
  const selected = selectResearchConversations([
    conversation('C001', '一句话，去年618最低5500的5070ti'),
    conversation('C002', '5070ti我在这家6900刚下的单，没有更高额度的券了'),
    conversation('C003', '凌晨买了张5070TI追风6100多，我券是减720'),
    conversation('C004', '去年年底5689买的丐版5070ti'),
    conversation('C005', '580涨到3000块钱，3080涨到一万多'),
  ], 'RTX 5070 Ti', 10);

  assert.deepEqual(
    new Set(selected.map((item) => item.conversationLabel)),
    new Set(['C001', 'C002', 'C003', 'C004']),
  );
});

test('识别中文千位模糊价格', () => {
  const selected = selectResearchConversations([
    conversation('C001', '如何两千多买苹果MacBook Neo'),
    conversation('C002', '正常应该是三千多的价格'),
    conversation('C003', '4千多该喷，2千多就很不错了'),
  ], 'MacBook Neo', 10, { videoTitle: 'MacBook Neo购买指南' });

  assert.deepEqual(
    new Set(selected.map((item) => item.conversationLabel)),
    new Set(['C001', 'C002']),
  );
});

test('目标商品视频中的购买方案评论可以继承视频商品信号', () => {
  const selected = selectResearchConversations([
    conversation('C001', '某东教育优惠加国补，3399可以直接到手'),
    conversation('C002', 'iPad 11屏幕不错'),
  ], 'MacBook Neo', 10, { videoTitle: 'MacBook Neo 低价购买实操' });

  assert.deepEqual(selected.map((item) => item.conversationLabel), ['C001']);
});

test('识别标题中的金额在前购买词在后表达', () => {
  const selected = selectResearchConversations([
    conversation('V001', 'MacBook Neo叠满优惠2999到手'),
    conversation('V002', '如何两千多买苹果MacBook Neo'),
  ], 'MacBook Neo', 10);

  assert.deepEqual(selected.map((item) => item.conversationLabel), ['V001', 'V002']);
});
