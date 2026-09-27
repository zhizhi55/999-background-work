# 请求托管后台（个人部署模板）

这是一个可独立部署的 Cloudflare Worker 模板，只包含请求托管、D1 结果存储、Queue 消费和 Web Push。

它不包含聊天网页源码、角色资料、聊天记录或任何预置 API Key。每位用户部署后拥有独立的 Worker、D1、Queue、密钥和 Cloudflare 用量。

## 一键部署

将下方地址中的 `YOUR_PUBLIC_REPOSITORY_URL` 替换为这个模板发布后的公开 GitHub/GitLab 仓库地址：

```text
https://deploy.workers.cloudflare.com/?url=YOUR_PUBLIC_REPOSITORY_URL
```

Cloudflare 会在部署过程中自动创建并绑定 D1 数据库和 Queue。部署页面会要求填写：

- `ACCESS_TOKEN`：网页连接该后台使用的个人访问令牌。
- `VAPID_PUBLIC_KEY`：Web Push 公钥。
- `VAPID_PRIVATE_KEY`：Web Push 私钥。

这三项可直接在聊天网页的“设置 → 后端后台功能 → 部署自己的后台”中生成，无需安装 Node.js、Wrangler 或 PowerShell。

部署完成后，把 Cloudflare 返回的 `workers.dev` 地址和同一个 `ACCESS_TOKEN` 填回网页，点击“测试并保存”。

## 本地开发（仅模板维护者）

```bash
npm install
npm run db:local
npm run dev
```

手动部署：

```bash
npm run deploy
```

## 数据与密钥

- AI API Key 仅随用户主动发起的单次 HTTPS 请求进入其个人 Queue，不写入 D1。
- 原始 AI 响应临时保存在用户自己的 D1，供网页恢复后领取。
- `ACCESS_TOKEN`、`VAPID_PRIVATE_KEY` 不应公开或提交到仓库。
- 不应让多名用户共用同一个 Worker 或访问令牌。
