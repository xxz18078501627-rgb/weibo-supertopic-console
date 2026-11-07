# 安装说明（人和 agent 都看这一份）

## v1.1.0 新安装包

- Mac：按 `uname -m` 选择 `weibo-console-1.1.0-mac-arm64.dmg` 或 `weibo-console-1.1.0-mac-x64.dmg`，详细步骤见 [手动安装与更新-Mac](docs/手动安装与更新-Mac.md)。
- Windows x64：下载 `weibo-console-1.1.0-windows-x64.exe`，详细步骤见 [手动安装与更新-Windows](docs/手动安装与更新-Windows.md)。
- 安装包未签名时，按对应教程在 Gatekeeper / SmartScreen 手动放行。先核对官方 Release 清单中的 SHA256。
- 管理版程序、便携 Node、Chromium 和用户数据分开保存；以后更新只切换版本指针，保留 `data/`。
- `weibo-console-1.1.0.zip` 仍提供，用于旧版更新器过渡；新用户不需要解压 ZIP 或手动运行 `install.sh` / `install.ps1`。

以下旧版安装说明保留用于故障排查和历史版本。

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
2. Mac 用户在原安装目录运行 `node bootstrap.mjs update --check`，再运行 `node bootstrap.mjs update`。原始 Windows 安装脚本也有依赖启动缺陷，请按下节手动替换程序文件并重跑 install.ps1。
3. 服务重新启动后刷新页面。更新保留原 `data/`，账号、文案、任务、激活状态和浏览器登录目录无需重建；首次启动会自动补充数据库结构并迁移旧的待验证记录。手动暂停的任务由你决定何时继续。

新版本会把“待验证”与“待核对”分开计数；普通发帖、评论结果不明确时保留待核对并继续后续步骤，不自动重发。人工验证时仍会观察本次提交的成功结果。详细变化见 [CHANGELOG.md](CHANGELOG.md)。

Release 同时提供 `weibo-console-1.0.1.manifest.json`，其中包含安装包大小与 SHA256。Mac 可运行 `shasum -a 256 weibo-console-1.0.1.zip`，Windows 可运行 `Get-FileHash .\weibo-console-1.0.1.zip -Algorithm SHA256`，与 manifest 中的 `sha256` 对照。

原始 v1.0.1 发布时仅验证 macOS / Node 24 / Google Chrome；此次 Windows 修订与验收范围见下节。

## 2026-11-02：v1.0.1 同版本修复（已装旧包的 Windows 用户）

本次保持版本号 1.0.1，重新发布 ZIP 和 SHA256。旧包中的更新器遇到相同版本会直接退出，因此旧包上运行 `update` 或加 `--force` 均不能取得修复。

1. 从 v1.0.1 Release 重新下载 `weibo-console-1.0.1.zip`，解压到临时目录。
2. 如旧工作台仍能打开，先安全暂停任务并结束扫码及人工验证。关闭原前台终端中的服务；若为后台进程，先由 agent 核对其安装目录和空闲状态，再安全停止，不直接强制终止其他程序。
3. 将新包的程序文件复制到**原安装目录**。必须排除 `data/`、`node_modules/`、`.runtime/` 和 `.git/`；不要把新包的种子数据库覆盖到旧 `data/`，也不要另开一份安装后误以为原账号丢失。
4. 在原目录运行 `powershell -ExecutionPolicy Bypass -File install.ps1`。脚本会补齐依赖并安装自启；计划任务权限不足时自动使用当前用户的登录启动文件夹，无需管理员权限。
5. 确认 http://localhost:4178 可访问。已有激活状态和登录目录保留，不需要重新激活、扫码或执行任务来验收。

如使用便携 Node、在新终端中找不到 `node` 命令，可用 `.\.runtime\node\node.exe bootstrap.mjs doctor` 等同运行维护命令。修订版支持 `node bootstrap.mjs update --force` 重装相同版本，但此选项不适用于尚未替换程序文件的旧版更新器。

Windows CI 使用真实 Windows runner 验证便携 Node 下载、依赖安装、两种登录自启方式、浏览器激活页及服务重启/卸载；不代表对所有用户电脑、杀毒软件和网络环境逐一验收。

## 卸载

- 关掉自启：`node bootstrap.mjs service uninstall`
- 删除整个目录即可；`data/` 里是账号登录态，删除前确认不再需要。
