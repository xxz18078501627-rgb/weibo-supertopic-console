# 交接文档 · 制饼工坊（超话工作台）

> 项目代号：`weibo-super-topic-console` / 制饼工坊 / 超话工作台
> 代码目录：`/Users/xiaxizhou/Documents/Codex/2026-10-27/xian-zai`
> GitHub：<https://github.com/xxz18078501627-rgb/weibo-supertopic-console>
> 最后更新：2026-11-14

**这份文档是给「下一个打开这个项目的对话」看的。** 每次新开对话，先完整读一遍本文，再读 `docs/工作日志.md` 最近几条，然后才动手。每次做完改动，必须在 `docs/工作日志.md` 追加记录；涉及版本、服务、未提交改动、已知问题的变化，同时更新本文第 10 节。

---

## 0. 30 秒版

- 这是一个**只在本机运行**的微博多账号任务控制台：用 Chrome 自动完成超话签到、发帖、原创、评论，以及指定微博的转发/评论/点赞（转赞评）。
- 入口是 <http://localhost:4178>，由 launchd 开机自启；Node 24 + Playwright + 本机 Chrome；数据在本机 SQLite 和 `data/profiles/`，不上传服务器。
- 当前代码版本是 **v1.1.4**；1.1.3 之后的停止语义、签到卡误判、导航恢复、浏览器重开、服务重启和进程自愈改动仍在工作区，发布前不要对外说「已发布」。
- 真实账号数据、登录态、访问口令、激活码都在 `data/` 和 `~/Library/Application Support/ZhibingStudio/`，**只读、不外传、不打包**。
- 改任务调度、适配器、回执、验证 UI 前，先读第 4 节的验证契约；测试必须用临时数据目录和模拟页面，不在真实账号上试发送。

---

## 1. 这个程序是干什么的

给同一个人的多个微博账号批量做「超话经营」的本地工作台。核心能力：

- **超话工作台**：在固定超话内按账号执行签到、评论、发帖（可加原创），支持多轮、间隔、随机文案、文案分组、每轮统计。
- **转赞评**：粘贴一条或多条微博链接，对目标微博执行转发、评论、点赞；支持无头运行，也支持遇到验证时弹出可见窗口人工处理。
- **账号管理**：扫码登录、分组、启用/停用、禁言/频繁/登录失效标记、批量操作。
- **共享文案库**：发帖文案、评论文案、转发文案，支持批量粘贴、分组、移动、去重与迁移。
- **记录**：按日汇总、账号运行情况、任务明细、全部流水、需要关注的问题、归档。
- **更新**：应用内检查/下载/安装 GitHub Release，保留数据，失败回滚；Mac/Windows 安装包。
- **手机访问**：同一 Wi-Fi 下扫码打开局域网地址。

它不是云服务，也不是爬虫平台；所有浏览器操作都在本机 Chrome 里完成，登录态保存在本机。

---

## 2. 运行形态

| 项目 | 值 |
| --- | --- |
| 页面 | <http://localhost:4178>（局域网另给 `http://<本机IP>:4178`） |
| 进程 | `node src/server.js`，由 launchd 用户级服务托管 |
| launchd 标签 | `com.local.weibo-super-topic-console`，plist 在 `~/Library/LaunchAgents/` |
| 运行时 | Node **24+**（源码机用 `/usr/local/bin/node`） |
| 浏览器 | 本机 Google Chrome（找不到时回落 Playwright Chromium） |
| 数据库 | SQLite：`data/console.sqlite`（WAL） |
| 当前源码机数据目录 | `<仓库>/data` |
| 安装版数据目录 | Mac：`~/Library/Application Support/ZhibingStudio/data`；Windows：`%LOCALAPPDATA%\ZhibingStudio\data` |
| 访问控制 | 激活码 + 访问口令；服务端校验签名，激活文件 `data/license.json` |

说明：源码目录启动时数据就在仓库 `data/`；安装包运行时才用系统应用数据目录。两者不要混用。

---

## 3. 页面与功能地图

| 页面 | 主要做什么 |
| --- | --- |
| 超话工作台（overview） | 选账号/分组、选超话、配动作（签到/评论/发帖/原创）、轮数、间隔、文案策略；开始/暂停/停止；最近运行 |
| 转赞评（engage） | 粘贴微博链接、选账号、配转发/评论/点赞顺序与文案；进度、每日统计、最近运行 |
| 账号（accounts） | 扫码添加、搜索、分组、状态筛选（禁言/频繁/失效/停用）、批量启停删 |
| 文案（materials） | 发帖/原创/评论/转发四类文案库，批量导入、分组、移动、删除 |
| 记录（logs） | 当日汇总、需要关注、账号运行情况、任务明细、全部流水、归档 |
| 更新（update，左侧栏） | 检查更新、下载、更新并重启、版本说明 |

页面是原生 JS 单页（`public/index.html` + `public/app.js` + 各 `*-ui.js`），没有前端框架、没有构建步骤；改完刷新即可。

### 3.1 典型使用流程

1. **账号**页扫码登录，按需分组、启用/停用；失效账号会标红。
2. **文案**页导入发帖/原创/评论/转发文案，按分组管理。
3. **超话工作台**选账号（可按分组）、选超话、配动作和轮数，点「开始运行」。
4. 遇到验证：处理弹出的卡片，全部处理完点「继续运行」；不想继续就「停止」。
5. **记录**页看当日汇总、失败/待核对项和全部流水。
6. **转赞评**是独立页面：粘贴微博链接、选账号、配转发/评论/点赞，单独运行、单独统计。

超话模式由 `WEIBO_CONSOLE_TOPIC_MODE` 控制：默认 `fixed`（固定超话，评论区默认「超like」）；设为 `general` 时评论区默认「最新」。

---

## 4. 关键业务规则（改代码前必看）

### 4.1 两个任务 scope

- `workbench`：超话内任务。步骤状态在 `task_step_state`，动作记录在 `action_logs`。
- `engage`：指定微博的转赞评。也有自己的 step/action 记录和独立的 runner 配置。

两个 scope 共用账号租约、浏览器管理、验证工作流和部分统计，但**配置、模板、记录页、验证策略是分开的**。改共享层必须同时回归两边。

### 4.2 人工验证契约

- 后台遇到验证，只挂起**同账号本轮同类操作**，生成验证卡；不是整批全停。
- 卡片只处理**真正触发验证的当前一步**；其余步骤等所有待验证项处理完，由用户点「继续运行」。
- 签到：同一窗口先点一次，确认验证码解除后再补点一次，直到只读验收到「已签到」；轮询/重开不得无证据增加点击次数。
- 签到结果未确认（没有读回「已签到」）时，卡片必须保持待验证；同账号其他动作成功不能把卡片改成「已验证」，必须先处理/补做签到。
- 发帖/评论：只有「未提交」或「本次提交被明确拦截」的证据，才允许在卡片窗口重触发原目标、原文案；窗口已经点过就等微博自动提交并匹配回执，**结果未知只核对，不自动重发**。
- 转发/内赞：失败可再次验证，只有实际成功才显示通过；外赞已点过、微博明确提示频繁，记为跳过。
- 验证窗口保持可见并自动最大化；成功回执立即结算，下一张卡马上可处理。

### 4.3 停止语义（未提交改动重点）

- 「停止」对未完成的操作是终态：已跳过/已停止的记录不能被迟到的浏览器回调改回 failed/uncertain。
- `stopAndWait()` 会等任务浏览器真正释放（最多 60 秒），API 返回时任务应已停稳；不要退回「只置 stopRequested 就返回」。
- 停止后不再安排自动复核（auto readbacks 只对 `completed` 任务生效）。

### 4.4 时间与保留

- 每天 **23:59（Asia/Shanghai）自动停止**未完成任务；这是 `daily-stop.js`，不是系统 cron。
- 记录默认保留 **10 天**（`retention.js`，设置项 `retention_v1`）。
- 所有日期/统计按北京时间，服务端配置 `timezone: 'Asia/Shanghai'`。

### 4.5 断网与页面故障

- 断网：暂停任务，网络恢复后继续；不把网络错误记成账号失败。
- 页面/导航异常：`navigation-recovery.js` 尝试回首页/重开；恢复失败才升级为人工处理。
- 浏览器按账号串行租约（`account-leases.js`），同一账号连续评论会复用同一个浏览器和超话页。

### 4.6 更新

- 更新走 GitHub Release；源码目录更新会保留 `data/`，并避免备份 `.git`、构建产物和 Playwright 浏览器目录。
- 更新后必须做健康检查；失败要恢复旧版本并重新拉起服务。
- macOS 上 `launchctl kickstart` 找不到服务（退出码 113）时，要按安装流程重新 bootstrap，不能把应用留在停止状态（未提交改动）。

### 4.7 账号状态

- `muted` 禁言、`limited` 频繁、`invalid` 登录失效、`disabled` 停用；任务开始前按状态过滤，但不要擅自改用户账号数据。

### 4.8 浏览器重开与服务重启（1.1.4）

- 复用同一个 Chrome 的会话（工作台连续评论段、转赞评分组会话）默认每 **20 次操作或 10 分钟**先到为准关闭重开；设置存 `settings.browser_recycle_v1`，在“高级 → 运行保护”调整。签到/发帖/原创本来就每次动作后关闭，不受影响。
- 重开只关闭浏览器进程，不删除 profile、不清磁盘缓存、不退出登录；到阈值时只在“下一次操作开始前”执行，不打断当前动作。
- 左侧栏“重启服务”调用 `POST /api/service/restart`：空闲直接重启；有任务/浏览器时先返回 409，确认后 `force:true` 会暂停任务、关闭浏览器并退出，当前步骤留给启动时的断点恢复处理（已提交转待核对，未提交重新排队），再由 launchd/监督器拉起。
- 重启使用非零退出码，确保 macOS `SuccessfulExit=false` 的 launchd 和 Windows 监督器都会重新拉起；页面会轮询健康接口并自动刷新。
- 导航等待期不再只能“停止后新建”：任务卡片有“立即重试”，`continue()` 会先清掉 waiting；已提交动作只做只读核验，不重发。

---

## 5. 代码地图

| 文件 | 作用 |
| --- | --- |
| `src/server.js` | HTTP 服务、静态页、API、SSE、鉴权入口；所有路由在这里 |
| `src/runner.js` | 工作台任务主循环、暂停/继续/停止、自动复核、进度 |
| `src/verification-workflow.js` | 人工验证卡、挂起/恢复、停止结算、卡片汇总 |
| `src/weibo-adapter.js` | 微博页面 DOM 适配：签到、发帖、评论、打开目标 |
| `src/engage.js` | 转赞评执行器 |
| `src/engage-dom.js` | 转赞评页面解析/定位 |
| `src/engage-profile-resolver.js` | 转赞评作者/主页解析 |
| `src/browser.js` | BrowserManager：启动/复用/关闭 Chrome，profile 目录 |
| `src/account-leases.js` | 账号级串行租约 |
| `src/login-service.js` | 扫码登录流程 |
| `src/db.js` | SQLite 连接、建表、迁移、所有读写函数 |
| `src/migrations.js` | 数据迁移（文案、分组、账号删除等） |
| `src/config.js` | 路径、端口、Chrome 路径、默认任务配置 |
| `src/license.js` | 激活码签名校验（**公钥不可改**） |
| `src/daily-stop.js` | 23:59 截止 |
| `src/retention.js` | 10 天记录清理 |
| `src/network-recovery.js` | 断网暂停/恢复 |
| `src/navigation.js` / `navigation-recovery.js` | 导航与故障恢复 |
| `src/post-receipts.js` / `post-success-notice.js` | 发帖回执匹配与成功提示 |
| `src/result-state.js` | 动作结果状态归一化 |
| `src/task-progress.js` / `task-reports.js` | 进度与报表 |
| `src/record-view.js` | 记录页聚合 |
| `src/notifications.js` | 通知/提示 |
| `src/runtime-settings.js` | 浏览器定时重开等本机运行保护设置 |
| `src/lan-access.js` | 手机访问地址与二维码 |
| `src/update-manager.js` | 应用内更新 |
| `src/util.js` | 通用工具 |
| `public/index.html` | 单页结构（5 个页面 + 对话框） |
| `public/app.js` | 主逻辑、API 调用、SSE |
| `public/*-ui.js` | 转赞评/记录/分组/验证/日停等 UI 模块 |
| `public/topic-policy.js` / `defaults.js` | 超话策略与默认文案装饰 |
| `scripts/service.mjs` | launchd/Windows 服务安装、启停、状态 |
| `scripts/make-license.mjs` | 激活码生成 |
| `scripts/build-release.mjs` / `build-platform-package.mjs` | 发布包与安装包 |
| `scripts/update-helper.mjs` | 更新辅助进程 |
| `bootstrap.mjs` | 安装/体检/启动/更新/回滚统一入口 |

---

## 6. 数据与文件

### 6.1 关键表

| 表 | 内容 |
| --- | --- |
| `accounts` / `account_groups` / `account_restrictions` | 账号、分组、限制状态 |
| `jobs` | 任务（`scope`、`config_json`、`cursor_json`、`metrics_json`、状态） |
| `task_rounds` / `task_step_state` | 轮次与每个步骤的状态 |
| `action_logs` | 每一次动作的流水、结果、回执、验证标记 |
| `verification_cards` | 人工验证卡 |
| `checkins` / `comment_history` | 签到与评论历史（防重复） |
| `post_materials` / `shared_original_materials` / `comment_materials` / `repost_materials` / `shared_*` | 文案库（含原创）与迁移前的共享库 |
| `daily_stats` / `daily_scope_stats` | 每日统计 |
| `system_logs` / `settings` | 系统日志、设置开关 |

### 6.2 目录

- `data/console.sqlite`：主库（约 120 MB，含 WAL）。
- `data/profiles/`：每个微博账号的 Chrome 登录目录，**最敏感**。
- `data/backups/`：迁移/修复前的备份。
- `data/updates/`：应用内更新下载与版本目录。
- `data/license.json`、`data/access-token`：激活与口令，**不要读、不要打印**。
- `dist/`：历史发布 ZIP / manifest / 安装包，可重新生成，不要提交进仓库。
- `outputs/`、`work/`：历史产物/临时文件，不是运行必需。

备份：先暂停任务，再完整复制 `data/`。不要上传网盘、发聊天或提交 GitHub。

---

## 7. 常用命令（仓库根目录）

| 目的 | 命令 |
| --- | --- |
| 看服务是否活着 | `curl -s http://localhost:4178/api/health` |
| 体检 | `node bootstrap.mjs doctor`（`--json` 给机器读） |
| 自动修依赖/浏览器 | `node bootstrap.mjs doctor --fix` |
| 前台启动（调试） | `node bootstrap.mjs start` |
| 直接跑服务 | `npm start` |
| 服务状态 | `node scripts/service.mjs status` |
| 装/卸开机自启 | `node bootstrap.mjs service install` / `service uninstall` |
| 检查更新 | `node bootstrap.mjs update --check` |
| 更新 | `node bootstrap.mjs update` |
| 回滚 | `node bootstrap.mjs rollback` |
| 单元/集成测试 | `npm test` |
| 端到端 | `npm run test:e2e` |

注意：`npm start` 会再起一个 4178 实例并和现有服务抢端口。调试前先确认服务状态，不要直接杀未知进程。

---

## 8. 开发与测试规则

- 只用临时数据目录（`WEIBO_CONSOLE_DATA_DIR`）和拦截请求的模拟页面做测试；**不在真实账号上测试发送**，不改用户真实库。
- 改共享调度、适配器、回执或验证 UI 时，工作台验证契约和转赞评回归都要跑：`npm test`，必要时 `npm run test:e2e`。
- UI 改动至少跑 `tests/ui.e2e.test.js` / `tests/engage-ui.e2e.test.js` 中相关部分。
- 不要为了让测试过而放宽激活校验、跳过验证或改公钥。
- 提交前检查 `git status`；本项目历史上长期存在未提交改动，先弄清是不是别人的在途工作，再决定是否覆盖。

### 发布（仅维护者，详见 `AGENTS.md`）

1. 同步远端 `main`，不覆盖已有提交/标签。
2. `npm version <x.y.z> --no-git-tag-version --ignore-scripts`，更新 CHANGELOG/README/INSTALL/RELEASE_NOTES。
3. 全量测试 + e2e。
4. 用上一版 Release 的干净种子库（`WEIBO_SEED_SOURCE`）执行 `npm run build:release`；**不要用本机真实 `data/` 打包**。
5. 推 `main` → 等同一提交 CI 成功 → 打标签 → `gh release create` → 核对附件与 SHA256。

激活码：生成后用 `~/.weibo-console/license-ledger/ledger.mjs issue --user ... --token ...` 记账到 `/Users/xiaxizhou/Desktop/激活码/激活码登记表.xlsx`，成功后才能交付。台账、口令、激活码只留本机。

---

## 9. 敏感信息红线

1. 不读、不打印、不转述 `data/access-token`、`data/license.json`、激活码、访问口令。
2. 不复制 `data/`（尤其 `data/profiles/` 登录态）到仓库、聊天、网盘或任何外部位置。
3. 不修改 `console.sqlite` 里的账号/任务数据，除非用户明确要求。
4. 不绕过激活校验，不改 `src/license.js` 公钥。
5. 不把真实账号昵称、UID、Cookie、请求头写进日志、提交信息或交接文档。

---

## 10. 当前状态快照（2026-11-14 约 00:40）

> 这一节会过期。新对话先按下面的命令核对，再以核对结果为准。

| 项 | 值 |
| --- | --- |
| 代码版本 | `1.1.4`（未发布，工作区） |
| 服务 | 运行中，`http://localhost:4178`，v1.1.4，pid 51181，supervised=true，2026-11-14 00:34 启动 |
| 启动方式 | launchd `com.local.weibo-super-topic-console`，`runs = 5`，`last exit code = 0` |
| 代码 HEAD | `c7d711e docs: prepare the 1.1.4 release notes and handoff` |
| 工作区 | 干净；仅 `license-server/`（独立云端签发服务）未跟踪 |
| 数据规模 | 95 个账号、154 个任务、21,891 条动作流水、1 个超话、1,042 张验证卡；库约 124 MB |
| 运行中任务 | 当前无；昨晚任务已在 23:59 日停时停止 |

### 1.1.4 改动（2026-11-14，未发布）

- 导航等待态可人工恢复：新增 `POST /api/jobs/:id/navigation/retry`；`continue()` 先清 waiting 不再 500；`pause()/resume()` 不再被旧 waiting 劫持；未提交动作重试、已提交只读核验。
- 自检改为 `waitUntil:'commit'` 后轮询 `$CONFIG`/uid；最近 3 次 2 次 ready 即恢复；418/429/403 走 30 秒到 30 分钟退避。
- 恢复循环加 90 秒硬截止、30 秒看门狗、关闭浏览器 12 秒超时和按 profile 强制结束。
- 浏览器定时重开：`settings.browser_recycle_v1`，默认 20 次/10 分钟，高级页可改。
- 左侧栏“重启服务”：`POST /api/service/restart`；非零退出，launchd/监督器自动拉起，页面轮询健康后刷新。
- `scripts/service-runner.mjs` 增加监督重启（1/5/15/60 秒）；server 增加未捕获异常/未处理拒绝处理，退出后由监督器拉起。
- 全量 `npm test` 387 通过、1 跳过；`npm run test:e2e` 77 通过；代码提交 `6852f26`，文档提交 `c7d711e`，尚未推送/发版。

### 未提交改动（2026-11-12，尚未发布）

- `scripts/service.mjs`：`launchctl kickstart` 遇到 113/找不到服务时自动重新 `install()`，避免更新后服务起不来。
- `src/db.js`：任务已 `stopped` 时，迟到的回调不能把 `skipped` 改回 failed/uncertain。
- `src/runner.js`：新增 `stopAndWait()`（等浏览器释放，最多 60 秒）；停止时取消自动复核；自动复核只对 `completed` 任务执行；停止时调用 `workflow.finalizeStop()` 结算剩余步骤。
- `src/server.js`：`POST /api/jobs/:id/stop` 改为 `await runner.stopAndWait()`，返回时表示已停稳。
- `src/verification-workflow.js`：新增 `finalizeStop()`；验证卡汇总改为按 identity 聚合，补 `visible`/`remainingStepCount`/`currentStep` 等字段；隐藏无剩余步骤的签到卡；停止后不再继续生成/恢复卡片。
- 测试同步改了 `tests/core.test.js`、`navigation-recovery.test.js`、`network.test.js`、`verification.test.js`。
- 新增未跟踪脚本 `scripts/repair-engage-verification.mjs`。

状态：**未提交、未跑完整回归、未发布**。接手时先确认这些改动是否仍需要，再决定提交/继续改/回退；不要直接 `git checkout --`。

### 已知问题 / 风险

1. **23:59 日停 + 人工验证会抛未捕获异常（1.1.4 已加全局兜底和监督重启，仍建议观察）**：`data/service-error.log` 有多次 `DailyStopError: 每日 23:59 自动停止`，从 `verification-workflow.js` 的 `manualOperation`/`openError` 抛出后进程退出（Node 24 打印堆栈）。launchd 会自动拉起，但任务会被打断。待确认是否已被上述未提交改动覆盖，建议补一条「日停期间打开验证卡返回 409 且不崩进程」的测试。
2. **服务重启/启动次数偏多**：`service.log` 里有 88 条启动输出（含历史手动启动），launchd 当前 `runs=4`、`last exit code=1`。先看 `data/service-error.log` 的时间线，不要盲目重装。
3. **工作区脏**：11-12/11-13 和 1.1.4 改动均在同一工作区，尚未提交。对外说版本时以 `package.json`/健康接口为准，不要说「已发布」。
4. **95 个账号、124 MB 库**：全量测试/扫描类操作要限量，避免拖慢正在运行的任务。
5. **Windows 未在本机验证**：安装器/更新只做了测试与 CI，真实 Windows 机器仍需用户确认。
6. **签到未确认卡会被其他动作误判为“已验证”（已修复，2026-11-13 19:52 重启生效）**：`deferUnconfirmedCheckin()` 建卡时签到动作的 `verification_pending` 仍为 0；随后同账号任意动作（如评论）成功，`markActionVerificationPassed()` 只检查 `verification_pending=1` 的其他动作，于是把卡改成 `passed/action_receipt`，但签到仍是 `deferred`。UI 同时显示“已验证”和“待补做 1 项”，且 `currentActionable` 不认“签到 + uncertain”，按钮被禁用。2026-11-13 已在真实任务中复现（3 张卡）。

   修复：建卡时把签到动作标为 `verification_pending=1`；`markActionVerificationPassed()` 遇到 `ever_verification=1` 的 deferred checkin 直接拒绝通过；`currentActionable` 与 `eligible` 共用同一判定；`continue()` 清掉 `submitted_at` 重新排队签到；`status()`/`loop()` 自动把历史 `action_receipt + deferred checkin` 卡恢复为 `checkin_unconfirmed`。2026-11-13 单测、全量 `npm test`、`npm run test:e2e` 均通过；**已重启加载，服务 PID 26106**。

7. **“页面恢复等待”期间点“继续运行/验证”返回 500，手动暂停也脱不了身（1.1.4 已修复）**：任务处于 `cursor.navigationRecovery.state='waiting'` 时，`workflow.continue()` 首先调用 `runner.assertMaySubmit()`，后者抛出无 `statusCode` 的 `页面恢复等待中，禁止提交`，server 按 500 返回，页面显示“服务器处理失败”。同时 `runner.pause()` 只清定时器，不清 cursor 里的 navigationRecovery；`resume()` 看到 waiting 会再次挂起。1.1.4 已实现：pause 时把 navigationRecovery 置 cancelled，continue 先清 waiting 并返回 409/立即重试；自检改为最近 3 次 2 次 ready，恢复循环加硬截止和看门狗，并补了回归测试。

### 云端激活码签发（2026-11-13）

- 目标地址：`https://110.40.207.171/`；云端独立于本地微博任务工作台。原 `sslip.io` 域名触发腾讯云未备案域名拦截，因此使用 Let's Encrypt IP 地址短期证书。
- 代码：仓库内未跟踪目录 `license-server/`；线上程序 `/opt/zhibing-license`，数据 `/var/lib/zhibing-license/license.db`，私钥 `/var/lib/zhibing-license/secrets/license-key.pem`。
- 服务：`zhibing-license.service` 仅监听 `127.0.0.1:4319`；主机 Caddy 负责 `80/443`；备份 timer 保留 30 份。
- 登录：仅使用用户名和密码，密码为 scrypt 加盐哈希；已移除 TOTP 依赖。系统最低允许 8 位密码，2026-11-13 已按要求将现有五个账号统一轮换为 8 位。
- 迁移：58 条历史激活码已导入并用应用公钥验签；本地 Excel 和 `batch-*` 作为冻结备份，日常签发以云端台账为准。
- 公网状态：腾讯云 Lighthouse 已放通 `80/443`；Caddy 使用 `shortlived` profile 和 IP SAN 证书，公开登录、CSRF 与台账接口均已验证。六个工作日内证书会自动续期，检查 `journalctl -u caddy.service | grep -E 'certificate obtained|renewal'`。
- 账号：已有管理员和四个签发人。签发人初始密码只保存在本机 `~/.weibo-console/license-issuer-accounts-20261113/issuer-accounts.json`，目录 0700、文件 0600。

---

## 11. 已知坑

- 端口 4178 被占用：先 `curl /api/health` 确认是不是本软件；不要杀未知进程。
- 页面打不开：先看 launchd 状态和 `data/service-error.log`，再 `node bootstrap.mjs doctor`。
- `npm start` 与 launchd 服务会争端口；调试用别的 `WEIBO_CONSOLE_PORT` 或先停服务（需用户同意）。
- 真实库和安装版库是两套；在源码目录测试时默认读写 `data/`，务必用 `WEIBO_CONSOLE_DATA_DIR` 指向临时目录。
- 文案迁移、账号删除都有备份设置（`shared_materials_v2`、`account_deletion_v3` 等），不要重复迁移或删除备份。
- 发帖回执依赖 DOM 匹配；微博改版会让「已点但未发出」判断失效，改适配器要配回执测试。
- 停止任务后仍可能有浏览器回调；任何写入 `action_logs` 的路径都要尊重 `stopped` 终态。

---

## 12. 每次对话的交接流程

### 开场（必须）

1. 读本文，重点第 4、9、10 节。
2. 读 `docs/工作日志.md` 最近 3～5 条。
3. 核对现状：
   ```bash
   cd /Users/xiaxizhou/Documents/Codex/2026-10-27/xian-zai
   curl -s http://localhost:4178/api/health
   git status --short
   git log -5 --oneline
   ```
4. 如果用户要动正在运行的任务/服务，先说明影响并征得同意。

### 收尾（必须）

在 `docs/工作日志.md` **最上面**追加一条，格式：

```markdown
## YYYY-MM-DD HH:mm · 一句话标题

- 目标：
- 改动：涉及文件 / 行为变化
- 验证：跑了什么命令，结果如何（没跑就写「未验证」）
- 状态：已提交 <hash> / 未提交 / 已发布 <version>
- 遗留：下一步、风险、需要用户确认的事
```

同时：

- 版本、服务、未提交清单、已知问题有变化 → 更新本文第 10 节。
- 新增/修改业务规则 → 更新第 4 节。
- 不写任何口令、激活码、账号 UID、Cookie、真实昵称。

---

## 13. 音乐公众号视频简介规范（2026-11-13 新增）

用户要求以后写视频简介统一按以下标准执行：

1. **先核对视频内容**：打开视频页确认标题、演出团体、曲目、词曲作者、指挥/伴奏、时间地点。不能只凭标题猜内容。
2. **正文必须同时满足**：
   - 符合视频内容：谁演的、什么曲目、什么场合、音乐上有什么特点；
   - 符合给定标题的立意，不另起炉灶；
   - 公众号风格：有画面感和情绪，少术语堆砌，不写成节目单；
   - 约 200 字（含标点约 180–220 字）。
3. **另写一条 15 字以内的摘要**，单独一行。
4. 不编造未核实的信息；引用歌词只取短句或意象，不整段翻译。
5. 输出顺序：**标题 / 摘要 / 简介**。

示例（仅示范语气与结构）：

> 摘要：寂静不是无声，而是另一种歌唱
>
> 把声音放到最轻，仍然能听见和声在流动。2025年7月26日，在深圳音乐厅“飞翔之梦”专场音乐会上，深圳红岭教育集团高中部金声合唱团演唱了混声合唱《The Music of Stillness》。词作来自莎拉·蒂斯代尔，曲由伊莱恩·哈根伯格写就；在余臻辉的指挥、蒋子豪的钢琴伴奏下，少年们不急于煽情，只让声音一层层铺开。歌里唱着星子、覆雪的屋顶，也唱着一个人终于安静下来的心。万籁俱寂处，歌声仍在流动。

