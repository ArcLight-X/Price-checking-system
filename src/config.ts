/**
 * config.ts —— 全局配置集中管理
 *
 * 设计要点：
 * 1) 零依赖：不装 dotenv，直接用 Node 内置的 process.loadEnvFile() 读 .env 文件
 * 2) 每一行配置都有默认值，保证「什么都不配也能直接跑起来」
 * 3) 数据库路径等参数可被环境变量覆盖，方便以后接入定时调度
 */

// 引入 Node 内置的 path 模块：用于跨平台拼接路径（Windows 用 \，Linux 用 /）
import path from 'node:path';
// 引入 Node 内置的 fileURLToPath：把 import.meta.url（file:// 协议）转成真实文件路径
import { fileURLToPath } from 'node:url';

// 当前这个文件的绝对路径，例如 D:\Programme Projects\GO Project\ex_mall\src\config.ts
const thisFilePath = fileURLToPath(import.meta.url);
// 当前这个文件所在的目录，例如 D:\Programme Projects\GO Project\ex_mall\src
const thisDir = path.dirname(thisFilePath);
// 项目根目录（即 src 的上一级）。所有相对路径都基于它解析，
// 这样无论你在哪个目录执行 node 命令，找文件的结果都一致
export const PROJECT_ROOT = path.resolve(thisDir, '..');

// 尝试加载项目根目录下的 .env 文件。
// loadEnvFile 在文件不存在时会直接抛异常，所以用 try/catch 静默忽略。
// 注意：已经存在的真实环境变量不会被覆盖，优先级：真实环境变量 > .env 文件 > 代码默认值
try {
  process.loadEnvFile(path.join(PROJECT_ROOT, '.env'));
} catch {
  // 没有 .env 文件属于完全正常的情况（所有配置走下面的默认值），这里什么都不做
}

/**
 * 把环境变量里的字符串安全地转成整数
 * @param raw 原始字符串（可能是 undefined）
 * @param fallback 解析失败时使用的默认值
 */
function readInt(raw: string | undefined, fallback: number): number {
  // parseInt 遇到非数字会返回 NaN，用 Number.isFinite 把它过滤掉
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 应用配置的数据结构（interface 只存在于类型层面，运行时会被 Node 的类型擦除删掉） */
export interface AppConfig {
  /** SQLite 数据库文件的绝对路径 */
  dbFile: string;
  /** B站登录态的 SESSDATA，空字符串表示未配置 */
  sessdata: string;
  /** 设备指纹 buvid3，空字符串表示未配置（程序会自动向 B站申领） */
  buvid3: string;
  /** 两次 HTTP 请求之间的最小间隔（毫秒），用来降低触发风控的概率 */
  requestIntervalMs: number;
  /** 单个请求失败后额外重试的次数 */
  maxRetries: number;
  /** 每页拉取的评论条数 */
  pageSize: number;
  /** 请求头里的 User-Agent，伪装成真实浏览器 */
  userAgent: string;
  /** 火山方舟 API Key，空字符串表示未配置 */
  arkApiKey: string;
  /** 火山方舟 API 基础地址 */
  arkBaseUrl: string;
  /** 豆包模型名 */
  arkModel: string;
}

/** 读取配置。每次调用都重新读一遍环境变量，方便测试时临时改值 */
export function loadConfig(): AppConfig {
  return {
    // 数据库文件：默认放在 <项目根>/data/bilibili.db；如果 .env 给了绝对路径也能正确解析
    dbFile: path.resolve(PROJECT_ROOT, process.env['BILI_DB_FILE'] ?? 'data/bilibili.db'),
    // B站登录态，配置后可以翻更多页评论
    sessdata: process.env['BILI_SESSDATA'] ?? '',
    // 设备指纹，留空时由 client.ts 自动申领
    buvid3: process.env['BILI_BUVID3'] ?? '',
    // 请求最小间隔，默认 1200ms（约每秒不到 1 次请求，比较保守）
    requestIntervalMs: readInt(process.env['BILI_REQUEST_INTERVAL_MS'], 1200),
    // 失败重试次数，默认 3 次
    maxRetries: readInt(process.env['BILI_MAX_RETRIES'], 3),
    // 每页评论条数，默认 20
    pageSize: readInt(process.env['BILI_PAGE_SIZE'], 20),
    // 用真实 Chrome 的 UA，避免被识别为脚本
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    arkApiKey: process.env['ARK_API_KEY'] ?? '',
    arkBaseUrl: process.env['ARK_BASE_URL'] ?? 'https://ark.cn-beijing.volces.com/api/v3',
    arkModel: process.env['ARK_MODEL'] ?? 'doubao-seed-2-0-mini-260428',
  };
}
