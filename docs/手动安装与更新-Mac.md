# 制饼工坊 Mac 手动安装与更新

本文对应制饼工坊 v1.1.0。软件仍在本机运行，浏览器访问地址是 <http://localhost:4178>。安装包由 GitHub Release 提供，没有 Apple 开发者签名时，macOS 会要求手动放行。

## 1. 下载正确的安装包

先查看 Mac 芯片类型：

```bash
uname -m
```

- 显示 `arm64`：下载 `weibo-console-1.1.0-mac-arm64.dmg`。
- 显示 `x86_64`：下载 `weibo-console-1.1.0-mac-x64.dmg`。

同时下载同一平台的清单文件：

- Apple 芯片：`weibo-console-1.1.0-mac-arm64.manifest.json`
- Intel Mac：`weibo-console-1.1.0-mac-x64.manifest.json`

官方 Release 地址：<https://github.com/xxz18078501627-rgb/weibo-supertopic-console/releases>

## 2. 校验安装包

在下载目录打开“终端”，把文件名替换成实际下载的文件：

```bash
shasum -a 256 weibo-console-1.1.0-mac-arm64.dmg
```

清单文件中的 `installerSha256` 应与命令输出完全一致。校验不一致的文件不要打开或安装。

## 3. 安装

1. 双击下载的 `.dmg`。
2. 在打开的磁盘中双击“一键安装.command”。
3. 如果 macOS 阻止打开，右键“一键安装.command”，选择“打开”，再选择“仍要打开”；也可以在“系统设置 → 隐私与安全性”中点击“仍要打开”。
4. 安装程序会准备本地服务、登录自启、便携 Node 和 Playwright Chromium，并在健康检查通过后打开 <http://localhost:4178>。
5. 第一次打开会显示激活页。激活码、访问口令和微博账号登录由你本人完成。

安装不需要管理员权限，也不会安装 Electron 或独立 App。

## 4. 文件和数据位置

程序安装目录：

```text
~/Library/Application Support/ZhibingStudio
```

主要目录：

```text
~/Library/Application Support/ZhibingStudio/
├── versions/            各程序版本
├── runtime/node/        便携 Node
├── runtime/ms-playwright/  Chromium
├── data/                用户数据
├── current.json         当前版本指针
├── launcher.mjs         固定启动入口
├── bootstrap.mjs        固定维护入口
└── service.mjs          固定服务入口
```

账号、文案、任务、记录、激活状态、数据库和微博浏览器登录目录都在 `data/`。更新不会覆盖或删除 `data/`。需要备份时先安全停止任务，再完整复制 `data/`；备份中包含登录态和访问资料，不要上传网盘或提交到 GitHub。

## 5. 打开、停止、启动和卸载

便携 Node 的路径是：

```bash
APP="$HOME/Library/Application Support/ZhibingStudio"
NODE="$APP/runtime/node/node"
```

查看自启状态：

```bash
"$NODE" "$APP/service.mjs" status
```

安全停止：

```bash
"$NODE" "$APP/service.mjs" stop
```

重新启动并等待健康检查：

```bash
"$NODE" "$APP/service.mjs" restart
```

重新安装当前用户登录自启：

```bash
"$NODE" "$APP/service.mjs" install
```

移除登录自启但保留程序和数据：

```bash
"$NODE" "$APP/service.mjs" uninstall
```

确认服务版本：

```bash
curl -s http://127.0.0.1:4178/api/health
```

返回 JSON 中的 `version` 是正在运行的版本。

## 6. 在页面中更新

1. 先暂停工作台和转赞评任务，结束扫码登录和人工验证。
2. 点击左侧栏底部“更新”。
3. 点“检查更新”。页面只显示当前 Mac 架构对应的版本。
4. 点“下载更新”。下载完成后会显示 SHA256 校验通过。
5. 保持“更新后重启”开启，点“更新并重启”。页面会等待新版本健康检查通过后自动刷新。
6. 关闭“更新后重启”时只切换版本指针，当前服务继续运行旧代码；下次启动服务时使用新版。

有任务、扫码登录、人工验证或浏览器占用时，下载仍可进行，但“更新”按钮会禁用。先处理页面提示后再应用更新。

页面中的命令区是只读等效命令，可用“复制命令”取得后手动执行。实际页面更新使用结构化参数，不会把命令文本交给 Shell。

## 7. 命令行手动更新

先替换成 Release 中实际存在的新版本号：

```bash
APP="$HOME/Library/Application Support/ZhibingStudio"
NODE="$APP/runtime/node/node"
"$NODE" "$APP/bootstrap.mjs" update --platform mac-arm64 --version 1.2.0 --restart
```

Intel Mac 把 `mac-arm64` 改为 `mac-x64`。只检查版本：

```bash
"$NODE" "$APP/bootstrap.mjs" update --check --platform mac-arm64
```

只切换版本、不在当前时间重启：

```bash
"$NODE" "$APP/bootstrap.mjs" update --platform mac-arm64 --version 1.2.0 --no-restart
```

手动更新也会下载、校验摘要、创建数据库快照并保留 `data/`。更新日志位于：

```text
~/Library/Application Support/ZhibingStudio/data/updates/update.log
```

## 8. 更新失败与手动回滚

如果新版健康检查失败，更新助手会自动恢复旧版本指针并重新启动旧版。查看更新日志和服务错误日志：

```bash
APP="$HOME/Library/Application Support/ZhibingStudio"
sed -n '1,200p' "$APP/data/updates/update.log"
tail -n 120 "$APP/data/service-error.log"
```

查看可以回滚的较低版本：

```bash
APP="$HOME/Library/Application Support/ZhibingStudio"
NODE="$APP/runtime/node/node"
"$NODE" "$APP/bootstrap.mjs" rollback --check
```

执行回滚并重启：

```bash
"$NODE" "$APP/bootstrap.mjs" rollback
```

回滚只修改 `current.json` 和正在运行的版本，不改 `data/`。数据库更新前的快照位于 `data/backups/`。

## 9. 常见问题

- **提示“无法验证开发者”**：右键安装命令选择“打开”，再到“系统设置 → 隐私与安全性 → 仍要打开”。
- **页面打不开**：先运行 `service.mjs status`，再看 `data/service-error.log`。
- **提示端口 4178 被占用**：先确认为本软件旧服务，并确认没有任务后再 `restart`；不要强制结束未知进程。
- **更新按钮禁用**：查看弹窗中的原因，通常是任务、扫码或人工验证仍在运行。
- **SHA256 不一致**：删除下载文件，从官方 Release 重新下载；不要安装。
- **安装中断**：不要删除 `data/`。重新运行 DMG 中的一键安装命令，安装器会复用数据目录。

本教程不包含也不会读取激活码、访问口令或微博登录资料。
