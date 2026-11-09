# 制饼工坊安装说明

适用版本：`v1.1.2`

## 先选对安装包

| 电脑 | 下载文件 |
| --- | --- |
| Apple 芯片 Mac（M1/M2/M3/M4） | `weibo-console-1.1.2-mac-arm64.dmg` |
| Intel 芯片 Mac | `weibo-console-1.1.2-mac-x64.dmg` |
| Windows 10/11 x64 | `weibo-console-1.1.2-windows-x64.exe` |

Release 下载页：<https://github.com/xxz18078501627-rgb/weibo-supertopic-console/releases/latest>

不知道 Mac 是哪一种芯片时，打开“终端”输入：

```bash
uname -m
```

显示 `arm64` 选 Apple 芯片版，显示 `x86_64` 选 Intel 版。

## Mac 安装

1. 双击下载的 `.dmg`。
2. 双击“一键安装.command”。
3. 如果系统阻止打开，右键该文件，选择“打开”，再选择“仍要打开”。
4. 等待终端显示安装完成，浏览器会自动打开 <http://localhost:4178>。
5. 首次进入时输入激活码和访问口令。

安装不需要管理员权限。

## Windows 安装

1. 双击下载的 `.exe`。
2. 如果出现 SmartScreen，点击“更多信息”，再点击“仍要运行”。
3. 按向导完成安装，不需要管理员权限。
4. 安装完成后浏览器会自动打开 <http://localhost:4178>。
5. 首次进入时输入激活码和访问口令。

## 安装后第一次使用

1. 在激活页粘贴管理员提供的激活码。
2. 使用管理员提供的访问口令进入。
3. 打开“账号”，点击“添加账号并扫码登录”。
4. 在打开的 Chrome 窗口中扫码登录微博。
5. 添加文案、配置任务后即可开始。

## 以后如何更新

1. 暂停所有任务，结束扫码登录和人工验证。
2. 点击页面左侧“更新”。
3. 点击“检查更新”和“下载更新”。
4. 保持“更新后重启”开启，点击“更新并重启”。

更新只替换程序，不会删除账号、文案、任务、记录、激活状态和微博登录目录。

## 校验安装包（可选）

Release 同时提供对应的 `.manifest.json`。

Mac：

```bash
shasum -a 256 weibo-console-1.1.2-mac-arm64.dmg
```

Windows PowerShell：

```powershell
Get-FileHash .\weibo-console-1.1.2-windows-x64.exe -Algorithm SHA256
```

输出值应与清单中的 `installerSha256` 完全一致。

## 常见问题

- **安装包未签名**：这是预期情况，按上面的 Gatekeeper/SmartScreen 步骤放行一次。
- **页面打不开**：等待服务启动完成后刷新，或查看安装目录的 `data/service-error.log`。
- **端口 4178 被占用**：先确认是否为本软件的旧服务，不要结束未知程序。
- **中文或空格路径**：当前安装器支持这类路径。
- **更新失败**：保留 `data` 文件夹，查看 `data/updates/update.log` 和 `data/service-error.log`。

详细步骤见 [Mac 教程](docs/手动安装与更新-Mac.md) 和 [Windows 教程](docs/手动安装与更新-Windows.md)。
