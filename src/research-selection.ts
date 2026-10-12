import type { CommentConversation } from './conversation.ts';

const EXPLICIT_AMOUNT_PATTERNS = [
  /[¥￥]\s*\d{2,7}(?:\.\d{1,2})?/i,
  /\d{2,7}(?:\.\d{1,2})?\s*(?:元|块|rmb)/i,
  /(?:最低|到手|入手|成交|售价|下单|买了|券后|补贴后|好价|价格|价)[^\d]{0,8}\d{2,7}(?:\.\d{1,2})?(?:多|左右)?/i,
  /\d{3,7}(?:\.\d{1,2})?(?:多|左右)?[^\d]{0,8}(?:拿下|下单|下.{0,3}单|入手|成交|买(?:的|了)?|没买|好价|这个价|券|减)/i,
];

const PURCHASE_PLAN_PATTERN = /(?:券|补贴|优惠|会员|运费|定金|平台|店|专营店|零点|0点|车|淘宝|京东|拼多多|抖音)/i;

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s\-_+·.,，。/\\()[\]（）]/g, '');
}

/** 优先选择含价格信号和目标商品型号的对话，减少无效模型调用。 */
export function selectResearchConversations(
  conversations: CommentConversation[],
  product: string,
  limit: number,
): CommentConversation[] {
  const productNormalized = normalize(product);
  const productParts = product.toLowerCase().match(/[a-z]+|\d+[a-z]*|[\u4e00-\u9fff]{2,}/g) ?? [];

  return conversations
    .map((conversation) => {
      const text = conversation.messages.map((message) => message.content).join('\n');
      const normalizedText = normalize(text);
      const hasExplicitAmount = EXPLICIT_AMOUNT_PATTERNS.some((pattern) => pattern.test(text));
      const hasPurchasePlan = PURCHASE_PLAN_PATTERN.test(text);
      const exactProduct = productNormalized.length >= 2 && normalizedText.includes(productNormalized);
      const matchedParts = productParts.filter((part) => normalize(part).length >= 2 && normalizedText.includes(normalize(part))).length;
      const rootLikes = conversation.messages[0]?.likeCount ?? 0;
      const hasProductSignal = exactProduct || matchedParts > 0;
      const score = (hasExplicitAmount ? 20 : 0) + (hasPurchasePlan ? 4 : 0)
        + (exactProduct ? 8 : 0) + matchedParts * 2 + Math.log10(rootLikes + 1);
      return { conversation, hasExplicitAmount, hasProductSignal, score };
    })
    .filter((item) => item.hasExplicitAmount && item.hasProductSignal)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(0, limit))
    .map((item) => item.conversation);
}