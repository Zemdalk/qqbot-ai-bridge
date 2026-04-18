# qqbot-ai-bridge

将 QQ 官方机器人接入 AI 编程智能体（Claude Code / Codex）的桥接服务，通过 [Agent Communication Protocol (ACP)](https://agentcommunicationprotocol.dev/) 与后端通信。

## 功能

- **私聊**：消息自动转发给 AI 后端处理并回复
- **群聊**：仅 @ 机器人时触发（需 `GROUP_AT_MESSAGE_CREATE` Intent）
- 按用户/群隔离会话上下文，支持重启后恢复（基于本地 `session-state.json`）
- 支持思考过程/工具进度转发（可关闭）
- 长消息自动分片，避免 QQ 截断
- 内置命令：`/new` `/help` `/status` `/ping` `/whoami`

## 支持的后端

| `MODEL_PROVIDER` | 说明 |
|---|---|
| `codex` | 通过 ACP 调用 [Zed Codex](https://github.com/zed-industries/zed) |
| `claude` / `claude-acp` | 通过 ACP 调用 [claude-agent-acp](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) |
| `claude-cli` | 直接调用 `claude` CLI，stream-json 模式（兜底方案） |

## 快速开始

### 1. 前置条件

- Node.js >= 18
- 在 [QQ 开放平台](https://bot.q.qq.com/) 创建机器人，获取 `AppID` 和 `AppSecret`
- 根据所选后端安装对应工具：
  - `codex`：确保可执行 `npx -y @zed-industries/codex-acp`
  - `claude-acp`：确保可执行 `npx -y @agentclientprotocol/claude-agent-acp`
  - `claude-cli`：安装 [Claude Code](https://docs.anthropic.com/claude-code)

### 2. 安装

```bash
git clone https://github.com/Zemdalk/qqbot-ai-bridge.git
cd qqbot-ai-bridge
npm install
cp .env.example .env
```

### 3. 配置

编辑 `.env`，至少填写：

```env
QQBOT_APP_ID=your_app_id
QQBOT_APP_SECRET=your_app_secret
MODEL_PROVIDER=claude   # 或 codex / claude-cli
```

完整配置项见 [`.env.example`](.env.example)。

### 4. 启动

```bash
npm run start
```

## systemd 部署（推荐）

```ini
# /etc/systemd/system/qqbot-ai-bridge.service
[Unit]
Description=QQBot AI Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/path/to/qqbot-ai-bridge
EnvironmentFile=/path/to/qqbot-ai-bridge/.env
ExecStart=/usr/bin/node /path/to/qqbot-ai-bridge/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now qqbot-ai-bridge
journalctl -u qqbot-ai-bridge -f
```

## 使用 Claude Code + GLM 替代 Anthropic API

如果你想用智谱 GLM 替代 Anthropic 官方 API（通过 Claude Code 的兼容接口），在 `~/.claude/settings.json` 中配置：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your_glm_api_key",
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
    "ANTHROPIC_MODEL": "glm-4-plus",
    "API_TIMEOUT_MS": "300000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

然后在 `.env` 中选择 Claude ACP 后端：

```env
MODEL_PROVIDER=claude-acp
CLAUDE_ACP_COMMAND=claude-agent-acp
```

## 内置命令

| 命令 | 说明 |
|---|---|
| `/new` | 重置当前会话上下文 |
| `/help` | 查看帮助 |
| `/status` | 查看后端状态/额度 |
| `/ping` | 连通性测试 |
| `/whoami` | 查看当前会话信息 |

## 主要环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `QQBOT_APP_ID` | QQ 机器人 AppID | 必填 |
| `QQBOT_APP_SECRET` | QQ 机器人 AppSecret | 必填 |
| `MODEL_PROVIDER` | 后端类型 | `codex` |
| `MAX_REPLY_CHARS` | 单条回复最大字符数 | `900` |
| `SHOW_THOUGHTS` | 是否转发思考/工具进度 | `true` |
| `IDLE_TIMEOUT_MS` | 会话空闲超时（ms） | `86400000` |
| `PRIVATE_WHITELIST` | 私聊白名单（逗号分隔 OpenID，空=不限） | 空 |
| `GROUP_WHITELIST` | 群聊白名单（逗号分隔，空=不限） | 空 |

完整列表见 `.env.example`。

## License

MIT
