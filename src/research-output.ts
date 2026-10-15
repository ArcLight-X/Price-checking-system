import type { PriceClaim } from './extractor/types.ts';

export const SUMMARY_COLUMNS = ['商品', '价格', '渠道与方案', '时间', '状态', '证据', '视频'] as const;

/** 避免表格软件把评论中的公式前缀当成公式执行。 */
function csvCell(value: unknown): string {
  const text = String(value ?? '');
  const safe = /^[\s\uFEFF]*[=+@\-\t\r]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** UTF-8 BOM 方便 Windows Excel 识别中文；无记录时也输出标题行。 */
export function summaryToCsv(rows: ReadonlyArray<Record<string, unknown>>): string {
  return `\uFEFF${[
    SUMMARY_COLUMNS.map(csvCell).join(','),
    ...rows.map((row) => SUMMARY_COLUMNS.map((column) => csvCell(row[column])).join(',')),
  ].join('\r\n')}\r\n`;
}

export function displayAmount(claim: PriceClaim): string | null {
  const amount = claim.amounts.totalCost
    ?? claim.amounts.reportedPaidPrice
    ?? claim.amounts.pagePrice;
  if (amount === null || !Number.isFinite(amount)) return null;
  const symbols: Record<NonNullable<PriceClaim['amounts']['currency']>, string> = {
    CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥', HKD: 'HK$', TWD: 'NT$',
  };
  const currency = claim.amounts.currency;
  return currency ? `${symbols[currency]}${amount}` : `${amount}（币种未明）`;
}

export function displayPlan(claim: PriceClaim): string | null {
  const parts = [
    claim.channel,
    ...claim.conditions.map((condition) => condition.description),
    ...claim.extraFees.map((fee) => fee.description),
  ].filter((value): value is string => Boolean(value?.trim()));
  return parts.length > 0 ? parts.join('；') : null;
}

/** 只展示同时有明确金额和具体购买方案的主张；JSONL 保留完整数据。 */
export function toSummaryRow(claim: PriceClaim, product: string, bvid: string): Record<string, unknown> | null {
  const amount = displayAmount(claim);
  const plan = displayPlan(claim);
  if (amount === null || plan === null) return null;
  const row: Record<string, unknown> = {
    商品: [claim.product.brand, claim.product.name, claim.product.model, claim.product.variant]
      .filter(Boolean).join(' ') || product,
    价格: amount,
    渠道与方案: plan,
  };
  row['时间'] = claim.purchaseTime ?? '未提及';
  row['状态'] = claim.verification.status;
  row['证据'] = claim.evidence.map((evidence) => evidence.quote).join('｜');
  row['视频'] = bvid;
  return row;
}