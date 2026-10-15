# 评论区查价系统

输入商品名称，搜索相关 B 站视频，采集评论与回复，利用豆包 Seed 提取价格、购买渠道及优惠条件，并输出 JSONL 和 CSV。也可以按 BV 号单独抓取、查看已保存的评论。

> 评论价格来自用户自述，仅供参考；不代表订单已核实或商品目前仍能以该价格购买。

## 运行环境

- Node.js 24 或更高版本。项目直接运行 TypeScript 文件，无须构建；运行时仅使用 Node.js 内置模块。
- 价格分析需要火山方舟 API Key；建议提供有效的 B 站 `SESSDATA`，否则可能只能读取少量评论。
- 以下命令在**项目根目录**执行，示例使用 PowerShell。`data/` 中的数据库、分析结果和缓存均为运行时文件，不上传到 Git。

## 配置

```powershell
Copy-Item .env.example .env
```

编辑项目根目录的 `.env`：

```text
ARK_API_KEY=你的火山方舟API密钥
BILI_SESSDATA=你的B站SESSDATA值
```

`ARK_MODEL` 可保留 `.env.example` 提供的默认配置。`SESSDATA` 只填 Cookie 的值，不要带 `SESSDATA=` 前缀；凭证和 API Key 不要提交到仓库。可运行 `npm run check:auth` 检查 B 站登录态。

## 按商品名称查询价格（推荐）

```powershell
node src/research.ts --product "RTX 5070 Ti"
```

程序会搜索与商品匹配且播放量不少于 5000 的视频，采集热门、最新评论与回复，筛选价格候选并分析。默认处理 3 个视频、每个视频最多分析 10 个候选；模型分析默认最多 3 路并发，B 站请求仍受限速控制。命令完成后在终端显示购买方案摘要及结果文件路径。

以示例商品为例，**默认保存在项目根目录的 `data/` 下**：

| 文件 | 内容 |
|---|---|
| `data/RTX-5070-Ti-research.csv` | 只包含同时有明确金额与具体购买方案的摘要；UTF-8 BOM 编码，Excel 可打开；无符合记录时仍保留表头 |
| `data/RTX-5070-Ti-research.jsonl` | 所有候选对话的完整结构化分析与校验结果，包括没有进入 CSV 的记录 |
| `data/bilibili.db` | 视频、评论、回复及抓取记录 |
| `data/research-cache/` | 相同模型和完整输入下已校验通过的分析缓存 |

CSV **默认不会保存到下载文件夹**，而是保存在你克隆的项目目录下的 `data/RTX-5070-Ti-research.csv`；运行结束后终端也会打印实际绝对路径。

自定义输出路径和分析范围：

```powershell
# CSV 单独指定保存位置
node src/research.ts --product "RTX 5070 Ti" --csv "C:\Users\你的用户名\Downloads\查价摘要.csv"

# 省略 --csv 时，CSV 与 JSONL 同名同目录，仅扩展名不同（此例为 data/结果.csv）
node src/research.ts --product "RTX 5070 Ti" --out data/结果.jsonl

# 每个视频最多分析 6 个候选、模型同时运行 3 个请求
node src/research.ts --product "RTX 5070 Ti" --conversation-limit 6 --llm-concurrency 3

# 强制重新分析，不读取此前的成功缓存（会产生新的模型调用）
node src/research.ts --product "RTX 5070 Ti" --no-cache
```

`--conversation-limit` 调低可能遗漏线索；增大并发可能触发模型服务的限流。查看全部参数：`node src/research.ts --help`。首次查询会发起 B 站请求和可能计费的模型调用；CSV 只展示满足摘要条件的记录，不保证一定有价格行。

## 按 BV 号抓取、查看和分析

```powershell
# 抓取视频评论并存入 data/bilibili.db；展开楼中楼可获取更多购买方案上下文
node src/crawl.ts --video BV1GJ411x7h7 --with-replies

# 查看已经入库的视频、评论与对话
node src/query.ts videos
node src/query.ts comments --video BV1GJ411x7h7 --limit 20
node src/query.ts conversations --video BV1GJ411x7h7 --limit 5

# 在已入库评论中按正则查找数字
node src/query.ts search --video BV1GJ411x7h7 --regex "\d{3,6}"

# 使用豆包 Seed 分析已入库的视频评论
node src/analyze.ts --video BV1GJ411x7h7 --limit 10
```

单视频分析默认写入 `data/<BV号>-price-analysis.jsonl`，**不生成商品查询摘要 CSV**；`query.ts` 只读取已有数据。完整抓取、查询选项分别见 `node src/crawl.ts --help` 和 `node src/query.ts --help`。

## 常见问题

- **只拿到少量评论：** 检查 `.env` 中的 `BILI_SESSDATA` 是否有效，运行 `npm run check:auth`；登录态过期后需要重新获取。
- **没有价格摘要：** CSV 有表头但没有价格行时，先看同名 JSONL 的完整分析记录；可适当提高候选数量，但评论不保证存在可用方案。
- **接口限流或失败：** 保持合理的抓取间隔，稍后重试；请遵守平台规则，勿大规模抓取或公开分发原始评论。

仅凭评论不能核实真实订单、当前库存或当前可购买价格；外部展示应注明原视频及评论来源。