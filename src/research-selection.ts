import type { CommentConversation } from './conversation.ts';

export const MIN_RESEARCH_VIDEO_PLAY = 5000;

export function hasEnoughPlays(video: { play: number }): boolean {
  return video.play >= MIN_RESEARCH_VIDEO_PLAY;
}

function normalizeProductName(value: string): string {
  return value.toLowerCase().replace(/[\s\-_+·.,，。/\\()[\]（）]/g, '');
}

/** 排除用户目标型号后面又多出一代数字的标题，例如 MacBook Neo 2。 */
export function matchesRequestedProduct(title: string, product: string): boolean {
  const normalizedProduct = normalizeProductName(product);
  const normalizedTitle = normalizeProductName(title);
  const position = normalizedTitle.indexOf(normalizedProduct);
  if (position < 0) return false;

  const suffix = normalizedTitle.slice(position + normalizedProduct.length);
  return !/^[2-9](?!\d|gb|tb|寸|英寸)/.test(suffix);
}

const EXPLICIT_AMOUNT_PATTERNS = [
  /[¥￥]\s*\d{2,7}(?:\.\d{1,2})?/i,
  /\d{2,7}(?:\.\d{1,2})?\s*(?:元|块|rmb)/i,
  /(?:最低|到手|入手|成交|售价|下单|买了|券后|补贴后|好价|价格|价)[^\d]{0,8}\d{2,7}(?:\.\d{1,2})?(?:多|左右)?/i,
  /\d{3,7}(?:\.\d{1,2})?(?:多|左右)?[^\d]{0,8}(?:拿下|下单|下.{0,3}单|到手|入手|成交|买(?:的|了)?|没买|好价|这个价|券|减)/i,
  /(?:最低|到手|入手|成交|售价|下单|买了|券后|补贴后|好价|价格|价)[^\d一二两三四五六七八九十]{0,8}(?:\d+(?:\.\d+)?\s*[千kK]|[一二两三四五六七八九十]\s*千)(?:多|左右)?/i,
  /(?:\d+(?:\.\d+)?\s*[千kK]|[一二两三四五六七八九十]\s*千)(?:多|左右)?[^\d一二两三四五六七八九十]{0,8}(?:拿下|下单|到手|入手|成交|买(?:的|了)?|没买|好价|价格|这个价|券|补贴)/i,
];

const PURCHASE_PLAN_PATTERN = /(?:价格|价位|券|补贴|优惠|会员|运费|定金|平台|店|专营店|零点|0点|车|淘宝|京东|拼多多|抖音)/i;

function normalize(value: string): string {
  return normalizeProductName(value);
}

/** 优先选择含价格信号和目标商品型号的对话，减少无效模型调用。 */
export function selectResearchConversations(
  conversations: CommentConversation[],
  product: string,
  limit: number,
  context: { videoTitle?: string } = {},
): CommentConversation[] {
  const productNormalized = normalize(product);
  const productParts = product.toLowerCase().match(/[a-z]+|\d+[a-z]*|[\u4e00-\u9fff]{2,}/g) ?? [];
  const normalizedTitle = normalize(context.videoTitle ?? '');
  const titleMatchesProduct = productNormalized.length >= 2 && normalizedTitle.includes(productNormalized);

  return conversations
    .map((conversation) => {
      const text = conversation.messages.map((message) => message.content).join('\n');
      const normalizedText = normalize(text);
      const hasExplicitAmount = EXPLICIT_AMOUNT_PATTERNS.some((pattern) => pattern.test(text));
      const hasPurchasePlan = PURCHASE_PLAN_PATTERN.test(text);
      const exactProduct = productNormalized.length >= 2 && normalizedText.includes(productNormalized);
      const matchedParts = productParts.filter((part) => normalize(part).length >= 2 && normalizedText.includes(normalize(part))).length;
      const rootLikes = conversation.messages[0]?.likeCount ?? 0;
      // 目标商品视频中的评论经常只写“3399”“某东国补”，不会重复完整商品名。
      // 仅在标题完整命中目标商品、且评论同时带购买方案语境时继承视频商品信号。
      const inheritedProductSignal = titleMatchesProduct && hasPurchasePlan;
      const hasProductSignal = exactProduct || matchedParts > 0 || inheritedProductSignal;
      const score = (hasExplicitAmount ? 20 : 0) + (hasPurchasePlan ? 4 : 0)
        + (exactProduct ? 8 : 0) + matchedParts * 2 + (inheritedProductSignal ? 1 : 0)
        + Math.log10(rootLikes + 1);
      return { conversation, hasExplicitAmount, hasProductSignal, score };
    })
    .filter((item) => item.hasExplicitAmount && item.hasProductSignal)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(0, limit))
    .map((item) => item.conversation);
}