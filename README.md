# Scholar RSS：研究者与供应链论文，一条私有 Zotero 订阅源

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jiandwei/RSS)

把学者主页、期刊名单和检索接口集中维护在 **`sources.json`** 中，由 **Cloudflare Workers** 抓取、合并、去重，最终只提供 **一个 `/feed.xml`**。

追踪 Marc Melitz、David Autor、David Dorn、Nicholas Bloom、John Van Reenen、Peter Klenow，并加入 **UTD24、FT50、NBER、CEPR 中摘要提到供应链的论文**。所有条目都只保留滚动最近两个月，仍然只有一个订阅地址。无需 RSSHub、AI API 或浏览器服务器。

**所有读取接口均需要 `ACCESS_KEY`。没有设置密钥、密钥不符合要求或请求未授权时，服务不会读取 Durable Object、初始化数据库或抓取学者网站。**

## 一键部署（推荐）

点击上方 **Deploy to Cloudflare** 按钮，或[直接打开部署入口](https://deploy.workers.cloudflare.com/?url=https://github.com/jiandwei/RSS)。

1. 首次使用时登录 Cloudflare，并按官方页面提示授权 GitHub。
2. 选择目标账号、仓库名称和 Worker 名称，确认部署。按钮会复制本仓库到你的 GitHub 账号；如果账号内已有 `RSS`，为副本选择其他名称，例如 `rss-worker`。想直接持续部署当前仓库，请使用下文“方式 A”。
3. 在部署页面的 Secret 输入框中设置 **`ACCESS_KEY`**：使用随机的 32–128 位 URL 安全字符（字母、数字、`-`、`_`），推荐用 `openssl rand -hex 32` 在本地生成。不要使用示例值，不要提交到 GitHub。
4. 等待构建完成。Cloudflare 根据 `wrangler.jsonc` 自动配置 SQLite Durable Object 和 Cron，无需手动填写 namespace ID。若部署界面没有显示 Secret 输入框，在部署后的 Worker 设置 → Variables and Secrets 中添加 `ACCESS_KEY`，类型选 **Secret**，保存并部署。
5. 在 Cloudflare 给出的实际地址后加上 `/feed.xml?key=你的密钥`，将这**一个私有地址**添加到 Zotero。也可以访问 `/?key=你的密钥` 下载只包含一个源的私有 OPML。

`ACCESS_KEY` 是必须设置的 Worker Secret；`.dev.vars.example` 仅声明变量名，**不包含任何默认密钥**。`REFRESH_TOKEN` 是可选且独立的管理密钥，不能与读取密钥相同。Cloudflare 会检测 `package.json`，构建使用 `npm run build`，部署使用 `npm run deploy`；Node.js 版本由 `.node-version` 指定。

第一次通过鉴权获取 RSS 才会初始化数据。带密钥访问 `/status.json` 可检查每个页面的成功/失败状态；部署入口可用不代表学者网站一定允许 Cloudflare 出口访问。未配置密钥返回 503，密钥错误或缺失返回 401，默认关闭访问；Cron 在未正确配置密钥时也不会进行抓取。

## 论文范围与时间口径

| 范围 | 推送条件 | 元数据来源 |
|---|---|---|
| 六位学者主页 | 有可核验的近两个月发表日期，主题不限 | 原主页链接 + Crossref 题名和作者核验 |
| UTD24、FT50 | 属于配置中的期刊，近两个月发表，**摘要**命中供应链 | Crossref；OpenAlex 按 DOI 补摘要，为无近期 Crossref 记录的期刊补检 |
| NBER 工作论文 | 近两个月发表，摘要命中供应链 | Crossref 的 `10.3386` 前缀记录 + NBER 官方 RSS / OpenAlex 摘要 |
| CEPR Discussion Papers | 近两个月发表，摘要命中供应链 | CEPR 官方 Discussion Papers RSS，按页回溯 |

- “近两个月”按 **北京时间减去两个自然月，包含起止日**，不是固定 60 天。例如 2026-10-26 的窗口为 **2026-08-26 至 2026-10-26**。每次读取 RSS 都重新筛选，过期论文即使没有触发新抓取也会退出输出。
- 新增文献必须在摘要中命中 `supply chain`、`supply chains`、`supply-chain`、Unicode 连字符变体或 `供应链`，不区分英文大小写。**只有标题或关键词命中不算；缺摘要不推送。** 六位学者的原有追踪不要求供应链主题。
- 日期使用论文元数据中的发表日期或官方 RSS `pubDate`；不使用抓取、索引、创建或存入数据库的时间。Crossref 同时有在线和印刷日期时取较早者，不因近期印刷而重推很早已上线的同一 DOI。
- 元数据只有年月时以月为精度，RSS 使用该月 1 日并在说明中标注；如果该月 1 日早于窗口起点，则保守排除。仅有年份或完全没有日期时排除。未来日期排除。
- UTD24 与 FT50 的并集是 **51 本期刊**，按 ISSN 校验，不将一般期刊关键词搜索冒充名单检索。FT50 使用[官方 2026-04-29 版本](https://www.ft.com/content/db863a0a-6524-45f9-bc52-fee997634bdc)，UTD 名单见[官方入口](https://jsom.utdallas.edu/the-utd-top-100-business-school-research-rankings/list-of-journals)。两组重叠期刊只检索一次，论文可同时带有两个分类。
- 按规范化题名和 DOI 合并重复发现，保留稳定 GUID；输出真实元数据作者、发表日期、摘要、期刊和来源分类。一个条目可能同时带有学者、UTD24、FT50、NBER、CEPR 标签。

## 工作方式与覆盖状态

`sources.json` 是唯一来源配置：`researchers` 保存六位学者的八个页面，`discovery` 保存 51 本期刊的 ISSN、官方名单出处、NBER/CEPR/API 地址、两个月窗口和请求上限。所有结果保存在同一个 SQLite Durable Object 中，Zotero 只订阅 `/feed.xml?key=你的密钥`。

Cron 每六小时更新：UTC `0 */6 * * *`，即北京时间每天 **02:00、08:00、14:00、20:00**。首次通过鉴权打开 RSS 会初始化；后续读取使用已保存的数据，不因读者订阅次数增加而反复访问上游。

每次刷新最多发出 **45 次上游请求**，包括学者页面、重定向、分页和有限重试；API 调用另有整体时间预算。Crossref 一次合并查询名单 ISSN 并分页，CEPR 最多 12 页，OpenAlex 按 DOI 批量补摘要。摘要结果缓存七天，缺失结果缓存一天；每次最多核验 8 个额外学者题名，优先各列表前四项，已缓存项不会消耗查询次数。

通过私有 `/status.json` 查看：

- 当前日期窗口、可输出/已保存条目数、是否被输出上限截断、最近尝试与成功时间。
- `providers`：期刊/NBER/CEPR 的扫描数、近期记录数、摘要命中数、缺摘要/日期数、分页是否完成和错误。
- `providers[journals].coverage`：每本期刊取得的近期元数据数、带摘要数、命中数；`openalexSupplement` 标明补检情况。
- `researcherDates`：学者论文的日期核验、待核验、日期缺失和过期情况；`metadataErrors` 标明 API 限流或预算不足。

**这不是穷尽检索保证。** 出版商未公开摘要、无 DOI、索引延迟、网站故障或 API 限流都可能漏掉论文。期刊近期元数据为 0 不代表没有发表论文。程序不会用标题代替摘要，也不会把抓取时间补成发表时间。超过分页/请求/时间预算时，状态明确标记覆盖不完整；已取得的合格结果照常推送。首次初始化也可能得到有效的空 RSS，表示目前没有取得符合条件的条目，需结合状态页判断。

### 可选：提高公共元数据 API 的可用性

默认使用公开接口，不需要付费 API。OpenAlex 无密钥访问使用共享额度，可能被限流；建议在 [OpenAlex 设置](https://openalex.org/settings/api) 申请自己的免费额度密钥，保存为 **Worker Secret**：

```sh
npx wrangler secret put OPENALEX_API_KEY
```

密钥仅通过 OpenAlex 的 Authorization 请求头发送，不写入 URL、RSS、公开配置或日志。没有密钥或额度耗尽时会报告覆盖缺口，不自动购买额度。参考 [OpenAlex 官方认证说明](https://help.openalex.org/api/authentication/)。

如需使用 Crossref polite pool，可在 Worker 中配置可选变量 `CROSSREF_MAILTO` 为你的联系邮箱。该邮箱仅发给 Crossref；参考 [Crossref API 文档](https://github.com/CrossRef/rest-api-doc)。两项都不是部署必填项，`ACCESS_KEY` 仍然是必须的独立订阅密钥。

## 部署到 Cloudflare

### 方式 A：Cloudflare 直接连接 GitHub（无需在 GitHub 保存部署令牌）

1. 将此项目提交到 GitHub 仓库。
2. 在 [Cloudflare 控制台](https://dash.cloudflare.com/) 的 Workers & Pages 中，从 GitHub 导入该仓库，选择仓库根目录。
3. 安装依赖使用 `npm ci`；部署命令使用 `npm run deploy`。如果界面要求构建命令，可使用 `npm run check`。
4. 使用仓库中的 `wrangler.jsonc`，其中已定义 `FEED_STORE` Durable Object、SQLite 迁移和定时触发器。**不要删除 migrations，也无需手动填写 KV namespace ID。**
5. 在 Worker 的 Variables and Secrets 中设置 `ACCESS_KEY`（类型 **Secret**），保存并部署。之后通过带 `?key=你的密钥` 的地址访问 `/feed.xml` 初始化和 `/status.json` 检查状态。

GitHub 导入和 Cloudflare 授权需在你自己的账号中完成。此仓库不包含账号凭据；没有完成部署时，不存在可供订阅的线上地址。

参考：[Cloudflare GitHub 集成](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)、[Durable Objects 入门](https://developers.cloudflare.com/durable-objects/get-started/)。SQLite Durable Objects 支持 Workers Free，但仍受账号配额限制，详见[官方价格与额度](https://developers.cloudflare.com/durable-objects/platform/pricing/)。

### 方式 B：在自己的电脑部署

安装 Node.js 22 或更高版本：

```sh
git clone https://github.com/jiandwei/RSS.git
cd RSS
npm ci
npm run check
npx wrangler login
npm run deploy
npx wrangler secret put ACCESS_KEY
```

最后一步会交互式请求输入读取密钥。Wrangler 会创建配置中的 Durable Object namespace 和 SQLite 类。以命令输出中的 URL 为准；密钥未设置好之前，服务保持关闭访问。

### 可选：通过 GitHub Actions 手动部署

仓库包含 `.github/workflows/deploy.yml`，只在 Actions 中手动触发，不因普通推送自动发布。

在仓库 Actions secrets 中配置：

- `CLOUDFLARE_ACCOUNT_ID`：部署目标账号 ID。
- `CLOUDFLARE_API_TOKEN`：只授予目标账号所需的 Workers 部署权限，按 Cloudflare 官方部署说明创建。

然后运行 **Deploy Cloudflare Worker** 工作流。选择 A 或 B 即不需要这些 GitHub secrets。

`ACCESS_KEY` 属于 **Worker Secret**，不是这两个 GitHub 部署凭据。首次部署后，在 Cloudflare 设置；之后正常更新代码会继续使用现有 Worker Secret。不要在 `wrangler.jsonc` 的 `vars` 中写入真实密钥。

## 在 Zotero 中添加

部署并设置 `ACCESS_KEY` 后：

1. 点击 Zotero 左侧上方的“新建文献库/添加文献库”按钮。
2. 选择 **新建订阅源 → 从 URL**。
3. 粘贴 `https://你的Worker地址/feed.xml?key=你的密钥`，保存。

或者通过 `https://你的Worker地址/feed.opml?key=你的密钥` 下载私有 OPML，选择 **从 OPML** 导入。OPML **只有一个 outline**，并携带读取密钥，不会给六位学者分别创建订阅。完整 URL 和 OPML 都相当于访问凭证，不要分享或上传到公开仓库。

程序客户端也可以使用 `Authorization: Bearer <ACCESS_KEY>`，无需把密钥放入 URL。显式提供错误的 Authorization 时，不会退回尝试 URL 密钥。读取密钥不授予手动刷新权限。

这是研究链接发现工具。RSS 的 `pubDate` 使用可核验的发表日期，月精度日期会明确标记。学者名称和名单分类放在 category 中，元数据给出的作者放在 `dc:creator` 中；保存到 Zotero 后仍可核对或补全书目信息。升级后，旧数据库中只有抓取日期的历史条目不会继续输出，首次读取会启动新规则的元数据核验。

## 路由

| 路径 | 用途 |
|---|---|
| `/` | 查看统一订阅地址和每个页面的抓取状态 |
| `/feed.xml` | 唯一的聚合 RSS 2.0，支持 ETag、304、HEAD |
| `/feed.opml` | 只包含上述一个 RSS 的订阅文件 |
| `/sources.json` | 查看统一链接配置 |
| `/status.json` | 日期窗口、各来源覆盖、摘要/日期缺口、请求数、失败信息 |
| `POST /refresh` | 可选的手动刷新，必须设置并携带 Bearer secret |

上面所有读取路由（含首页、配置、状态、RSS 和 OPML）都要求 `ACCESS_KEY`。每个响应使用 `private, no-store`，防止公共缓存暴露数据；使用 `Referrer-Policy: no-referrer` 防止点击外链时泄露 URL 密钥。Worker 自动请求日志已禁用，内部转发和上游抓取也会移除读取凭证；但仍应注意浏览器历史、客户端同步和其他平台日志对完整 URL 的保存。

默认不启用手动刷新端点。如需手动刷新，另设一个不同的随机管理密钥：

```sh
npx wrangler secret put REFRESH_TOKEN
```

在终端按提示输入随机 secret。之后可在自己的终端将其保存为 `RSS_REFRESH_TOKEN` 环境变量，调用：

```sh
curl -X POST https://你的Worker地址/refresh \
  -H "Authorization: Bearer $RSS_REFRESH_TOKEN"
```

管理密钥 `REFRESH_TOKEN` 只接受 Authorization 请求头，禁止放在 URL 参数中。如果它与 `ACCESS_KEY` 相同，手动刷新端点会被关闭。不要把任何真实 token 写入 `sources.json`、GitHub 文件或聊天消息中。

## 访问密钥与费用控制

- 未授权请求在入口 Worker 即被拒绝，不会调用 Durable Object 或发起网站抓取；已授权的普通读取也不会反复抓取来源。
- 这是应用层鉴权，**不能让恶意请求的 Worker 请求费用归零**。到达 Worker 的请求仍可能计入额度或计费；如需进一步防护，应按实际域名和账号方案在 Cloudflare 入口设置 WAF/限流，防止流量绕过入口规则。参考[官方请求计费说明](https://developers.cloudflare.com/workers/platform/pricing/)和[指标说明](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)。
- 如果密钥泄露，在 Cloudflare 中更换 `ACCESS_KEY` 并更新 Zotero 订阅 URL；更新部署后旧密钥失效。不要在公开反馈中粘贴完整私有订阅地址。

## 修改链接和抓取规则

只编辑 `sources.json`。`researchers` 中每位学者有 `id`、`name`、`homepage` 和 `pages`；每个页面有以下字段：

| 字段 | 含义 |
|---|---|
| `id` | 页面在该学者下的稳定 ID |
| `url` | 实际论文列表 URL |
| `mode: "links"` | 直接从匹配的链接提取标题 |
| `mode: "quoted-paragraphs"` | 为 Wix 论文列表合并引号开头的标题段落及后续下载链接 |
| `selector` | CSS 选择器；links 模式选 a，quoted-paragraphs 模式选 p |
| `includeUrlPattern` | 可选：只允许匹配的论文 URL |
| `excludeTitlePattern` | 可选：排除已知的数据、幻灯片等非论文链接 |

修改之后运行测试并重新部署；配置随 Worker 一起打包，不从任意用户传入的 URL 抓取，也没有单独的学者 RSS 路由。

`wrangler.jsonc` 中可以修改 `FEED_TITLE`、`MAX_FEED_ITEMS`（默认输出 1000 条，上限 1000）和 `MAX_HISTORY_ITEMS`（默认保留 2000 条，上限 5000）。达到历史上限后按首次发现时间淘汰最老条目；订阅先按两个月窗口筛选，再按发表日期排序和截断。相同 DOI 的变体标题会合并；无 DOI 且标题不同可能产生重复，相同题名的不同论文也可能误合并。

## 错误处理与已知限制

- 某个页面失败、没有匹配结果或返回非 HTML，不会清空已有条目；错误只出现在状态接口和 Cloudflare 日志中。
- 所有来源均失败且没有可用数据时，RSS 返回 HTTP 503 和 Retry-After，不伪造“论文”错误条目；15 分钟内不因重复订阅请求反复抓取。来源扫描成功但没有合格论文时，返回有效的空 RSS。
- 合并写入通过同一个 Durable Object 串行化，第一次并发订阅共用一次抓取，避免重复写入和部分更新。
- 页面选择器是针对公开可访问的 HTML 编写的；不执行上游 JavaScript、不破解访问限制。网站改版时需更新规则。
- 学者主页只抓取配置页上显示的论文，不遍历整站；其日期核验依赖题名和作者一致的 Crossref 元数据。学者列表前四项之外、尚未匹配近期语料的论文会标为待核验。
- **Peter Klenow 的 `https://klenow.com/` 于 2026-10-26 实测返回 HTTP 503，因此其规则尚未通过真实主页验证。** 已保留链接并会重试；不把 Stanford 的目录索引冒充其论文列表。其他五位的七个页面已通过真实 HTML 解析检查。
- 线上 Cloudflare 出口 IP 与开发环境不同，上线后仍需检查 `/status.json`；本地通过不保证上游始终允许 Cloudflare 抓取。
- 第一次初始化可能需要几十秒；之后 RSS 从持久化数据库读取。

## 本地开发与验证

```sh
npm ci
npm run check       # Wrangler 原生打包 + Node 单元测试 + workerd 集成测试
cp .dev.vars.example .dev.vars  # 只在本地编辑，填入 ACCESS_KEY
npm run dev         # 本地 Worker、SQLite Durable Object；访问也需要密钥
npm run check:sources  # 实际访问来源，报告逐页解析结果；需要网络
```

`npm run check` 使用小型手写 HTML fixtures 和仅用于测试的密钥，不依赖学者网站在线状态。测试涵盖两个月边界与月末、真实发表日期、仅摘要命中、期刊白名单、Crossref/CEPR 分页、NBER 缺日期时的元数据连接、OpenAlex 精确 DOI 补全、跨来源去重、过期/旧版条目排除、GUID 稳定性、XML 转义、私有单源 OPML、并发初始化、所有路由鉴权、未授权请求零存储调用、密钥缺失时关闭 Cron、管理/读取密钥隔离、条件请求、失败保留历史、空解析报警。集成测试运行真正的 `HTMLRewriter` 和 SQLite Durable Objects。

若当前 Node 网络环境不能直接访问学术网站，可把从对应公开 URL 下载的 HTML 放入本地目录，文件名为 `<研究者id>--<页面id>.html`，运行：

```sh
node scripts/check-sources.mjs --snapshots .scratch/pages --allow-errors
```

带 `--snapshots` 只替换学者 HTML，文献元数据仍访问真实 API。探测报告和 XML 保存在 `.scratch/`，不会提交到 GitHub。`--allow-errors` 只影响探测脚本退出码，不改变生产中的错误处理。
