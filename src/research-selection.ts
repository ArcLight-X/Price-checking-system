import type { CommentConversation } from './conversation.ts';

const PRICE_PATTERN = /(?:[¥￥]\s*\d|\d{2,7}(?:\.\d{1,2})?\s*(?:元|块|rmb)|到手|入手|成交|价格|券后|补贴|优惠|会员|运费|定金)/i;

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
      const hasPriceSignal = PRICE_PATTERN.test(text);
      const exactProduct = productNormalized.length >= 2 && normalizedText.includes(productNormalized);
      const matchedParts = productParts.filter((part) => normalize(part).length >= 2 && normalizedText.includes(normalize(part))).length;
      const rootLikes = conversation.messages[0]?.likeCount ?? 0;
      const score = (hasPriceSignal ? 10 : 0) + (exactProduct ? 8 : 0) + matchedParts * 2 + Math.log10(rootLikes + 1);
      return { conversation, hasPriceSignal, score };
    })
    .filter((item) => item.hasPriceSignal)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(0, limit))
    .map((item) => item.conversation);
}