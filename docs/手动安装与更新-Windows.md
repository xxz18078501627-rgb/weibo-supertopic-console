# 制饼工坊 Windows 安装与更新

适用版本：`v1.1.3`，支持 Windows 10/11 x64。

软件只在本机运行，网页地址固定为 <http://localhost:4178>。安装不需要管理员权限。

## 第一步：下载安装包

下载：

```text
weibo-console-1.1.3-windows-x64.exe
```

下载页：<https://github.com/xxz18078501627-rgb/weibo-supertopic-console/releases/latest>

## 第二步：安装

1. 双击下载的 EXE。
2. 如果 Windows 提示“Windows 已保护你的电脑”，点击“更多信息”，再点击“仍要运行”。
3. 按向导完成安装。默认目录为 `%LOCALAPPDATA%\ZhibingStudio`。
4. 安装完成后浏览器会自动打开 <http://localhost:4178>。
5. 首次进入时输入激活码和访问口令。

安装器会自动准备运行环境、Chrome、后台服务和当前用户的登录自启。

## 第三步：登录微博

1. 打开“账号”。
2. 点击“添加账号并扫码登录”。
3. 在弹出的 Chrome 窗口中扫码。
4. 登录成功后，账号会自动保存到本机。

## 如何更新

1. 暂停工作台和转赞评任务，结束扫码和人工验证。
2. 打开 <http://localhost:4178>，点击左侧“更新”。
3. 点击“检查更新”。
4. 点击“下载更新”，等待下载和校验完成。
5. 保持“更新后重启”开启，点击“更新并重启”。
6. 页面重新打开后，再检查一次版本应为 `1.1.3`。

更新只替换程序，不会删除账号、文案、任务、记录、激活状态或微博登录目录。

## 校验安装包（可选）

在安装包所在目录打开 PowerShell：

```powershell
Get-FileHash .\weibo-console-1.1.3-windows-x64.exe -Algorithm SHA256
```

结果与同平台 `.manifest.json` 中的 `installerSha256` 一致即可。校验不一致时不要安装，请重新下载。

## 数据位置与备份

```text
%LOCALAPPDATA%\ZhibingStudio\data
```

备份前先暂停任务，然后把整个 `data` 文件夹复制到安全位置。里面包含登录状态和访问资料，不要上传网盘或发送给他人。

## 常用维护

只有页面打不开时再使用：

```powershell
$App = Join-Path $env:LOCALAPPDATA 'ZhibingStudio'
$Node = Join-Path $App 'runtime\node\node.exe'
& $Node (Join-Path $App 'service.mjs') status
& $Node (Join-Path $App 'service.mjs') restart
```

## 卸载

打开“设置 → 应用 → 已安装的应用 → 制饼工坊 → 卸载”。卸载不会自动删除 `data`；确认不再需要数据时再手动删除。

## 常见问题

- **SmartScreen 拦截**：点击“更多信息”，再点击“仍要运行”。安装包未做 Windows 代码签名。
- **开始菜单找不到**：打开 `%LOCALAPPDATA%\ZhibingStudio`，或从浏览器访问 <http://localhost:4178>。
- **页面打不开**：等待几秒后刷新，或运行上面的 `status` 命令。
- **端口 4178 被占用**：先确认是不是旧的本软件服务，不要强制结束未知程序。
- **更新按钮不可用**：暂停任务，结束扫码登录和人工验证后再试。
- **更新后页面异常**：保留 `data`，查看 `data\updates\update.log` 和 `data\service-error.log`。
