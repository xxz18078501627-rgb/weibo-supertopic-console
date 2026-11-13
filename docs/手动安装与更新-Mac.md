# 制饼工坊 Mac 安装与更新

适用版本：`v1.1.4`

软件只在本机运行，网页地址固定为 <http://localhost:4178>。安装不需要管理员权限。

## 第一步：选对 Mac 安装包

打开“终端”，输入：

```bash
uname -m
```

- 显示 `arm64`：下载 `weibo-console-1.1.4-mac-arm64.dmg`。
- 显示 `x86_64`：下载 `weibo-console-1.1.4-mac-x64.dmg`。

下载页：<https://github.com/xxz18078501627-rgb/weibo-supertopic-console/releases/latest>

## 第二步：安装

1. 双击下载的 DMG。
2. 双击里面的“一键安装.command”。
3. 如果 macOS 提示无法验证开发者，右键“一键安装.command”，选择“打开”，再选“仍要打开”。
4. 也可以到“系统设置 → 隐私与安全性”，点击“仍要打开”。
5. 等待浏览器自动打开 <http://localhost:4178>。
6. 首次进入时输入激活码和访问口令。

以后每次开机，软件会自动在后台启动；不需要把安装窗口一直开着。

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
6. 页面重新打开后，再检查一次版本应为 `1.1.4`。

更新只替换程序，不会删除账号、文案、任务、记录、激活状态或微博登录目录。

## 校验安装包（可选）

把文件名换成实际下载的文件，在“终端”运行：

```bash
shasum -a 256 weibo-console-1.1.4-mac-arm64.dmg
```

结果与同平台 `.manifest.json` 中的 `installerSha256` 一致即可。校验不一致时不要安装，请重新下载。

## 数据位置与备份

```text
~/Library/Application Support/ZhibingStudio/data
```

备份前先暂停任务，然后把整个 `data` 文件夹复制到安全位置。里面包含登录状态和访问资料，不要上传网盘或发送给他人。

## 常用维护

下面的命令只适合服务无法自动启动时使用：

```bash
APP="$HOME/Library/Application Support/ZhibingStudio"
NODE="$APP/runtime/node/node"
"$NODE" "$APP/service.mjs" status
"$NODE" "$APP/service.mjs" restart
```

## 卸载

先暂停任务，再移除登录自启：

```bash
APP="$HOME/Library/Application Support/ZhibingStudio"
NODE="$APP/runtime/node/node"
"$NODE" "$APP/service.mjs" uninstall
```

确认不再需要账号和记录后，再删除 `~/Library/Application Support/ZhibingStudio`。删除 `data` 后无法恢复。

## 常见问题

- **无法验证开发者**：右键安装文件选择“打开”，再到“隐私与安全性”点击“仍要打开”。
- **页面打不开**：等待几秒后刷新，或运行上面的 `status` 命令。
- **端口 4178 被占用**：先确认是不是旧的本软件服务，不要强制结束未知程序。
- **更新按钮不可用**：暂停任务，结束扫码登录和人工验证后再试。
- **更新后页面异常**：保留 `data`，查看 `data/updates/update.log` 和 `data/service-error.log`。
