import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommentConversation } from '../src/conversation.ts';
import { buildPriceExtractionPrompt } from '../src/extractor/prompt.ts';
import type { PriceExtraction } from '../src/extractor/types.ts';
import { validatePriceExtraction } from '../src/extractor/validator.ts';

function conversation(contextStatus: CommentConversation['contextStatus'] = 'complete'): CommentConversation {
  return {
    conversationLabel: 'C001',
    rootRpid: 'root-1',
    expectedReplyCount: 2,
    storedReplyCount: 2,
    contextStatus,
    messages: [
      {
        label: 'C001', rpid: 'root-1', parentRpid: null, parentLabel: null, relation: 'root',
        uname: '甲', content: '页面价1999，京东PLUS券后1799拿下', ctime: 100,
        timeIso: '1970-01-01T00:01:40.000Z', likeCount: 3,
      },
      {
        label: 'C001-R001', rpid: 'reply-1', parentRpid: 'root-1', parentLabel: 'C001', relation: 'reply_to_root',
        uname: '乙', content: '还要10元运费', ctime: 110,
        timeIso: '1970-01-01T00:01:50.000Z', likeCount: 1,
      },
    ],
    text: '[C001] 页面价1999，京东PLUS券后1799拿下\n[C001-R001] 还要10元运费',
  };
}

function validExtraction(): PriceExtraction {
  return {
    schemaVersion: '1.0',
    conversationLabel: 'C001',
    contextStatus: 'complete',
    hasPriceClaim: true,
    claims: [{
      product: { brand: null, name: null, model: null, variant: null },
      amounts: {
        pagePrice: 1999,
        reportedPaidPrice: 1799,
        extraCostTotal: 10,
        totalCost: 1809,
        currency: 'CNY',
      },
      channel: '京东',
      conditions: [{ type: 'membership', description: '需要京东PLUS', required: true }],
      extraFees: [{
        type: 'shipping', description: '运费', amount: 10, required: true, includedInPaidPrice: false,
      }],
      purchaseTime: null,
      claimKind: 'reported_transaction',
      evidence: [
        { label: 'C001', quote: '页面价1999，京东PLUS券后1799拿下' },
        { label: 'C001-R001', quote: '还要10元运费' },
      ],
      verification: { status: 'historical_report', reasons: ['评论者报告历史成交，未核验当前活动'] },
    }],
    notes: [],
  };
}

test('接受证据存在且金额可复算的历史成交报告', () => {
  const result = validatePriceExtraction(validExtraction(), conversation());
  assert.equal(result.ok, true);
  assert.equal(result.value?.claims[0]?.amounts.totalCost, 1809);
  assert.deepEqual(result.issues, []);
});

test('仅凭评论禁止标记为当前可实现低价', () => {
  const input = validExtraction();
  input.claims[0]!.verification.status = 'currently_verified';
  const result = validatePriceExtraction(input, conversation());
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'comment_cannot_verify_current'));
});

test('拒绝不存在的证据编号和非逐字引用', () => {
  const input = validExtraction();
  input.claims[0]!.evidence = [
    { label: 'C999', quote: '1799' },
    { label: 'C001', quote: '模型自己改写的1799成交价' },
  ];
  const result = validatePriceExtraction(input, conversation());
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'unknown_evidence_label'));
  assert.ok(result.issues.some((issue) => issue.code === 'quote_not_verbatim'));
});

test('拒绝无法复算的总成本', () => {
  const input = validExtraction();
  input.claims[0]!.amounts.totalCost = 1799;
  const result = validatePriceExtraction(input, conversation());
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'amount_mismatch'));
});

test('拒绝与费用明细不一致的额外费用合计', () => {
  const input = validExtraction();
  input.claims[0]!.amounts.extraCostTotal = 0;
  input.claims[0]!.amounts.totalCost = 1799;
  const result = validatePriceExtraction(input, conversation());
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'extra_fee_sum_mismatch'));
});

test('必需费用金额未知时禁止编造总成本', () => {
  const input = validExtraction();
  input.claims[0]!.extraFees[0]!.amount = null;
  input.claims[0]!.amounts.extraCostTotal = 10;
  input.claims[0]!.amounts.totalCost = 1809;
  const result = validatePriceExtraction(input, conversation());
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'unknown_required_fee'));
});

test('一条 claim 不合规时仍保留同组中已通过验证的 claim', () => {
  const valid = validExtraction().claims[0]!;
  const invalid = structuredClone(valid);
  invalid.conditions = [{ type: 'limited_time' as never, description: '最后两小时', required: true }];
  const input = validExtraction();
  input.claims = [valid, invalid];
  const result = validatePriceExtraction(input, conversation());
  assert.equal(result.ok, false);
  assert.equal(result.value?.claims.length, 1);
  assert.ok(result.issues.some((issue) => issue.code === 'invalid_condition_type'));
});

test('截断上下文中的历史报告保留但发出人工复核警告', () => {
  const input = validExtraction();
  input.contextStatus = 'truncated';
  const result = validatePriceExtraction(input, conversation('truncated'));
  assert.equal(result.ok, true);
  assert.ok(result.issues.some((issue) => issue.code === 'incomplete_context' && issue.severity === 'warning'));
});

test('没有价格主张时允许 claims 为空', () => {
  const input = {
    schemaVersion: '1.0', conversationLabel: 'C001', contextStatus: 'complete',
    hasPriceClaim: false, claims: [], notes: ['只有询问，没有成交信息'],
  };
  const result = validatePriceExtraction(input, conversation());
  assert.equal(result.ok, true);
  assert.equal(result.value?.claims.length, 0);
});

test('Prompt 强制未知值、逐字证据和禁止评论冒充当前核验', () => {
  const prompt = buildPriceExtractionPrompt(conversation('truncated'), {
    targetProduct: 'RTX 5070 Ti',
    videoTitle: '显卡购买建议',
  });
  assert.match(prompt.system, /缺失时填 null 或 \[\]/);
  assert.match(prompt.system, /逐字摘自/);
  assert.match(prompt.system, /绝不能仅凭评论标成 currently_verified/);
  assert.match(prompt.system, /claimKind 只能是 reported_transaction/);
  assert.match(prompt.system, /extraCostTotal=0/);
  assert.match(prompt.system, /conditions.type 只能是 membership/);
  assert.match(prompt.user, /contextStatus|上下文状态：truncated/);
  assert.match(prompt.user, /还要10元运费/);
  assert.match(prompt.user, /目标商品：RTX 5070 Ti/);
  assert.match(prompt.user, /视频标题：显卡购买建议/);
});