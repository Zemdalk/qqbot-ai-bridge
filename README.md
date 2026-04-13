# qqbot-codex-bridge

QQ 官方机器人桥接服务，支持 `Codex ACP` 与 `Claude ACP` 双后端（不依赖 OpenClaw）。

## 功能

- 私聊消息：自动转给当前模型后端处理
- 群聊消息：仅在 `@机器人` 时触发（依赖 `GROUP_AT_MESSAGE_CREATE`）
- 按用户/群会话隔离，维护后端会话上下文
- 支持重启后恢复会话上下文（基于本地 `sessionId` 持久化）
- 支持思考/工具进度转发（可关闭）
- 长消息自动分片发送，避免截断

## 准备

1. Node.js >= 18
2. 配置 `.env`（从 `.env.example` 复制）
3. 根据后端准备运行环境：
   - `MODEL_PROVIDER=codex`：确保本机可以运行 `npx -y @zed-industries/codex-acp`
   - `MODEL_PROVIDER=claude`：确保本机可运行 `npx -y @agentclientprotocol/claude-agent-acp`

## 启动

```bash
cd /home/pi/qqbot-codex-bridge
cp .env.example .env
# 编辑 .env，填入 QQBOT_APP_SECRET
npm install
npm run start
```

## 核心环境变量

- `QQBOT_APP_ID` / `QQBOT_APP_SECRET`：QQ 官方机器人凭证
- `QQBOT_INTENTS`：建议默认 `GROUP_AT_MESSAGE_CREATE,C2C_MESSAGE_CREATE`
- `SHOW_THOUGHTS`：是否转发思考/工具进度
- `THOUGHT_PREFIX`：思考消息前缀；留空可不加前缀
- `MAX_REPLY_CHARS`：单条回复最大字符数
- `MODEL_PROVIDER`：模型后端，`codex` / `claude` / `claude-acp` / `claude-cli`
- `AGENT_COMMAND` / `AGENT_ARGS`：Codex ACP Agent 启动命令（`MODEL_PROVIDER=codex`）
- `CLAUDE_ACP_COMMAND` / `CLAUDE_ACP_ARGS`：Claude ACP Agent 启动命令（`MODEL_PROVIDER=claude` 或 `claude-acp`）
- `CLAUDE_COMMAND` / `CLAUDE_MODEL`：Claude CLI 启动命令和模型（`MODEL_PROVIDER=claude-cli`）
- `SESSION_STATE_PATH`：会话持久化文件（默认 `/home/pi/qqbot-codex-bridge/session-state.json`）
- `MAX_PROMPT_TIMEOUT_MS`：单次模型调用硬上限（默认 120000ms）

## 行为说明

- 私聊：默认直接触发。
- 群聊：通过 QQ 官方 `GROUP_AT_MESSAGE_CREATE` 事件触发，默认已是 @ 触发。
- 内置命令：
  - `/new`：关闭当前会话上下文，下一条消息将使用全新会话。
  - `/help`：显示帮助信息。
  - `/status`：
    - `codex` 模式：显示本地 Codex 日志额度状态。
    - `claude-acp` 模式：显示当前 Claude ACP Agent 配置。
    - `claude-cli` 模式：显示当前 Claude CLI 配置摘要。
  - `/ping`：连通性测试。
  - `/whoami`：查看当前会话信息。

## Claude + GLM 配置示例

先安装 Claude Code：

```bash
sudo /usr/local/nodejs/bin/npm install -g @anthropic-ai/claude-code
```

然后配置 `~/.claude/settings.json`（示例）：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your_glm_api_key",
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "ANTHROPIC_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.5-air"
  },
  "model": "opus"
}
```

并在桥接 `.env` 中切换到 Claude ACP：

```bash
MODEL_PROVIDER=claude
CLAUDE_ACP_COMMAND=/usr/local/nodejs/bin/claude-agent-acp
CLAUDE_ACP_ARGS=
```

## systemd（推荐）

`/etc/systemd/system/qqbot-codex-bridge.service`:

```ini
[Unit]
Description=QQBot Codex Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/qqbot-codex-bridge
EnvironmentFile=/home/pi/qqbot-codex-bridge/.env
ExecStart=/usr/bin/node /home/pi/qqbot-codex-bridge/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now qqbot-codex-bridge
sudo systemctl status qqbot-codex-bridge
journalctl -u qqbot-codex-bridge -f
```
