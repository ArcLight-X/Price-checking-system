import type { ConversationContextStatus } from '../conversation.ts';

/** 模型输出协议版本。后续字段变更时通过版本号做兼容。 */
export const EXTRACTION_SCHEMA_VERSION = '1.0' as const;

export type Currency = 'CNY' | 'USD' | 'EUR' | 'GBP' | 'JPY' | 'HKD' | 'TWD';
export type ClaimKind = 'reported_transaction' | 'page_offer' | 'question' | 'joke' | 'unknown';
export type VerificationStatus = 'historical_report' | 'unverified' | 'currently_verified' | 'rejected';
export type ConditionType = 'membership' | 'coupon' | 'flash_sale' | 'payment' | 'trade_in' | 'other';
export type ExtraFeeType = 'membership' | 'shipping' | 'service' | 'other';

export interface ExtractedProduct {
  brand: string | null;
  name: string | null;
  model: string | null;
  variant: string | null;
}

export interface PriceAmounts {
  /** 评论提到的页面展示价，不等于实际成交价。 */
  pagePrice: number | null;
  /** 评论者报告实际支付给商家的金额。 */
  reportedPaidPrice: number | null;
  /** 必需且未包含在成交价中的额外费用合计。 */
  extraCostTotal: number | null;
  /** reportedPaidPrice + extraCostTotal；任一组成部分未知时应为 null。 */
  totalCost: number | null;
  currency: Currency | null;
}

export interface PurchaseCondition {
  type: ConditionType;
  description: string;
  required: boolean | null;
}

export interface ExtraFee {
  type: ExtraFeeType;
  description: string;
  amount: number | null;
  required: boolean | null;
  /** 是否已经包含在 reportedPaidPrice 中；不知道必须填 null。 */
  includedInPaidPrice: boolean | null;
}

export interface EvidenceReference {
  /** 对话里的 C001 / C001-R001 等稳定编号。 */
  label: string;
  /** 必须逐字来自对应评论，不允许改写或拼接。 */
  quote: string;
}

export interface PriceClaim {
  product: ExtractedProduct;
  amounts: PriceAmounts;
  channel: string | null;
  conditions: PurchaseCondition[];
  extraFees: ExtraFee[];
  purchaseTime: string | null;
  claimKind: ClaimKind;
  evidence: EvidenceReference[];
  verification: {
    status: VerificationStatus;
    reasons: string[];
  };
}

/** LLM 对一个评论对话的完整输出。缺失信息必须用 null/[]，不能省略字段。 */
export interface PriceExtraction {
  schemaVersion: typeof EXTRACTION_SCHEMA_VERSION;
  conversationLabel: string;
  contextStatus: ConversationContextStatus;
  hasPriceClaim: boolean;
  claims: PriceClaim[];
  notes: string[];
}

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: ValidationSeverity;
  path: string;
  code: string;
  message: string;
}

export interface ExtractionValidationResult {
  ok: boolean;
  value: PriceExtraction | null;
  issues: ValidationIssue[];
}