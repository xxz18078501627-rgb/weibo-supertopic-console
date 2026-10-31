# 安装说明（人和 agent 都看这一份）

## 你需要什么

- 一台 Mac 或 Windows 电脑
- 能上网
- 一个激活码（找管理员要）

不需要提前装 Node，不需要管理员权限。

## Mac

1. 下载并解压 `weibo-console-<版本>.zip`。
2. 打开「终端」，`cd` 到解压出来的目录。
3. 运行：`bash install.sh`

## Windows

1. 下载并解压 `weibo-console-<版本>.zip`。
2. 在解压目录空白处按住 Shift 右键 →「在此处打开 PowerShell 窗口」。
3. 运行：`powershell -ExecutionPolicy Bypass -File install.ps1`

## 第一次使用

1. 浏览器打开 **http://localhost:4178**。
2. 页面会停在激活页，粘贴管理员给你的**激活码**。
3. 用管理员给你的**访问口令**登录。
4. 账号页点「添加账号并扫码登录」，用自己的微博扫码；之后所有操作都在本机浏览器里完成。

## 常见问题

- **端口 4178 被占用**：说明已经有一份在跑，直接打开 http://localhost:4178 即可。
- **页面打不开**：`node bootstrap.mjs doctor` 看哪项不通过；缺浏览器会自动装 Chromium。
- **手机打开不了**：确认同一 Wi-Fi；点页面右上角「手机访问」扫码。
- **更新**：`node bootstrap.mjs update`（账号、文案、激活状态都会保留）。

## 卸载

- 关掉自启：`node bootstrap.mjs service uninstall`
- 删除整个目录即可；`data/` 里是账号登录态，删除前确认不再需要。
