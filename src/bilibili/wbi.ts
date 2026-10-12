/**
 * wbi.ts —— B站 WBI 签名算法（纯函数，零依赖）
 *
 * 【为什么需要这个文件】
 * B站自 2023 年起给 web 接口加了 WBI 签名校验：请求参数里必须带 wts（时间戳）
 * 和 w_rid（签名值），否则接口直接返回 -403。
 *
 * 【算法五步】
 * 1. 调 https://api.bilibili.com/x/web-interface/nav 拿到 wbi_img.img_url / sub_url
 * 2. 从这两个 URL 里各取出文件名（去掉目录和 .png 后缀），得到 img_key、sub_key
 * 3. 把 img_key + sub_key 拼接后，按官方写死的 MIXIN_KEY_ENC_TAB 打乱表重排，取前 32 位 → mixin_key
 * 4. 业务参数按 key 字母序升序排列，值里过滤掉 !'()* 这 5 个字符，再做 URL 编码，拼成 query
 * 5. w_rid = md5(query + mixin_key)，最终 query 末尾追加 &w_rid=xxx
 *
 * 【工程意义】
 * B站改过多次风控算法，将来还可能再改。所以本文件是「签名逻辑的唯一落点」，
 * 一旦失效，只需要改这一个文件，其他代码完全不用动。
 */

// 引入 Node 内置的加密模块，用来计算 MD5（不需要安装任何 npm 包）
import { createHash } from 'node:crypto';

/**
 * 官方前端里写死的「打乱表」：64 个数字，代表取值顺序。
 * 这个常量不能改，改了签名就错，接口会返回 -403。
 */
const MIXIN_KEY_ENC_TAB: readonly number[] = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

/**
 * 参数值中需要被剔除的字符集合。
 * 这是 B站官方 JS 里的行为（为的是和浏览器 encodeURIComponent 的结果保持一致），
 * 少剔一个字符，算出来的 w_rid 就会和服务器对不上。
 */
const CHR_FILTER = /[!'()*]/g;

/**
 * 从 wbi 图片地址里取出真正的 key。
 * 例如 https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png
 *   → 7cd084941338484aae1ad9425b84077c
 * @param url 图片完整地址（img_url 或 sub_url）
 * @returns 32 位十六进制字符串形式的 key
 */
export function pickKeyFromUrl(url: string): string {
  // 先取最后一个 "/" 之后的文件名部分，再取第一个 "." 之前的部分（去掉扩展名）
  const fileName = url.slice(url.lastIndexOf('/') + 1);
  return fileName.split('.')[0] ?? '';
}

/**
 * 由 img_key 和 sub_key 计算出 mixin_key。
 * @param imgKey nav 接口 img_url 解析出的 key
 * @param subKey nav 接口 sub_url 解析出的 key
 * @returns 截取到 32 位的 mixin_key
 */
export function getMixinKey(imgKey: string, subKey: string): string {
  // 先把两个 key 首尾拼接成一个长字符串
  const source = `${imgKey}${subKey}`;
  // 按打乱表逐位取值拼接（每个索引都判空，满足严格模式下的类型安全）
  let mixed = '';
  for (const index of MIXIN_KEY_ENC_TAB) {
    mixed += source[index] ?? '';
  }
  // 官方只取前 32 位作为最终密钥
  return mixed.slice(0, 32);
}

/**
 * 对单个参数值做 URL 编码（先过滤特殊字符，再编码）。
 * @param value 参数值（数字会被转成字符串）
 */
function encodeValue(value: string | number): string {
  // 注意顺序：先 replace 过滤，再 encodeURIComponent，顺序反过来结果就不一样
  return encodeURIComponent(String(value).replace(CHR_FILTER, ''));
}

/**
 * 生成带 WBI 签名的完整 query string。
 * @param params 业务参数（不要自己塞 wts 和 w_rid，函数会处理）
 * @param mixinKey getMixinKey() 的结果
 * @param nowSec 当前秒级时间戳；之所以开放成参数，是为了将来能写单元测试
 * @returns 形如 "a=1&b=2&wts=1700000000&w_rid=abcdef..." 的查询串
 */
export function signParams(
  params: Record<string, string | number>,
  mixinKey: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  // 把时间戳合并进参数表（官方 JS 也是先加 wts 再排序的，顺序影响签名结果）
  const withTimestamp: Record<string, string | number> = { ...params, wts: nowSec };

  // 1) key 按字母序升序排序  2) key 做 URL 编码  3) 值做过滤+编码  4) 用 & 拼接
  const query = Object.keys(withTimestamp)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeValue(withTimestamp[key] ?? '')}`)
    .join('&');

  // w_rid = md5(排序后的 query + mixin_key)
  const wRid = createHash('md5').update(query + mixinKey).digest('hex');

  // 最终把签名值拼到 query 末尾
  return `${query}&w_rid=${wRid}`;
}
