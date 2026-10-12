import type { CommentConversation } from '../conversation.ts';
import {
  EXTRACTION_SCHEMA_VERSION,
  type ClaimKind,
  type ConditionType,
  type ExtraFeeType,
  type ExtractionValidationResult,
  type PriceClaim,
  type PriceExtraction,
  type ValidationIssue,
  type VerificationStatus,
} from './types.ts';

const CLAIM_KINDS = new Set<ClaimKind>(['reported_transaction', 'page_offer', 'question', 'joke', 'unknown']);
const VERIFICATION_STATUSES = new Set<VerificationStatus>(['historical_report', 'unverified', 'currently_verified', 'rejected']);
const CONDITION_TYPES = new Set<ConditionType>(['membership', 'coupon', 'flash_sale', 'payment', 'trade_in', 'other']);
const EXTRA_FEE_TYPES = new Set<ExtraFeeType>(['membership', 'shipping', 'service', 'other']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean';
}

function isMoney(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function addIssue(
  issues: ValidationIssue[],
  severity: 'error' | 'warning',
  path: string,
  code: string,
  message: string,
): void {
  issues.push({ severity, path, code, message });
}

function requireStringArray(value: unknown, path: string, issues: ValidationIssue[]): value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    addIssue(issues, 'error', path, 'invalid_string_array', '必须是字符串数组');
    return false;
  }
  return true;
}

/**
 * 验证并规范化模型输出。默认不允许任何“当前已核实”结论，因为输入只有评论证据。
 */
export function validatePriceExtraction(
  input: unknown,
  conversation: CommentConversation,
): ExtractionValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) {
    return {
      ok: false,
      value: null,
      issues: [{ severity: 'error', path: '$', code: 'not_object', message: '模型输出必须是 JSON 对象' }],
    };
  }

  if (input['schemaVersion'] !== EXTRACTION_SCHEMA_VERSION) {
    addIssue(issues, 'error', '$.schemaVersion', 'schema_version', `必须为 ${EXTRACTION_SCHEMA_VERSION}`);
  }
  if (input['conversationLabel'] !== conversation.conversationLabel) {
    addIssue(issues, 'error', '$.conversationLabel', 'conversation_mismatch', '对话编号与输入不一致');
  }
  if (input['contextStatus'] !== conversation.contextStatus) {
    addIssue(issues, 'error', '$.contextStatus', 'context_mismatch', '上下文状态必须原样回传');
  }
  if (typeof input['hasPriceClaim'] !== 'boolean') {
    addIssue(issues, 'error', '$.hasPriceClaim', 'invalid_boolean', '必须是布尔值');
  }
  requireStringArray(input['notes'], '$.notes', issues);

  const rawClaims = input['claims'];
  if (!Array.isArray(rawClaims)) {
    addIssue(issues, 'error', '$.claims', 'invalid_claims', 'claims 必须是数组');
  }

  const claims: PriceClaim[] = [];
  if (Array.isArray(rawClaims)) {
    rawClaims.forEach((rawClaim, claimIndex) => {
      const path = `$.claims[${claimIndex}]`;
      if (!isRecord(rawClaim)) {
        addIssue(issues, 'error', path, 'invalid_claim', 'claim 必须是对象');
        return;
      }

      const product = rawClaim['product'];
      const amounts = rawClaim['amounts'];
      const verification = rawClaim['verification'];
      if (!isRecord(product)) addIssue(issues, 'error', `${path}.product`, 'invalid_product', 'product 必须是对象');
      if (!isRecord(amounts)) addIssue(issues, 'error', `${path}.amounts`, 'invalid_amounts', 'amounts 必须是对象');
      if (!isRecord(verification)) addIssue(issues, 'error', `${path}.verification`, 'invalid_verification', 'verification 必须是对象');
      if (!isRecord(product) || !isRecord(amounts) || !isRecord(verification)) return;

      for (const field of ['brand', 'name', 'model', 'variant'] as const) {
        if (!isNullableString(product[field])) {
          addIssue(issues, 'error', `${path}.product.${field}`, 'invalid_nullable_string', '必须是字符串或 null');
        }
      }
      for (const field of ['pagePrice', 'reportedPaidPrice', 'extraCostTotal', 'totalCost'] as const) {
        if (!isMoney(amounts[field])) {
          addIssue(issues, 'error', `${path}.amounts.${field}`, 'invalid_money', '必须是非负有限数字或 null');
        }
      }
      if (amounts['currency'] !== null && amounts['currency'] !== 'CNY') {
        addIssue(issues, 'error', `${path}.amounts.currency`, 'invalid_currency', '目前只接受 CNY 或 null');
      }
      if (!isNullableString(rawClaim['channel'])) {
        addIssue(issues, 'error', `${path}.channel`, 'invalid_nullable_string', '必须是字符串或 null');
      }
      if (!isNullableString(rawClaim['purchaseTime'])) {
        addIssue(issues, 'error', `${path}.purchaseTime`, 'invalid_nullable_string', '必须是字符串或 null');
      }
      if (!CLAIM_KINDS.has(rawClaim['claimKind'] as ClaimKind)) {
        addIssue(issues, 'error', `${path}.claimKind`, 'invalid_claim_kind', '未知的 claimKind');
      }

      const conditions = rawClaim['conditions'];
      if (!Array.isArray(conditions)) {
        addIssue(issues, 'error', `${path}.conditions`, 'invalid_conditions', 'conditions 必须是数组');
      } else {
        conditions.forEach((condition, index) => {
          const itemPath = `${path}.conditions[${index}]`;
          if (!isRecord(condition)) {
            addIssue(issues, 'error', itemPath, 'invalid_condition', '条件必须是对象');
            return;
          }
          if (!CONDITION_TYPES.has(condition['type'] as ConditionType)) addIssue(issues, 'error', `${itemPath}.type`, 'invalid_condition_type', '未知条件类型');
          if (typeof condition['description'] !== 'string') addIssue(issues, 'error', `${itemPath}.description`, 'invalid_string', '必须是字符串');
          if (!isNullableBoolean(condition['required'])) addIssue(issues, 'error', `${itemPath}.required`, 'invalid_nullable_boolean', '必须是布尔值或 null');
        });
      }

      const extraFees = rawClaim['extraFees'];
      if (!Array.isArray(extraFees)) {
        addIssue(issues, 'error', `${path}.extraFees`, 'invalid_extra_fees', 'extraFees 必须是数组');
      } else {
        extraFees.forEach((fee, index) => {
          const itemPath = `${path}.extraFees[${index}]`;
          if (!isRecord(fee)) {
            addIssue(issues, 'error', itemPath, 'invalid_extra_fee', '额外费用必须是对象');
            return;
          }
          if (!EXTRA_FEE_TYPES.has(fee['type'] as ExtraFeeType)) addIssue(issues, 'error', `${itemPath}.type`, 'invalid_fee_type', '未知费用类型');
          if (typeof fee['description'] !== 'string') addIssue(issues, 'error', `${itemPath}.description`, 'invalid_string', '必须是字符串');
          if (!isMoney(fee['amount'])) addIssue(issues, 'error', `${itemPath}.amount`, 'invalid_money', '必须是非负有限数字或 null');
          if (!isNullableBoolean(fee['required'])) addIssue(issues, 'error', `${itemPath}.required`, 'invalid_nullable_boolean', '必须是布尔值或 null');
          if (!isNullableBoolean(fee['includedInPaidPrice'])) addIssue(issues, 'error', `${itemPath}.includedInPaidPrice`, 'invalid_nullable_boolean', '必须是布尔值或 null');
        });
      }

      const evidence = rawClaim['evidence'];
      const messageByLabel = new Map(conversation.messages.map((message) => [message.label, message]));
      if (!Array.isArray(evidence) || evidence.length === 0) {
        addIssue(issues, 'error', `${path}.evidence`, 'missing_evidence', '每条价格主张至少需要一条证据');
      } else {
        evidence.forEach((reference, index) => {
          const itemPath = `${path}.evidence[${index}]`;
          if (!isRecord(reference) || typeof reference['label'] !== 'string' || typeof reference['quote'] !== 'string') {
            addIssue(issues, 'error', itemPath, 'invalid_evidence', '证据必须包含字符串 label 和 quote');
            return;
          }
          const message = messageByLabel.get(reference['label']);
          if (!message) {
            addIssue(issues, 'error', `${itemPath}.label`, 'unknown_evidence_label', '证据编号不存在于当前对话');
          } else if (reference['quote'].length === 0 || !message.content.includes(reference['quote'])) {
            addIssue(issues, 'error', `${itemPath}.quote`, 'quote_not_verbatim', 'quote 必须逐字出现在对应评论正文中');
          }
        });
      }

      if (!VERIFICATION_STATUSES.has(verification['status'] as VerificationStatus)) {
        addIssue(issues, 'error', `${path}.verification.status`, 'invalid_verification_status', '未知核验状态');
      }
      requireStringArray(verification['reasons'], `${path}.verification.reasons`, issues);

      if (verification['status'] === 'currently_verified') {
        addIssue(issues, 'error', `${path}.verification.status`, 'comment_cannot_verify_current', '仅凭评论不能标记为当前可实现低价');
      }
      if (verification['status'] === 'historical_report' && rawClaim['claimKind'] !== 'reported_transaction') {
        addIssue(issues, 'error', `${path}.verification.status`, 'historical_requires_transaction', 'historical_report 必须对应明确的成交报告');
      }
      if (conversation.contextStatus !== 'complete' && verification['status'] === 'historical_report') {
        addIssue(issues, 'warning', `${path}.verification.status`, 'incomplete_context', '上下文不完整，历史成交报告仍需人工复核');
      }

      const paid = amounts['reportedPaidPrice'];
      const extraTotal = amounts['extraCostTotal'];
      const total = amounts['totalCost'];
      if (Array.isArray(extraFees)) {
        const knownRequiredFees = extraFees.filter((fee): fee is Record<string, unknown> => (
          isRecord(fee)
          && fee['required'] === true
          && fee['includedInPaidPrice'] === false
          && typeof fee['amount'] === 'number'
          && Number.isFinite(fee['amount'])
        ));
        const hasUnknownRequiredFee = extraFees.some((fee) => (
          isRecord(fee)
          && fee['required'] === true
          && fee['includedInPaidPrice'] !== true
          && fee['amount'] === null
        ));
        const calculatedExtraTotal = knownRequiredFees.reduce((sum, fee) => sum + Number(fee['amount']), 0);
        if (hasUnknownRequiredFee && extraTotal !== null) {
          addIssue(issues, 'error', `${path}.amounts.extraCostTotal`, 'unknown_required_fee', '存在金额未知的必需费用时，extraCostTotal 必须为 null');
        } else if (!hasUnknownRequiredFee && typeof extraTotal === 'number' && Math.abs(extraTotal - calculatedExtraTotal) > 0.005) {
          addIssue(issues, 'error', `${path}.amounts.extraCostTotal`, 'extra_fee_sum_mismatch', `额外费用合计应为 ${calculatedExtraTotal}`);
        }
      }
      if (typeof paid === 'number' && typeof extraTotal === 'number' && typeof total === 'number') {
        const expected = paid + extraTotal;
        if (Math.abs(expected - total) > 0.005) {
          addIssue(issues, 'error', `${path}.amounts.totalCost`, 'amount_mismatch', `总成本应为 ${expected}`);
        }
      } else if (total !== null && (paid === null || extraTotal === null)) {
        addIssue(issues, 'error', `${path}.amounts.totalCost`, 'total_without_components', '组成金额未知时 totalCost 必须为 null');
      }

      // 只有该 claim 没有结构错误时才作为类型安全值返回。
      const claimHasError = issues.some((issue) => issue.severity === 'error' && issue.path.startsWith(path));
      if (!claimHasError) claims.push(rawClaim as unknown as PriceClaim);
    });
  }

  if (input['hasPriceClaim'] === false && Array.isArray(rawClaims) && rawClaims.length > 0) {
    addIssue(issues, 'error', '$.claims', 'claim_flag_mismatch', 'hasPriceClaim=false 时 claims 必须为空');
  }
  if (input['hasPriceClaim'] === true && Array.isArray(rawClaims) && rawClaims.length === 0) {
    addIssue(issues, 'error', '$.claims', 'claim_flag_mismatch', 'hasPriceClaim=true 时 claims 不能为空');
  }

  const hasError = issues.some((issue) => issue.severity === 'error');
  if (hasError) return { ok: false, value: null, issues };

  return {
    ok: true,
    value: {
      schemaVersion: EXTRACTION_SCHEMA_VERSION,
      conversationLabel: conversation.conversationLabel,
      contextStatus: conversation.contextStatus,
      hasPriceClaim: input['hasPriceClaim'] as boolean,
      claims,
      notes: input['notes'] as string[],
    },
    issues,
  };
}