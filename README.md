# 微博超话多账号自动化控制台

这是一个只在本机运行的控制台。它使用独立 Chrome 登录目录管理多个微博账号，并按“轮次 → 超话 → 账号 → 操作段”的顺序串行执行签到、文字发帖和评论。

## 安装（Mac / Windows 通用）

1. 从 GitHub Releases 下载 `weibo-console-<版本>.zip` 并解压。
2. Mac：`bash install.sh`；Windows：`powershell -ExecutionPolicy Bypass -File install.ps1`。
3. 打开 http://localhost:4178 ，粘贴管理员提供的**激活码**，再用管理员给的**访问口令**登录。

安装脚本会自动准备便携 Node 24、依赖和浏览器；详细步骤与排障见 [INSTALL.md](INSTALL.md)，给 agent 的说明见 [AGENTS.md](AGENTS.md)。

## 更新与维护

```bash
node bootstrap.mjs update          # 更新程序，保留 data/（账号、文案、激活状态）
node bootstrap.mjs doctor          # 体检：Node / 依赖 / 浏览器 / 端口 / 网络 / 激活
node bootstrap.mjs service install # 开机自启（Mac launchd / Windows 计划任务）
```

## 开发

```bash
npm install
npm start        # 开发模式：不校验激活（WEIBO_CONSOLE_LICENSE=off）
```

浏览器打开 `http://localhost:4178`。同一 Wi-Fi 下的手机使用启动日志显示的局域网地址。访问口令首次启动时生成在 `data/access-token`，也可以运行：

```bash
npm run token
```

进入网页后：

1. 点击“添加账号并扫码登录”，在本机窗口扫码；程序自动确认登录并使用微博昵称命名。已有有效登录会直接复用。
2. 添加超话名称和网页链接（默认固定为苏新皓）。
3. 在共享文案库录入文字，所有账号随机共用；评论至少两条不同的原文。
4. 在任务页调整操作段、数量、筛选策略和间隔；发帖和评论可分别添加随机表情、顺序数字并选择位置。

程序关闭 Chrome 或切换账号时会保留各自的登录目录，不会主动退出微博。请勿复制、同步或提交 `data/`，其中包含可用于登录的浏览器资料。

## 激活与分发

- 维护者用 `npm run license -- --user 张三 --token 你的口令` 生成激活码（私钥只在维护者本机 `~/.weibo-console/license-key.pem`）。
- 分发时把仓库地址给对方的 agent，激活码与访问口令单独发给本人；安装程序不会显示口令。
- 未激活时服务只放行激活页，业务接口一律 `license_required`。

## 运行规则

- 同时只启动一个自动化 Chrome，账号按超话依次处理。
- “仅零评论”在扫描到评论数为零时立即提交，不做第二次检查。
- 没有符合条件的帖子时持续等待，直到出现候选或你暂停、停止任务。
- 发布结果无法确认时标为“待核对”并暂停，不自动重复发送。
- 登录失效、验证码、分区不存在或页面结构无法识别时暂停，保留进度。
- 用户手动暂停或停止的任务不会在重启后自动继续；意外中断的任务会自动恢复。中断时正在提交的操作会转为待核对。
- 发帖与评论的数字序号独立保存，跨账号、任务和重启延续。

## 登录自启

安装脚本默认安装自启；也可手动：

```bash
npm run install-service     # Mac: launchd；Windows: 计划任务
npm run uninstall-service
```

## 测试

```bash
npm test
npm run test:e2e
```
