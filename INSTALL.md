# 安装说明（人和 agent 都看这一份）

## 你需要什么

- 一台 Mac 或 Windows 电脑
- 能上网
- 一个激活码（找管理员要）

不需要提前装 Node，不需要管理员权限。

## Mac

1. 从 GitHub Releases 下载并解压 `weibo-console-1.0.1.zip`。
2. 打开「终端」，`cd` 到解压出来的目录。
3. 运行：`bash install.sh`

## Windows

1. 从 GitHub Releases 下载并解压 `weibo-console-1.0.1.zip`。
2. 在解压目录空白处按住 Shift 右键 →「在此处打开 PowerShell 窗口」。
3. 运行：`powershell -ExecutionPolicy Bypass -File install.ps1`

## 安装验收与操作边界

安装仅准备 Node、依赖及浏览器，启动本地服务并配置开机自启。验收只检查运行依赖是否就绪、服务是否启动，以及 http://localhost:4178 是否可访问；首次安装显示激活页即视为安装完成，无需激活或登录来验收。

安装请求不包含扫码登录微博、添加账号、创建任务或执行签到、发帖、评论。激活码和访问口令由用户自行输入；账号登录和业务操作须由用户在安装后另行决定，不作为安装测试。不要读取或输出激活记录、访问口令及浏览器登录态，也不要关闭激活校验来验收。

如端口已被使用，应先确认占用者和服务状态，不得为安装验收擅自停止现有任务或服务。

## 第一次使用（安装完成后，由用户决定）

1. 浏览器打开 **http://localhost:4178**。
2. 页面会停在激活页，粘贴管理员给你的**激活码**。
3. 用管理员给你的**访问口令**登录。
4. 账号页点「添加账号并扫码登录」，用自己的微博扫码；之后所有操作都在本机浏览器里完成。

## 常见问题

- **端口 4178 被占用**：先确认是否为已有工作台；若是，直接打开 http://localhost:4178 ，不要停止现有任务。若为其他程序，另设端口。
- **页面打不开**：`node bootstrap.mjs doctor` 看哪项不通过；可用 `node bootstrap.mjs doctor --fix` 修复依赖或安装缺少的浏览器。
- **Windows 提示“成功创建计划任务”，随后健康检查失败**：计划任务创建成功不代表工作台已启动。v1.0.1 的 Windows 后台脚本存在监听进程检测与启动问题。先在原目录运行 `node bootstrap.mjs start`，保持终端打开并访问 http://localhost:4178；若前台也失败，查看该终端的实际启动错误。不要删除或重建 `data/`。取得修复后的程序文件后，先在页面安全暂停任务、结束扫码及人工验证，再在前台终端按 Ctrl+C 停止，运行 `node bootstrap.mjs service install`。修复后的后台错误写入 `data/service-error.log`，普通输出写入 `data/service.log`；排障时勿转发口令或激活信息。
- **手机打开不了**：确认同一 Wi-Fi；点页面右上角「手机访问」扫码。
- **更新**：`node bootstrap.mjs update`（账号、文案、激活状态都会保留）。

## 从 v1.0.0 升级到 v1.0.1

1. 在页面中安全暂停正在执行的任务，结束扫码或人工验证会话。
2. 在原安装目录运行 `node bootstrap.mjs update --check` 确认最新版本，再运行 `node bootstrap.mjs update`。
3. 服务重新启动后刷新页面。更新保留原 `data/`，账号、文案、任务、激活状态和浏览器登录目录无需重建；首次启动会自动补充数据库结构并迁移旧的待验证记录。手动暂停的任务由你决定何时继续。

新版本会把“待验证”与“待核对”分开计数；普通发帖、评论结果不明确时保留待核对并继续后续步骤，不自动重发。人工验证时仍会观察本次提交的成功结果。详细变化见 [CHANGELOG.md](CHANGELOG.md)。

Release 同时提供 `weibo-console-1.0.1.manifest.json`，其中包含安装包大小与 SHA256。Mac 可运行 `shasum -a 256 weibo-console-1.0.1.zip`，Windows 可运行 `Get-FileHash .\weibo-console-1.0.1.zip -Algorithm SHA256`，与 manifest 中的 `sha256` 对照。

本次自动化验证环境为 macOS / Node 24 / Google Chrome，未做 Windows 实机验收；Windows 安装入口保持兼容。

## 卸载

- 关掉自启：`node bootstrap.mjs service uninstall`
- 删除整个目录即可；`data/` 里是账号登录态，删除前确认不再需要。
