/**
 * client.ts —— B站 HTTP 客户端（零依赖）
 *
 * 【职责】所有对 B站的网络请求都必须经过这里，一个请求要依次过 5 道关卡：
 *   1. 频率限制：保证两次请求之间至少间隔 N 毫秒，并叠加随机抖动（避免固定节奏被识别为脚本）
 *   2. 设备指纹：自动向 B站申领 buvid3 / buvid4 并放进 Cookie（缺少它会触发 -352 风控）
 *   3. WBI 签名：给参数附上 w_rid + wts（依赖同目录的 wbi.ts），并缓存密钥
 *   4. 请求发送：带上浏览器同款 UA / Referer / Cookie，并设置超时
 *   5. 错误分类与重试：区分「等一会儿就能好的风控错误」和「重试也没用的业务错误」
 */

// 从同目录的 wbi.ts 引入签名相关的三个纯函数
import { getMixinKey, pickKeyFromUrl, signParams } from './wbi.ts';
// 只做类型引用，用 import type 保证运行时不会真的加载这个模块
import type { BiliEnvelope } from '../types.ts';

/**
 * 出现这些错误码时值得重试（都属于风控/限流类，退避一段时间后可能就恢复了）：
 *   -352 风控校验失败   -412 请求被拦截   -509 请求过于频繁
 */
const RETRYABLE_CODES = new Set<number>([-352, -412, -509]);

/** B站常见错误码 → 中文解释，方便看日志时快速定位问题 */
const CODE_HINTS: Record<string, string> = {
  '-101': '账号未登录，该接口需要登录态，请在 .env 中配置 BILI_SESSDATA',
  '-352': '风控校验失败，通常是缺少 buvid3 Cookie（本程序会尝试自动申领）',
  '-400': '请求参数错误，请检查 BV 号是否正确（也可能视频已失效）',
  '-403': '权限不足或 WBI 签名校验失败（B站签名算法可能已变更）',
  '-404': '请求的资源不存在（视频可能已被删除或设为私密）',
  '-412': '请求被拦截，已触发风控。建议：降低频率、换网络、配置 SESSDATA',
  '-509': '请求过于频繁，已被限流',
};

/** 内部接口：B站申领设备指纹的接口（无需登录、无需签名） */
const SPI_API = 'https://api.bilibili.com/x/frontend/finger/spi';
/** 内部接口：获取 WBI 密钥的接口（未登录也会返回 wbi_img 字段） */
const NAV_API = 'https://api.bilibili.com/x/web-interface/nav';

/** 自定义错误类型：把「B站业务错误」和「网络层错误」区分开，便于上层判断 */
export class BiliApiError extends Error {
  /** B站返回的业务错误码（如 -412） */
  code: number;
  /** 出错时的接口地址，便于排查 */
  api: string;

  /**
   * 手动在构造函数里赋值（而不是用 TS 的「参数属性」语法把修饰符写在参数上），
   * 因为参数属性属于「不可擦除语法」，Node 的原生 TS 运行方式不支持。
   */
  constructor(code: number, message: string, api: string) {
    super(message);
    this.name = 'BiliApiError';
    this.code = code;
    this.api = api;
  }
}

/** 创建客户端时可传入的配置（全部可选，缺省值见下方 createBiliClient） */
export interface BiliClientOptions {
  /** B站登录态的 SESSDATA，配置后能翻更多页评论 */
  sessdata?: string;
  /** 设备指纹 buvid3，留空则自动申领 */
  buvid3?: string;
  /** 两次请求之间的最小间隔（毫秒） */
  requestIntervalMs?: number;
  /** 失败后的额外重试次数 */
  maxRetries?: number;
  /** 请求头里的 User-Agent */
  userAgent?: string;
}

/** 单次请求的行为开关 */
export interface BiliRequestOptions {
  /** 是否需要 WBI 签名，默认 true（B站绝大多数 web 接口都需要） */
  signed?: boolean;
  /** 本次请求的重试次数，不传则用客户端配置 */
  retries?: number;
  /** Referer，评论接口建议带上对应视频页地址，更贴近真实浏览器行为 */
  referer?: string;
}

/** 对外暴露的客户端能力 */
export interface BiliClient {
  /**
   * 发起一次带签名、带限速、带重试的请求
   * @param url 完整接口地址（不带 query）
   * @param params 业务参数
   * @param options 行为开关
   * @returns 接口响应里的 data 字段
   */
  request<T>(
    url: string,
    params: Record<string, string | number>,
    options?: BiliRequestOptions,
  ): Promise<T>;
  /** 返回当前 Cookie 的摘要（只打印有哪些字段，不泄露值），用于日志确认登录态是否生效 */
  cookieSummary(): string;
}

/**
 * 把 JSON 文本里「超长数字」提前加上引号，避免精度丢失。
 *
 * 【为什么需要】B站的 rpid（评论 id）等字段可能超过 JS 安全整数上限 2^53-1，
 * 直接 JSON.parse 会让末位数字变成 0，导致评论 id 对不上、无法去重。
 * 所以 16 位及以上的数字一律先转成字符串再解析，这样就不会丢精度。
 */
function parseJsonPreservingBigInt(text: string): unknown {
  // 匹配形如 "rpid":1234567890123456 的字段，只处理 16 位及以上的数字
  const patched = text.replace(/"(\w+)":(\d{16,})/g, '"$1":"$2"');
  // JSON.parse 的返回值是 any，这里显式断言为 unknown，交给调用方按需断言
  return JSON.parse(patched) as unknown;
}

/** 把参数对象拼成 query string（用于不需要签名的接口） */
function buildQuery(url: string, params: Record<string, string | number>): string {
  // URLSearchParams 会按标准做 URL 编码
  const query = new URLSearchParams(
    // 显式断言成 [string, string] 元组，否则 TS 会推断成 string[][]，与 URLSearchParams 的入参类型不匹配
    Object.entries(params).map(([key, value]) => [key, String(value)] as [string, string]),
  ).toString();
  // 没有参数就返回原地址，避免出现多余的 "?"
  return query ? `${url}?${query}` : url;
}

/**
 * 创建 B站客户端。
 * 这里用「闭包 + 函数」而不是 class，是为了让内部状态（Cookie、密钥缓存、上一次请求时间）
 * 变成真正的外部不可见的私有变量，避免被误改。
 */
export function createBiliClient(options: BiliClientOptions = {}): BiliClient {
  // ——— 一、把配置落到局部常量（带默认值） ———
  const intervalMs = options.requestIntervalMs ?? 1200; // 默认最小间隔 1.2 秒
  const maxRetries = options.maxRetries ?? 3; // 默认额外重试 3 次
  const userAgent =
    options.userAgent ??
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  // ——— 二、Cookie 用对象维护，发送时再拼成 "k1=v1; k2=v2" ———
  const cookies: Record<string, string> = {};
  if (options.sessdata) cookies['SESSDATA'] = options.sessdata; // 登录态（配置了才有）
  if (options.buvid3) cookies['buvid3'] = options.buvid3; // 设备指纹（配置了才有）

  // ——— 三、闭包内的私有状态 ———
  let lastRequestAt = 0; // 上一次真正发出请求的时间戳，用于节流计算
  let buvidChecked = false; // 是否已经检查/申领过 buvid3，避免重复调用申领接口
  let mixinKey: string | null = null; // 缓存的 WBI mixin_key
  let mixinKeyExpireAt = 0; // mixin_key 的过期时间戳（B站每天轮换，这里缓存 10 分钟足够）

  /** 等待指定毫秒（把回调式 setTimeout 包装成 Promise，方便 await） */
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  /**
   * 节流：让相邻两次请求的间隔不小于 intervalMs。
   * 额外叠加 0~40% 的随机抖动，避免固定间隔被风控系统识别成脚本行为。
   */
  async function throttle(): Promise<void> {
    // 距离上一次请求已经过去了多久
    const elapsed = Date.now() - lastRequestAt;
    // 随机抖动时长
    const jitter = Math.floor(Math.random() * intervalMs * 0.4);
    // 本次还需要补等多久 = 标准间隔 + 抖动 - 已过去的时间
    const waitMs = intervalMs + jitter - elapsed;
    // 只有确实需要等才等
    if (waitMs > 0) await sleep(waitMs);
    // 记录本次请求时刻，供下一次计算使用
    lastRequestAt = Date.now();
  }

  /** 把 Cookie 对象拼成请求头需要的字符串 */
  function cookieHeader(): string {
    return Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }

  /**
   * 底层请求：只负责「带好请求头发出去 + 解析成 JSON」，
   * 不含签名、不含重试，仅供本文件内部使用。
   * @param url 已经拼好 query 的完整地址
   * @param referer 请求头 Referer 的值
   */
  async function rawFetch(url: string, referer: string): Promise<unknown> {
    // 组装成一个浏览器会发的请求头（B站会检查这几个字段）
    const headers: Record<string, string> = {
      'User-Agent': userAgent, // 伪装成 Chrome
      Referer: referer, // 来源页，评论接口用视频页地址最自然
      Origin: 'https://www.bilibili.com', // 跨域来源
      Accept: 'application/json, text/plain, */*', // 期望返回 JSON
      'Accept-Language': 'zh-CN,zh;q=0.9', // 中文优先
      'Sec-Fetch-Site': 'same-site', // 补充的浏览器行为指纹
    };
    // 有 Cookie 才设置这个头，避免出现空的 Cookie 头
    const cookie = cookieHeader();
    if (cookie) headers['Cookie'] = cookie;

    // 发出请求；AbortSignal.timeout 保证 20 秒没响应就主动断开，避免进程卡死
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    // HTTP 层错误直接抛异常（会被上层当作可重试错误处理）
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} <- ${url}`);
    }
    // 读文本 → 大整数保护 → 解析为对象
    return parseJsonPreservingBigInt(await response.text());
  }

  /**
   * 确保 Cookie 里有 buvid3。
   * buvid3 是 B站的匿名设备指纹，没有它调评论接口大概率返回 -352 风控错误。
   */
  async function ensureBuvid(): Promise<void> {
    // 已经处理过就不再处理（无论成功与否，避免每次请求都去申领）
    if (buvidChecked) return;
    buvidChecked = true;
    // 用户在 .env 里配置了就尊重用户的配置
    if (cookies['buvid3']) return;
    try {
      // 调申领接口，拿到 b_3（buvid3）和 b_4（buvid4）
      const body = (await rawFetch(SPI_API, 'https://www.bilibili.com/')) as {
        code?: number;
        data?: { b_3?: string; b_4?: string };
      };
      // 成功则写进 Cookie 表
      if (body.code === 0 && body.data?.b_3) {
        cookies['buvid3'] = body.data.b_3;
        if (body.data.b_4) cookies['buvid4'] = body.data.b_4;
      }
    } catch {
      // 申领失败不致命：继续发请求，只是更容易被风控；这里静默忽略
    }
  }

  /**
   * 确保拿到 WBI mixin_key。
   * 密钥来自 nav 接口里的 wbi_img 字段（未登录也会返回），拿到后缓存 10 分钟。
   */
  async function ensureMixinKey(): Promise<string> {
    // 缓存还有效就直接返回，避免每个请求都去要一次密钥
    if (mixinKey !== null && Date.now() < mixinKeyExpireAt) return mixinKey;
    // 请求 nav 接口
    const body = (await rawFetch(NAV_API, 'https://www.bilibili.com/')) as {
      data?: { wbi_img?: { img_url: string; sub_url: string } };
    };
    const wbiImg = body.data?.wbi_img;
    // 拿不到密钥就没法签名，直接抛错（上层会按网络错误重试）
    if (!wbiImg?.img_url || !wbiImg.sub_url) {
      throw new Error('无法获取 WBI 密钥：nav 接口没有返回 wbi_img 字段');
    }
    // 从两个 URL 里各取出 key，算成 mixin_key 后缓存起来
    mixinKey = getMixinKey(pickKeyFromUrl(wbiImg.img_url), pickKeyFromUrl(wbiImg.sub_url));
    mixinKeyExpireAt = Date.now() + 10 * 60 * 1000;
    return mixinKey;
  }

  /**
   * 对外唯一主入口：带签名 + 限速 + 重试的请求。
   * @param url 接口地址（不带 query）
   * @param params 业务参数
   * @param requestOptions 行为开关
   */
  async function request<T>(
    url: string,
    params: Record<string, string | number>,
    requestOptions: BiliRequestOptions = {},
  ): Promise<T> {
    // 默认需要签名（B站 web 接口基本都要）
    const signed = requestOptions.signed ?? true;
    // 重试次数，未指定则用客户端默认值
    const retries = requestOptions.retries ?? maxRetries;
    // Referer 默认 B站首页；评论类接口由调用方传视频页地址
    const referer = requestOptions.referer ?? 'https://www.bilibili.com/';

    // 发请求前先确保拿到了设备指纹
    await ensureBuvid();

    // 记录最后一次的错误，循环结束后抛给调用方
    let lastError: unknown = null;

    // attempt 从 0 开始，最多执行 retries + 1 次（首次 + 若干次重试）
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        // 第 1 关：限速 + 抖动
        await throttle();

        // 第 2 关：拼 URL —— 需要签名走 signParams，不需要签名走普通 query 拼接
        const fullUrl = signed
          ? `${url}?${signParams(params, await ensureMixinKey())}`
          : buildQuery(url, params);

        // 第 3 关：真正发请求，返回 { code, message, data } 信封
        const body = (await rawFetch(fullUrl, referer)) as BiliEnvelope<T>;

        // 业务成功：直接把 data 交出去，函数到此结束
        if (body.code === 0) return body.data;

        // ——— 以下是业务失败的各种分支 ———

        // 签名/权限错误：可能是密钥轮换导致缓存过期，清掉缓存后重试
        if (body.code === -403 && attempt < retries) {
          mixinKey = null; // 丢弃旧密钥
          mixinKeyExpireAt = 0; // 让下次 ensureMixinKey 重新拉取
          lastError = new BiliApiError(body.code, `${body.message}（将重新获取 WBI 密钥后重试）`, url);
          continue; // 进入下一轮循环
        }

        // 风控/限流类错误：退避等待后重试（等待时间随重试次数递增）
        if (RETRYABLE_CODES.has(body.code) && attempt < retries) {
          lastError = new BiliApiError(
            body.code,
            `${body.message}｜${CODE_HINTS[String(body.code)] ?? ''}`,
            url,
          );
          // 等待 2s、4s、6s…… 再叠加一点随机抖动
          await sleep(2000 * (attempt + 1) + Math.floor(Math.random() * 500));
          continue;
        }

        // 其他错误码（如 -404 视频不存在）：重试没有意义，直接抛出
        throw new BiliApiError(
          body.code,
          `${body.code} ${body.message}｜${CODE_HINTS[String(body.code)] ?? '未知错误'}`,
          url,
        );
      } catch (error) {
        // 已经是 BiliApiError（业务错误）就原样抛出，不做重复包装
        if (error instanceof BiliApiError) throw error;

        // 网络层错误（超时 / DNS 解析失败 / 连接中断）也值得重试
        lastError = error;
        if (attempt === retries) break; // 次数用完了，跳出循环
        await sleep(1000 * (attempt + 1)); // 1s、2s、3s 线性退避
      }
    }

    // 走到这里说明重试全部失败，把最后一次的错误抛出去
    throw lastError instanceof Error ? lastError : new Error(`请求失败：${url}`);
  }

  /** 返回 Cookie 摘要（只显示字段名，不显示值），用于日志确认登录态是否生效 */
  function cookieSummary(): string {
    const keys = Object.keys(cookies);
    return keys.length ? keys.join(', ') : '（空）';
  }

  // 返回对外可用的接口对象
  return { request, cookieSummary };
}
