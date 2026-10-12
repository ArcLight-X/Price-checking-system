import type { CommentConversation } from '../conversation.ts';
import { EXTRACTION_SCHEMA_VERSION } from './types.ts';

/**
 * 生成供应商无关的抽取提示词。调用方可以把 system/user 分别交给任意支持 JSON 输出的 LLM。
 */
export function buildPriceExtractionPrompt(conversation: CommentConversation): {
  system: string;
  user: string;
} {
  const system = `你是商品价格证据抽取器，只能依据给定评论对话输出 JSON。

硬性规则：
1. 不得使用常识补全商品、型号、渠道、时间、价格或优惠条件；缺失时填 null 或 []。
2. 区分 pagePrice（页面展示价）、reportedPaidPrice（评论者报告成交价）和 totalCost（含必需额外费用的总成本）。
3. 会员费、运费、服务费等放入 extraFees；是否已包含在成交价中不清楚时 includedInPaidPrice=null。
4. 每条 claim 必须提供 evidence，label 必须来自输入编号，quote 必须逐字摘自该编号正文。
5. 玩笑、反问、询价不能当成真实成交。
6. 评论证据默认只能是 historical_report 或 unverified，绝不能仅凭评论标成 currently_verified。
7. contextStatus 不是 complete 时要在 verification.reasons 中说明上下文不完整。
8. 只输出一个 JSON 对象，不要 Markdown，不要解释。`;

  const outputShape = {
    schemaVersion: EXTRACTION_SCHEMA_VERSION,
    conversationLabel: conversation.conversationLabel,
    contextStatus: conversation.contextStatus,
    hasPriceClaim: false,
    claims: [{
      product: { brand: null, name: null, model: null, variant: null },
      amounts: {
        pagePrice: null,
        reportedPaidPrice: null,
        extraCostTotal: null,
        totalCost: null,
        currency: null,
      },
      channel: null,
      conditions: [{ type: 'coupon', description: '', required: null }],
      extraFees: [{
        type: 'shipping',
        description: '',
        amount: null,
        required: null,
        includedInPaidPrice: null,
      }],
      purchaseTime: null,
      claimKind: 'unknown',
      evidence: [{ label: conversation.conversationLabel, quote: '' }],
      verification: { status: 'unverified', reasons: [] },
    }],
    notes: [],
  };

  const user = `对话上下文状态：${conversation.contextStatus}
站方回复数：${conversation.expectedReplyCount}
已保留回复数：${conversation.storedReplyCount}

评论对话：
${conversation.text}

严格按以下字段结构输出；没有价格主张时 hasPriceClaim=false 且 claims=[]：
${JSON.stringify(outputShape, null, 2)}`;

  return { system, user };
}