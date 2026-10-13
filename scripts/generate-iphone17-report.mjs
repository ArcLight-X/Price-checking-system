import fs from 'node:fs';
import { matchesRequestedProduct } from '../src/research-selection.ts';

const source = 'data/iPhone-17-research.jsonl';
const output = 'data/iPhone-17-valid-results.md';
const target = 'iPhone 17';
const rows = fs.readFileSync(source, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);

function amountOf(claim) {
  for (const value of [claim.amounts?.totalCost, claim.amounts?.reportedPaidPrice, claim.amounts?.pagePrice]) {
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function combinedText(claim) {
  return [
    ...(claim.conditions ?? []).map((item) => item.description),
    ...(claim.evidence ?? []).map((item) => item.quote),
  ].join(' ');
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function conditionsOf(claim) {
  const parts = [
    ...(claim.conditions ?? []).map((item) => item.description),
    ...(claim.extraFees ?? []).map((item) => item.description),
  ];
  return parts.length > 0 ? parts.join('；') : '无明确附加条件';
}

function evidenceOf(claim) {
  return (claim.evidence ?? []).map((item) => `“${item.quote}”`).join('；');
}

function statusName(status) {
  return status === 'historical_report' ? '历史成交' : '未核验报价';
}

const candidates = [];
for (const row of rows) {
  for (const claim of row.extraction?.claims ?? []) {
    const product = [claim.product?.brand, claim.product?.name, claim.product?.model, claim.product?.variant]
      .filter(Boolean).join(' ');
    const amount = amountOf(claim);
    if (!matchesRequestedProduct(product, target)) continue;
    if (claim.amounts?.currency !== 'CNY' || amount === null) continue;
    if (!['reported_transaction', 'page_offer'].includes(claim.claimKind)) continue;
    if (claim.verification?.status === 'rejected') continue;
    candidates.push({ row, claim, amount, text: combinedText(claim) });
  }
}

const predictionPattern = /明年|估计|预测|可能降|首发|工资|说拿就拿|25年\s*6000/;
const specialPattern = /话费|电信|套餐|每月|交2年|交两年/;
const deduplicated = new Map();
for (const item of candidates) {
  if (predictionPattern.test(item.text)) continue;
  const key = [item.amount, item.claim.channel ?? '', conditionsOf(item.claim), evidenceOf(item.claim)].join('|');
  if (!deduplicated.has(key)) deduplicated.set(key, item);
}

const cleaned = [...deduplicated.values()]
  .sort((left, right) => left.amount - right.amount || left.row.bvid.localeCompare(right.row.bvid));
const special = cleaned.filter((item) => specialPattern.test(item.text));
const historical = cleaned.filter((item) => (
  item.claim.verification?.status === 'historical_report'
  && !specialPattern.test(item.text)
  && item.amount >= 4500
  && item.amount <= 5500
));
const offers = cleaned.filter((item) => (
  item.claim.verification?.status !== 'historical_report'
  && !specialPattern.test(item.text)
  && item.amount >= 4500
  && item.amount <= 5500
));
const references = cleaned.filter((item) => (
  !historical.includes(item) && !offers.includes(item) && !special.includes(item)
));

function table(items) {
  if (items.length === 0) return '_无_\n';
  const lines = [
    '| 价格 | 渠道 | 条件/方案 | 状态 | 原始证据 | 来源 |',
    '|---:|---|---|---|---|---|',
  ];
  for (const { row, claim, amount } of items) {
    lines.push(
      `| ¥${amount} | ${escapeCell(claim.channel ?? '未提及')} | ${escapeCell(conditionsOf(claim))}`
      + ` | ${statusName(claim.verification?.status)} | ${escapeCell(evidenceOf(claim))}`
      + ` | ${row.bvid} / ${row.conversationLabel} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

const generatedAt = new Date().toISOString();
const markdown = `# iPhone 17 基础版有效价格研究结果

> 生成时间：${generatedAt}<br>
> 数据范围：3 个 B站视频，每个视频抓取 30 条热门评论、10 条最近评论，并分析最多 10 个价格候选。<br>
> 模型：doubao-seed-2-0-lite-260428

## 结论摘要

- 已排除 **iPhone 17 Pro / Pro Max / Plus**、\`17pm\` 缩写、配件、金额未知和预测性内容。
- 共整理出 **${cleaned.length} 条**有明确人民币金额的基础版线索。
- 重点区间内有 **${historical.length} 条历史成交记录**、**${offers.length} 条平台报价线索**，另有 **${special.length} 条高门槛方案**。
- 较值得优先核实的价位集中在 **¥4,900–¥5,299**；更低价格通常伴随置换、回收或通信套餐条件。
- 所有价格均来自评论历史报告或未核验页面线索，**不代表当前仍能买到**。

## 1. 历史成交记录（¥4,500–¥5,500）

评论者明确表示已经购买或到货，可信度相对高，但活动可能已经结束。

${table(historical)}

## 2. 常规平台报价线索（¥4,500–¥5,500）

这些是评论中提到的页面价或活动价，未验证当前库存、优惠券和账号资格。

${table(offers)}

## 3. 高门槛低价方案

价格看似较低，但附带通信套餐等长期成本，不能只比较手机标价。

${table(special)}

## 4. 其他参考价格

包括较高容量、港版或偏高报价，仅供判断价格区间，不作为优先好价推荐。

${table(references)}

## 建议

1. **¥4,900–¥5,100**：可作为基础版第三方平台活动价的重点观察区间。
2. **¥4,599–¥4,979**：通常需要置换补贴、回收资格或限时直减，应核算旧设备价值。
3. **¥3,199 通信方案**：必须把两年话费总额计入成本，不能视为裸机到手价。
4. 下单前核对容量、国行/港版、是否官方或百亿补贴店、退换政策、发票及激活状态。
5. 原始结构化数据位于 \`data/iPhone-17-research.jsonl\`。
`;

fs.writeFileSync(output, markdown, 'utf8');
console.log(JSON.stringify({
  output,
  bytes: Buffer.byteLength(markdown),
  cleaned: cleaned.length,
  historical: historical.length,
  offers: offers.length,
  special: special.length,
  references: references.length,
}, null, 2));