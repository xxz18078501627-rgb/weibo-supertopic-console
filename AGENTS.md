# AGENTS.md · 给任意编码 agent 的安装与维护说明

这个仓库是「超话工作台」——一个只在本机运行、用 Chrome 操作微博超话的网页控制台。
它需要 **Node 24+**、**Chrome（或 Playwright Chromium）**，默认监听 `4178`。

## 用户说「帮我装这个」时，按平台执行

先 `cd` 到仓库目录，然后：

- macOS / Linux：`bash install.sh`
- Windows（PowerShell）：`powershell -ExecutionPolicy Bypass -File install.ps1`

脚本会：检测并下载便携 Node 24 到 `.runtime/` → 安装依赖 → 缺 Chrome 时装 Playwright Chromium → 启动服务并装开机自启 → 输出地址。

装完把 **http://localhost:4178** 发给用户，并说：「页面会让你粘贴激活码，找管理员要」。

## 安装验收范围

- “帮我安装”仅指准备依赖、启动本地服务并配置开机自启；验收只检查依赖、服务启动及 http://localhost:4178 页面可访问，首次安装显示激活页即可。
- 安装不包含扫码登录微博、添加账号、创建任务或执行签到、发帖、评论；不得以测试安装为由运行这些操作。
- 激活、输入访问口令、登录账号及运行任务由用户安装后另行决定。不要索取、读取或输出已有口令与激活记录，不要绕过激活来验收。
- 保留并尊重已有任务和浏览器会话；端口被占用时先确认服务状态，不得擅自停止。

## 硬性规则（任何 agent 都必须遵守）

1. **不要读取、打印或转述 `data/access-token`、`data/license.json` 的内容**，也不要自行设置访问口令；口令由管理员通过激活码发放。
2. **不要复制 `data/` 到仓库、聊天或任何外部位置**：里面有用户微博登录态（`data/profiles`）与账号数据。
3. 不要修改 `data/console.sqlite` 里的账号/任务数据，除非用户明确要求。
4. 不要跳过激活校验，也不要修改 `src/license.js` 的公钥。

## 常用命令（在仓库根目录）

| 目的 | 命令 |
| --- | --- |
| 体检（可给用户看） | `node bootstrap.mjs doctor` 或加 `--json` |
| 自动修复依赖/浏览器 | `node bootstrap.mjs doctor --fix` |
| 手动前台启动 | `node bootstrap.mjs start` |
| 装/卸开机自启 | `node bootstrap.mjs service install` / `service uninstall` |
| 查看是否最新 | `node bootstrap.mjs update --check` |
| 更新（保留 data） | `node bootstrap.mjs update` |

## 排障

- **端口被占用**：`doctor` 会提示；先确认是不是已有一份服务在跑，不要直接杀掉别的进程。
- **打不开页面**：确认 `doctor` 的 node/deps/browser/network 全绿；Windows 首次可能弹防火墙，选择「允许专用网络」。
- **手机访问**：电脑和手机同一 Wi-Fi；页面右上角「手机访问」有二维码；公司/酒店 Wi-Fi 常开客户端隔离。
- **扫码窗口没弹出**：任务与扫码都依赖本机浏览器，Windows 需允许应用弹出窗口。

## 发布（仅维护者）

`npm run build:release` 生成 `dist/weibo-console-<version>.zip`（内含干净种子库）；`npm run release -- --bump patch --notes "..."` 打 tag 并用 `gh` 上传 Release。
