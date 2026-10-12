# ex_mall · 评论区价格信息采集系统

> **当前阶段：已完成双流评论采集、可审计对话组装，以及价格抽取的 LLM 契约与程序验证器。**
>
> 安全边界：评论中的价格只能作为历史报告或未核验线索；未经外部核验，不能标为“当前可实现低价”。

---

## 一、这个版本有什么特点

| 特点 | 说明 |
|---|---|
| **零运行时依赖** | 只用 Node 内置模块：`fetch`（HTTP）、`node:sqlite`（数据库）、`node:crypto`（MD5 签名）、`node:util`（参数解析）。**不需要 `npm install` 就能跑** |
| **零构建** | Node ≥ 24 原生支持直接执行 `.ts` 文件（类型擦除），`node src/crawl.ts` 即可，没有 webpack/tsc 构建步骤 |
| **数据库零安装** | 用 SQLite 单文件，任何 SQL 工具都能直接打开 |
| **反爬逻辑已收拢** | WBI 签名、频率限制、重试退避、Cookie 管理全部封装在 `src/bilibili/` 下 |

---

## 二、环境要求

- **Node.js ≥ 24.0.0**（本机实测 v24.14.0，`process.features.typescript === "strip"` 即为支持）
- 可选：`npm install` 只为装 `typescript` + `@types/node`，用来获得编辑器类型提示和 `npm run typecheck`。**不装也不影响运行。**

检查环境：

```powershell
node -v          # 应输出 v24.x 或更高
```

---

## 三、目录结构

```
ex_mall/
├─ package.json          npm 脚本与（可选的）开发依赖
├─ tsconfig.json         TS 配置：只做类型检查，不产出 JS
├─ .env.example          环境变量模板（复制成 .env 后生效）
├─ .gitignore            忽略 node_modules / data / .env
├─ .editorconfig         跨编辑器统一编码（UTF-8）与缩进约定
├─ .vscode/settings.json 编辑器统一按 UTF-8 打开本项目文件
├─ README.md             本文件
├─ evals/                价格抽取人工评测种子（JSONL）
├─ tests/                对话、评论选择和抽取验证器测试
├─ data/                 运行时生成：bilibili.db + 导出的 jsonl（已 git 忽略）
├─ scripts/
│  └─ inspect-db.mjs     只读脚本：查看 .db 文件里到底存了什么（npx 或 node 直接跑）
└─ src/
   ├─ config.ts          配置集中管理，读 .env
   ├─ types.ts           所有类型定义（数据库行 + B站接口结构）
   ├─ db.ts              SQLite 建表 / 写入封装（videos、comments、crawl_logs）
   ├─ comment-selection.ts 热门/最新两条候选流的排序、限额与去重
   ├─ conversation.ts    组装稳定编号、回复关系和上下文完整性
   ├─ crawl.ts           【入口 1】抓取：视频信息 + 评论区 → 数据库
   ├─ query.ts           【入口 2】读取：查视频 / 查评论 / 正则搜索 / 导出
   ├─ extractor/         LLM Prompt、输出类型及证据/金额验证器
   └─ bilibili/
      ├─ wbi.ts          WBI 签名算法（B站反爬核心，单独隔离便于日后维护）
      ├─ client.ts       HTTP 客户端：限速 + Cookie + 签名 + 重试 + 错误分类
      └─ api.ts          业务接口：解析 BV 号 / 取视频信息 / 取主评论 / 取楼中楼
```

---

## 四、快速开始

### 1）抓取（默认会创建 `data/bilibili.db`）

```powershell
# 默认抓点赞较高的 50 条一级评论 + 时间最新的 30 条，按评论 id 去重
node src/crawl.ts --video BV1GJ411x7h7

# 顺带展开每条一级评论下的前 20 条楼中楼（价格方案常藏在问答里）
node src/crawl.ts --video BV1GJ411x7h7 --with-replies

# 也可以调整三组条数
node src/crawl.ts --video BV1GJ411x7h7 --hot-limit 60 --recent-limit 40 --with-replies --sub-limit 20

# 也可以直接粘视频链接，或用 b23.tv 短链
node src/crawl.ts --video "https://www.bilibili.com/video/BV1GJ411x7h7"
```

抓取完成后终端会自动打印「点赞最高的 10 条评论」，用来肉眼确认数据是否正常。

### 2）读取

```powershell
node src/query.ts videos                                      # 库里有那些视频
node src/query.ts comments --video BV1GJ411x7h7 --limit 20    # 看评论
node src/query.ts conversations --video BV1GJ411x7h7 --limit 5 # 组装评论对话和完整性状态
node src/query.ts comments --video BV1GJ411x7h7 --order time --root-only
node src/query.ts search   --video BV1GJ411x7h7 --regex "\d{3,6}"   # 找数字（价格抽取第一步）
node src/query.ts export   --video BV1GJ411x7h7 --out data/out.jsonl
node src/query.ts logs                                        # 抓取流水日志
```

### 3）使用豆包 Seed 分析评论

先在本地 `.env` 中填写：

```text
ARK_API_KEY=你的火山方舟API密钥
ARK_MODEL=doubao-seed-2-0-mini-260428
```

然后执行：

```powershell
npm run analyze -- --video BV1GJ411x7h7 --limit 10
```

结果默认写入 `data/<BV号>-price-analysis.jsonl`。每行对应一个一级评论对话，包含模型、Token 用量、结构化价格和基础校验结果。

如果只知道商品名称，可以一条命令自动搜索相关视频、抓取评论并分析：

```powershell
npm run research -- --product "RTX 5070 Ti"
```

只会选择播放量不少于 5000 且商品与输入一致的视频。例如搜索 `MacBook Neo` 时排除 `MacBook Neo 2`；搜索 `iPhone 17` 时排除充电器、手机壳以及 `Pro / Pro Max / Plus` 等其他版本。默认处理 3 个视频，每个视频最多分析 10 个包含价格信号的评论对话，结果写入 `data/RTX-5070-Ti-research.jsonl`。
命令结束时会直接在终端打印价格、渠道、优惠条件和证据摘要；JSONL 保留完整结构化结果。

### 4）用 npm 脚本跑（等价写法）

```powershell
npm run crawl -- --video BV1GJ411x7h7 --with-replies
npm run query -- comments --video BV1GJ411x7h7
npm run analyze -- --video BV1GJ411x7h7 --limit 10
npm run research -- --product "RTX 5070 Ti"
npm run check:auth     # 自检 B站登录态（SESSDATA）是否有效
npm run db:info        # 查看 .db 文件里到底存了什么
npm test               # Node 原生测试：对话关系与上下文完整性
npm run typecheck      # tsc --noEmit，验证类型正确
```

---

## 五、⚠️ 必须先配置 SESSDATA（实测结论）

这是**最重要的一条**，本项目已实测验证：

| 状态 | 结果 |
|---|---|
| **未登录**（无 SESSDATA） | 无论用哪个接口，主评论**只返回 3 条**就 `is_end=true`（即便 `all_count` 显示有 236939 条）。**换任何 Cookie 组合（buvid3 / buvid4 / b_nut / b_lsid / _uuid）都无法突破** |
| **未登录**时抓楼中楼 | 可以正常翻页（实测 3 条一级评论扩展出 60 条楼中楼） |
| **不带 WBI 签名**请求 | 直接 `code = -403`（证明本项目的签名实现是必需的且有效的） |

**原因**：这是 B站的产品策略（浏览器里未登录时也会显示「登录后查看更多评论」），不是可以绕过的反爬措施。

**解决办法**：

1. 把 `.env.example` 复制为 `.env`
2. 浏览器登录 B站 → `F12` → Application → Cookies → `https://www.bilibili.com` → 复制 `SESSDATA` 的值
3. 填进 `.env`（**只复制值本身**，不要带 `SESSDATA=` 前缀，也不要加引号）：

```
BILI_SESSDATA=你复制到的值
```

4. 验证是否生效：

```powershell
npm run check:auth
```

### ⚠️ SESSDATA 会过期

它是**有有效期的会话凭证**——长时间不登录、在别的设备退出登录、改过密码，都会让它失效。
失效后接口返回 `-101 未登录`，抓取会退回到「只有 3 条」。

用 `npm run check:auth` 判断：

| 输出 | 含义 | 处理 |
|---|---|---|
| `🎉 结论：登录态有效` | 正常 | 无需处理 |
| `❌ 结论：B站没有认可这个 SESSDATA` | 会话失效或复制不完整 | 重新登录 B站，重新复制一次 |

程序在检测到「只抓到很少评论」时，会区分「没配 SESSDATA」和「配了但已失效」两种情况，给出对应提示。

---

## 六、数据库表结构

### `videos` —— 视频元信息（一个视频一行）

| 列 | 说明 |
|---|---|
| `bvid` | BV 号，主键 |
| `aid` | av 号，评论接口的 `oid` 参数就是它 |
| `title` / `up_name` / `up_mid` | 标题 / UP主昵称 / UP主 uid |
| `pubdate` / `duration` | 发布时间 / 时长（秒） |
| `view_count` / `danmaku_cnt` / `reply_count` | 播放 / 弹幕 / 评论总数 |
| `like_count` / `coin_count` / `fav_count` | 点赞 / 投币 / 收藏 |
| `description` / `url` | 简介 / 视频地址 |
| `crawled_at` | 本行最后写入时间 |

### `comments` —— 评论（一级评论 + 楼中楼共用一张表）

| 列 | 说明 |
|---|---|
| `rpid` | 评论 id，**主键，用 TEXT 存**（B站 id 可能超过 JS 安全整数，存成字符串避免精度丢失） |
| `bvid` / `oid` | 所属视频 / 评论区归属 id |
| `parent` / `root` | 父评论 id / 根评论 id（一级评论都是 `'0'`） |
| `is_root` | `1` = 一级评论，`0` = 楼中楼 |
| `uname` | 评论者昵称（**只存公开昵称，不存 uid**，降低合规风险） |
| `content` | 评论正文 —— **后续价格抽取的输入** |
| `like_count` / `ctime` / `location` | 点赞数 / 评论时间 / IP 归属地 |
| `sub_count` | 该评论下有多少条回复 |
| `sub_fetched_count` | 已抓到的楼中楼数量；`NULL` 表示未展开或历史数据未知 |
| `sub_context_complete` | `1` 已抓完、`0` 达到上限而截断、`NULL` 未核实 |
| `raw` | B站原始 JSON，保留下来以后可重新解析，不必重新抓 |
| `crawled_at` | 抓取时间 |

索引：`bvid`、`ctime`、`root`。

### `crawl_logs` —— 抓取流水

每次抓取写一行：`bvid`、`started_at`、`finished_at`、`pages`、`saved`、`status`（running/success/failed）、`error`。

### 用任意 SQL 工具查看（例如 DB Browser for SQLite 或命令行）

```sql
-- 看看库里有哪些视频、各抓了多少条评论
SELECT v.bvid, v.title, COUNT(c.rpid) AS cnt
  FROM videos v LEFT JOIN comments c ON c.bvid = v.bvid
 GROUP BY v.bvid;

-- 找含有「元/块/券/会员」的评论（价格抽取的雏形）
SELECT uname, like_count, content
  FROM comments
 WHERE content LIKE '%券%' OR content LIKE '%会员%' OR content LIKE '%元%'
 ORDER BY like_count DESC LIMIT 20;
```

---

## 七、命令行参数速查

### `crawl.ts`

| 参数 | 默认 | 说明 |
|---|---|---|
| `--video` | 必填 | BV 号 / 视频链接 / b23.tv 短链 |
| `--hot-limit` | 50 | 按点赞数选择多少条热门一级评论 |
| `--recent-limit` | 30 | 按发布时间选择多少条最新一级评论 |
| `--with-replies` | 关闭 | 是否展开楼中楼 |
| `--sub-limit` | 20 | 每条一级评论下只保留前多少条楼中楼；超过后标记为截断 |
| `--db` | `data/bilibili.db` | 数据库文件路径 |

### `query.ts`

| 子命令 | 说明 |
|---|---|
| `videos` | 列出库中视频及已入库评论数 |
| `comments --video X [--limit N] [--order like\|time] [--root-only]` | 列出评论 |
| `conversations --video X [--limit N] [--out path.jsonl]` | 组装带稳定编号、时间、回复关系和完整性状态的对话 |
| `search --video X --regex P [--limit N]` | 正则搜索（价格抽取第一步） |
| `export --video X [--out path.jsonl]` | 导出 JSONL，便于其他语言消费 |
| `logs [--limit N]` | 查看抓取流水 |

---

## 八、反爬与稳定性设计说明

| 机制 | 位置 | 说明 |
|---|---|---|
| **WBI 签名** | `src/bilibili/wbi.ts` | 参数排序 → 过滤 `!'()*` → URL 编码 → `md5(query + mixin_key)`。B站改算法时只需改这一个文件 |
| **设备指纹** | `client.ts` → `ensureBuvid()` | 自动调 `finger/spi` 申领 `buvid3`/`buvid4`，避免 `-352` |
| **密钥缓存** | `client.ts` → `ensureMixinKey()` | `nav` 接口拿 `wbi_img`，缓存 10 分钟；遇到 `-403` 自动清缓存重试 |
| **限速 + 抖动** | `client.ts` → `throttle()` | 相邻请求间隔 ≥ `BILI_REQUEST_INTERVAL_MS`，再叠加 0~40% 随机抖动，避免固定节奏 |
| **重试与退避** | `client.ts` → `request()` | `-412/-509/-352` 退避重试（2s/4s/6s）；网络错误 1s/2s/3s；`-403` 换密钥重试；`-404` 直接失败不重试 |
| **大整数保护** | `client.ts` → `parseJsonPreservingBigInt()` | 16 位以上数字先加引号再 parse，防止评论 id 精度丢失 |
| **幂等写入** | `db.ts` | 全部用 `INSERT ... ON CONFLICT DO UPDATE`，任务可以随便重跑，不会产生重复数据 |
| **事务批写** | `db.ts` → `insertComments()` | 一页评论一个事务，比逐条提交快几十倍，失败整体回滚 |
| **WAL 模式** | `db.ts` → `openDb()` | 边抓边查不会互相阻塞 |

---

## 九、常见错误码排查

| 错误码 | 含义 | 处理 |
|---|---|---|
| `-403` | 签名错误 / 权限不足 | 程序会自动换密钥重试；若持续出现说明 B站改了签名算法，改 `wbi.ts` |
| `-412` | 触发风控被拦截 | 调大 `BILI_REQUEST_INTERVAL_MS`、配置 `SESSDATA`、隔一段时间再跑 |
| `-509` | 请求过于频繁 | 同上 |
| `-352` | 风控校验失败（缺 buvid3） | 程序会自动申领；若仍失败可手动在 `.env` 填 `BILI_BUVID3` |
| `-404` | 视频不存在 | 检查 BV 号；视频可能已删除或设为私密 |
| `-400` | 请求参数错误 | 检查 BV 号是否正确；若它发生在**翻第 2 页**时，是翻页参数用错——本接口翻页只能用 `next`，传 `pagination_str` 必定 -400（本项目已修复，详见 `api.ts` 注释） |
| 只抓到 3 条 | 未登录限制 | 见第五节：先跑 `npm run check:auth` 判断是「没配 SESSDATA」还是「配了但已失效（含被粘贴两遍）」，再对症处理 |

---

## 十、合规提醒

- 本项目**只抓取公开的评论内容**，不做批量爬站、不绕过登录限制、不采集用户身份信息（`comments` 表只存公开昵称，不存 uid）。
- 请遵守 B站用户协议与 `robots.txt`，把请求频率控制在合理范围（默认 1.2 秒/次已经很保守）。
- 抓下来的数据请仅用于个人比价参考，不要二次分发原始评论全文；对外展示时应给出原视频链接。

---

## 十一、下一步（后续阶段规划）

| 阶段 | 内容 |
|---|---|
| ✅ **当前** | 抓评论 → 存 SQLite → 对话组装 → 豆包 Seed 抽取 → 证据与金额程序验证 → JSONL 结果 |
| 下一步 | 根据实际抽取效果调整 Prompt，并筛选更可能包含价格的候选对话以节省 Token |
| 之后 | 商品对齐（4070ti / 4070 Ti 归一）、置信度打分、时效衰减、跨视频交叉验证 |
| 之后 | 关键词订阅 + 定时调度（BullMQ）+ 告警推送 |
| 之后 | 前端价格卡片：`官方价 1999 / 可实现低价 1799 / 方案：京东PLUS + 10点抢券 / 证据链接` |

---

## 十二、价格抽取契约与安全边界

第二阶段基础代码位于 `src/extractor/`：

| 文件 | 职责 |
|---|---|
| `types.ts` | 定义商品、页面价、报告成交价、额外费用、购买条件、证据和核验状态 |
| `prompt.ts` | 把一个可审计对话组装为供应商无关的 LLM system/user Prompt |
| `validator.ts` | 不信任模型输出，验证 JSON 结构、证据原文、金额计算和核验状态 |
| `evals/price-cases.jsonl` | 人工评测种子：历史价、玩笑、型号混淆、会员成本、运费和上下文缺失 |

核心规则：

1. 缺失信息只能写 `null` 或 `[]`，不能用常识补全。
2. `pagePrice`（页面价）、`reportedPaidPrice`（评论报告成交价）和 `totalCost`（含必需额外费用）必须分开。
3. 证据编号必须存在，引用内容必须逐字出现在对应评论中。
4. `totalCost = reportedPaidPrice + extraCostTotal`，额外费用合计还要与费用明细一致。
5. 存在金额未知的必需会员费/运费时，不能编造 `extraCostTotal` 或 `totalCost`。
6. 评论成交价默认只能标成 `historical_report` 或 `unverified`；**仅凭评论永远不能标成 `currently_verified`**。
7. 楼中楼默认只保留前 20 条；超过时对话为 `truncated`，历史报告需要人工复核。
