# 制饼工坊 Windows 手动安装与更新

本文对应制饼工坊 v1.1.0 x64 版。软件在本机运行，浏览器访问地址是 <http://localhost:4178>。安装不需要管理员权限。

## 1. 下载和校验

下载：

```text
weibo-console-1.1.0-windows-x64.exe
weibo-console-1.1.0-windows-x64.manifest.json
```

官方 Release 地址：<https://github.com/xxz18078501627-rgb/weibo-supertopic-console/releases>

在安装包所在目录打开 PowerShell：

```powershell
Get-FileHash .\weibo-console-1.1.0-windows-x64.exe -Algorithm SHA256
```

清单文件中的 `installerSha256` 应与输出中的 `Hash` 完全一致。校验不一致时不要运行安装包。

本轮 Windows 安装包为 x64；ARM64 Windows 尚未提供原生安装包。

## 2. 安装

1. 双击 `.exe`。
2. 如果 Windows SmartScreen 提示“Windows 已保护你的电脑”，点“更多信息”，再点“仍要运行”。
3. 按向导安装。默认目录是 `%LOCALAPPDATA%\ZhibingStudio`，不要求管理员权限。
4. 安装器会配置当前用户登录自启、开始菜单入口、便携 Node、Playwright Chromium 和本地服务。
5. 安装完成后会打开 <http://localhost:4178>。首次打开显示激活页；激活、口令和微博登录由你本人完成。

## 从 v1.0.1 升级

v1.0.1 是通过 ZIP 解压运行的，和本文前面说明的全新 EXE 安装不是同一套目录。已有账号、文案、任务和激活状态时，优先在原 v1.0.1 目录原地升级，不要直接安装 EXE 后误以为旧数据会自动迁移。

### 方式一：在 v1.0.1 原目录升级

先暂停工作台和转赞评任务，结束扫码与人工验证，然后备份整个 `data\`：

```powershell
$Old = "C:\path\to\原来的-weibo-console-v1.0.1"
$Backup = Join-Path $env:USERPROFILE ("Documents\ZhibingStudio-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Force $Backup | Out-Null
Copy-Item (Join-Path $Old "data") (Join-Path $Backup "data") -Recurse -Force
Set-Location $Old
```

停止旧服务并检查、执行更新：

```powershell
.\runtime\node\node.exe bootstrap.mjs service stop
.\runtime\node\node.exe bootstrap.mjs update --check
.\runtime\node\node.exe bootstrap.mjs update
```

更新会保留原目录中的 `data\`，完成后仍使用原来的目录形态。首次启动会自动补充数据库结构。确认页面可以打开后，可运行：

```powershell
Invoke-RestMethod "http://127.0.0.1:4178/api/health"
```

返回的 `version` 应为升级后的版本。以后可以继续使用页面的“更新”入口，不必每次重新安装 EXE。

### 方式二：迁移到新的 EXE 稳定目录

如果希望改用新的 `%LOCALAPPDATA%\ZhibingStudio` 管理版，必须在**第一次运行新安装包之前**把旧数据复制过去：

```powershell
$Old = "C:\path\to\原来的-weibo-console-v1.0.1"
$Dest = Join-Path $env:LOCALAPPDATA "ZhibingStudio\data"
New-Item -ItemType Directory -Force $Dest | Out-Null
Copy-Item (Join-Path $Old "data\*") $Dest -Recurse -Force
```

然后按本文前面的步骤安装 EXE。安装器检测到 `console.sqlite` 已存在时，不会用空白种子库覆盖它。

如果新安装包已经先运行并创建了新数据库，不要直接覆盖：先结束新服务、完整备份 `$Dest`，再停止旧服务，最后将旧 `data\` 完整复制回来并重新启动。不要把两个数据库的零散文件混合复制。

## 3. 目录和数据位置

默认安装目录：

```text
%LOCALAPPDATA%\ZhibingStudio
```

主要目录：

```text
%LOCALAPPDATA%\ZhibingStudio\
├── versions\            各程序版本
├── runtime\node\        便携 Node
├── runtime\ms-playwright\  Chromium
├── data\                用户数据
├── current.json         当前版本指针
├── launcher.mjs         固定启动入口
├── bootstrap.mjs        固定维护入口
└── service.mjs          固定服务入口
```

账号、文案、任务、记录、激活状态、数据库和微博浏览器登录目录都在 `data\`。更新不会覆盖或删除 `data\`。备份时先安全停止任务，再复制整个 `data\`；其中包含登录态和访问资料，不要共享或上传。

## 4. 打开、停止、启动和卸载

在 PowerShell 中设置路径：

```powershell
$App = Join-Path $env:LOCALAPPDATA 'ZhibingStudio'
$Node = Join-Path $App 'runtime\node\node.exe'
```

查看自启状态：

```powershell
& $Node (Join-Path $App 'service.mjs') status
```

安全停止：

```powershell
& $Node (Join-Path $App 'service.mjs') stop
```

重新启动并等待健康检查：

```powershell
& $Node (Join-Path $App 'service.mjs') restart
```

重新安装当前用户登录自启：

```powershell
& $Node (Join-Path $App 'service.mjs') install
```

移除登录自启但保留程序和数据：

```powershell
& $Node (Join-Path $App 'service.mjs') uninstall
```

确认运行版本：

```powershell
Invoke-RestMethod 'http://127.0.0.1:4178/api/health' | ConvertTo-Json -Depth 4
```

返回 JSON 中的 `version` 是正在运行的版本。

## 5. 在页面中更新

1. 暂停工作台和转赞评任务，结束扫码登录与人工验证。
2. 点击左侧栏底部“更新”，手机窄屏使用页头“更新”按钮。
3. 点“检查更新”。只显示 `windows-x64` 的版本。
4. 点“下载更新”，等待 SHA256 校验完成。
5. 保持“更新后重启”开启，点“更新并重启”。页面在检测到新版本和新的服务进程后刷新。
6. 关闭“更新后重启”时只切换版本指针；当前服务运行旧代码，下次启动使用新版。

任务、扫码、人工验证或浏览器占用时，允许预先下载，但不能应用更新。命令区只读，可复制后在 PowerShell 手动执行；应用内更新使用结构化参数，不经过 Shell 拼接。

## 6. 命令行手动更新

把 `1.2.0` 替换为 Release 中实际版本：

```powershell
$App = Join-Path $env:LOCALAPPDATA 'ZhibingStudio'
$Node = Join-Path $App 'runtime\node\node.exe'
& $Node (Join-Path $App 'bootstrap.mjs') update --platform windows-x64 --version 1.2.0 --restart
```

只检查：

```powershell
& $Node (Join-Path $App 'bootstrap.mjs') update --check --platform windows-x64
```

只切换版本、不在当前时间重启：

```powershell
& $Node (Join-Path $App 'bootstrap.mjs') update --platform windows-x64 --version 1.2.0 --no-restart
```

更新日志：

```powershell
Get-Content (Join-Path $App 'data\updates\update.log') -Tail 200
```

服务错误日志：

```powershell
Get-Content (Join-Path $App 'data\service-error.log') -Tail 120
```

## 7. 更新失败与手动回滚

新版健康检查失败时，更新助手会恢复旧版本指针并重新启动旧版。需要手动查看可回滚版本时：

```powershell
$App = Join-Path $env:LOCALAPPDATA 'ZhibingStudio'
$Node = Join-Path $App 'runtime\node\node.exe'
& $Node (Join-Path $App 'bootstrap.mjs') rollback --check
```

执行回滚并重启：

```powershell
& $Node (Join-Path $App 'bootstrap.mjs') rollback
```

回滚只修改 `current.json` 和正在运行的版本，不修改 `data\`。数据库更新前快照保存在 `data\backups\`。

## 8. 卸载

优先从“设置 → 应用 → 已安装的应用 → 制饼工坊 → 卸载”执行。卸载会停止当前用户服务并删除登录自启。

如需先手动移除自启：

```powershell
$App = Join-Path $env:LOCALAPPDATA 'ZhibingStudio'
$Node = Join-Path $App 'runtime\node\node.exe'
& $Node (Join-Path $App 'service.mjs') uninstall
```

需要保留数据时，卸载前复制 `data\`。未经确认不要删除浏览器登录目录。

## 9. 常见问题

- **SmartScreen 拦截**：点“更多信息 → 仍要运行”。安装包本轮未做 Authenticode 签名。
- **开始菜单找不到**：重新运行安装器的开始菜单步骤，或在资源管理器打开 `%LOCALAPPDATA%\ZhibingStudio`。
- **页面打不开**：运行 `service.mjs status`，再查看 `data\service-error.log`。
- **提示端口 4178 被占用**：先确认是否为已有服务；确认没有任务后才安全停止或重启，不要强制结束未知进程。
- **更新按钮禁用**：查看弹窗原因，通常是任务、扫码或验证仍占用。
- **SHA256 不一致**：删除文件并从官方 Release 重新下载。
- **中文或空格路径**：启动器和安装器支持 Unicode 路径；仍失败时查看 `service-error.log`，不要移动或删除 `data\`。

本教程不包含也不会读取激活码、访问口令或微博登录资料。
