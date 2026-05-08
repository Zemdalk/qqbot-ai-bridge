import 'dotenv/config';
import fs from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { Bot, ReceiverMode, segment as qqSegment } from 'qq-official-bot';

const config = {
  appId: process.env.QQBOT_APP_ID || '',
  appSecret: process.env.QQBOT_APP_SECRET || '',
  sandbox: (process.env.QQBOT_SANDBOX || 'false').toLowerCase() === 'true',
  removeAt: (process.env.QQBOT_REMOVE_AT || 'true').toLowerCase() === 'true',
  intents: splitCsv(process.env.QQBOT_INTENTS || 'GROUP_AT_MESSAGE_CREATE,C2C_MESSAGE_CREATE'),

  privateEnabled: (process.env.PRIVATE_ENABLED || 'true').toLowerCase() === 'true',
  allowGroup: (process.env.ALLOW_GROUP || 'true').toLowerCase() === 'true',
  triggerPrefix: process.env.TRIGGER_PREFIX || '',
  privateWhitelist: toIdSet(process.env.PRIVATE_WHITELIST || ''),
  groupWhitelist: toIdSet(process.env.GROUP_WHITELIST || ''),

  maxReplyChars: Number(process.env.MAX_REPLY_CHARS || 900),
  showThoughts: (process.env.SHOW_THOUGHTS || 'true').toLowerCase() === 'true',
  thoughtPrefix: process.env.THOUGHT_PREFIX ?? '',

  idleTimeoutMs: Number(process.env.IDLE_TIMEOUT_MS || 1440 * 60_000),
  maxConcurrentSessions: Number(process.env.MAX_CONCURRENT_SESSIONS || 20),
  promptTimeoutMs: Number(process.env.PROMPT_TIMEOUT_MS || 600000),
  maxPromptTimeoutMs: Number(process.env.MAX_PROMPT_TIMEOUT_MS || 120000),
  tokenRefreshCheckMs: Number(process.env.TOKEN_REFRESH_CHECK_MS || 15000),
  tokenRefreshThresholdMs: Number(process.env.TOKEN_REFRESH_THRESHOLD_MS || 30000),
  reconnectCheckMs: Number(process.env.RECONNECT_CHECK_MS || 20000),
  replyTimeoutMs: Number(process.env.REPLY_TIMEOUT_MS || 15000),
  acpPostPromptGraceMs: Number(process.env.ACP_POST_PROMPT_GRACE_MS || 350),
  acpPostPromptMaxWaitMs: Number(process.env.ACP_POST_PROMPT_MAX_WAIT_MS || 2500),
  messageDedupTtlMs: Number(process.env.MESSAGE_DEDUP_TTL_MS || 120000),

  modelProvider: (process.env.MODEL_PROVIDER || 'codex').toLowerCase(),
  agentCommand: process.env.AGENT_COMMAND || 'npx',
  agentArgs: splitArgs(process.env.AGENT_ARGS ?? '-y @zed-industries/codex-acp'),
  agentCwd: process.env.AGENT_CWD || '/home/pi',

  claudeCommand: process.env.CLAUDE_COMMAND || '/usr/local/nodejs/bin/claude',
  claudeArgs: splitArgs(process.env.CLAUDE_ARGS ?? ''),
  claudeModel: process.env.CLAUDE_MODEL || 'opus',
  claudeAcpCommand: process.env.CLAUDE_ACP_COMMAND || 'npx',
  claudeAcpArgs: splitArgs(process.env.CLAUDE_ACP_ARGS ?? '-y @agentclientprotocol/claude-agent-acp'),
};

if (!config.appId || !config.appSecret) {
  console.error('[fatal] QQBOT_APP_ID / QQBOT_APP_SECRET missing in environment');
  process.exit(1);
}

const sessions = new Map();
const persistedSessions = new Map();
const seenMessageIds = new Map();
const pendingFrenchQuizzes = new Map();
const frenchQuizAnswerTtlMs = 12 * 60 * 60 * 1000;
const sessionStatePath = process.env.SESSION_STATE_PATH || '/home/pi/qqbot-ai-bridge/session-state.json';
let cleanupTimer;
let tokenRefreshTimer;
let reconnectTimer;
let reconnecting = false;
let persistWriteChain = Promise.resolve();

function now() {
  return new Date().toISOString();
}

function log(msg) {
  console.log(`[${now()}] ${msg}`);
}

async function loadPersistedSessions() {
  let raw = '';
  try {
    raw = await fs.readFile(sessionStatePath, 'utf-8');
  } catch {
    return;
  }

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    log(`[session] invalid session state file: ${sessionStatePath}`);
    return;
  }

  const records = obj?.sessions;
  if (!records || typeof records !== 'object') return;
  for (const [key, rec] of Object.entries(records)) {
    const sid = String(rec?.sessionId || '').trim();
    if (!key || !sid) continue;
    persistedSessions.set(key, {
      sessionId: sid,
      updatedAt: String(rec?.updatedAt || ''),
    });
  }

  if (persistedSessions.size > 0) {
    log(`[session] loaded ${persistedSessions.size} persisted ACP sessions`);
  }
}

function snapshotPersistedSessions() {
  const sessionsObj = {};
  for (const [key, rec] of persistedSessions) {
    sessionsObj[key] = {
      sessionId: rec.sessionId,
      updatedAt: rec.updatedAt || now(),
    };
  }
  return {
    version: 1,
    updatedAt: now(),
    sessions: sessionsObj,
  };
}

function queuePersistedSessionsWrite() {
  persistWriteChain = persistWriteChain
    .catch(() => {})
    .then(async () => {
      const data = JSON.stringify(snapshotPersistedSessions(), null, 2);
      const tmp = `${sessionStatePath}.tmp`;
      await fs.writeFile(tmp, data, 'utf-8');
      await fs.rename(tmp, sessionStatePath);
    })
    .catch((err) => {
      log(`[session] persist write failed: ${String(err)}`);
    });
  return persistWriteChain;
}

function getPersistedSessionId(sessionKey) {
  return persistedSessions.get(sessionKey)?.sessionId || '';
}

function setPersistedSession(sessionKey, sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sessionKey || !sid) return;
  const prev = persistedSessions.get(sessionKey);
  if (prev?.sessionId === sid) return;
  persistedSessions.set(sessionKey, {
    sessionId: sid,
    updatedAt: now(),
  });
  queuePersistedSessionsWrite().catch(() => {});
}

function clearPersistedSession(sessionKey) {
  if (!persistedSessions.has(sessionKey)) return;
  persistedSessions.delete(sessionKey);
  queuePersistedSessionsWrite().catch(() => {});
}

function splitCsv(raw) {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitArgs(raw) {
  return raw.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

function parseNdjsonLine(line) {
  const text = String(line || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractClaudeTextEvent(event) {
  if (!event || typeof event !== 'object') return '';

  if (event.type === 'result' && typeof event.result === 'string') {
    return event.result;
  }

  const parts = [];
  const collectContent = (content) => {
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.text === 'string') parts.push(item.text);
    }
  };

  if (event.type === 'assistant') {
    if (typeof event.text === 'string') parts.push(event.text);
    collectContent(event.content);
    collectContent(event.message?.content);
  }

  if (event.type === 'message' || event.type === 'content_block') {
    if (typeof event.text === 'string') parts.push(event.text);
    collectContent(event.content);
  }

  return parts.join('');
}

function extractTextFromAcpPromptResult(result) {
  const collectText = (node) => {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (typeof node?.text === 'string') return node.text;
    if (Array.isArray(node)) {
      return node.map((it) => collectText(it)).filter(Boolean).join('');
    }
    if (Array.isArray(node?.content)) {
      return node.content.map((it) => collectText(it)).filter(Boolean).join('');
    }
    return '';
  };

  const candidates = [
    result?.content,
    result?.message,
    result?.messages,
    result?.output,
    result?.response,
    result?.result,
    result?.final,
    result?.completion,
    result?.text,
  ];

  for (const candidate of candidates) {
    const text = String(collectText(candidate) || '').trim();
    if (text) return text;
  }
  return '';
}

function toIdSet(raw) {
  const out = new Set();
  for (const item of raw.split(',').map((s) => s.trim()).filter(Boolean)) out.add(item);
  return out;
}

function splitText(text, limit = 900) {
  if (!text || text.length <= limit) return [text || ''];
  const out = [];
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
  return out;
}

function getEventMessageId(evt) {
  const id = String(evt?.message_id || evt?.id || '').trim();
  return id || '';
}

function cleanupSeenMessageIds(nowTs = Date.now()) {
  const ttl = Math.max(10_000, Number(config.messageDedupTtlMs || 120000));
  for (const [id, ts] of seenMessageIds) {
    if (nowTs - ts > ttl) seenMessageIds.delete(id);
  }
}

function shouldDropDuplicateEvent(evt) {
  const id = getEventMessageId(evt);
  if (!id) return false;
  const nowTs = Date.now();
  cleanupSeenMessageIds(nowTs);
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.set(id, nowTs);
  return false;
}

function isDeepSeekThinkingCompatError(err) {
  const msg = String(err || '').toLowerCase();
  return msg.includes('content[].thinking')
    || msg.includes('thinking mode must be passed back to the api');
}

function formatResetAt(unixSeconds) {
  const ts = Number(unixSeconds || 0);
  if (!Number.isFinite(ts) || ts <= 0) return 'unknown';
  const d = new Date(ts * 1000);
  const local = d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
  return `${local} (UTC+8)`;
}

async function findNewestJsonl(rootDir) {
  let newest = null;

  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      const full = `${dir}/${ent.name}`;
      if (ent.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
      try {
        const st = await fs.stat(full);
        if (!newest || st.mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs: st.mtimeMs };
      } catch {
        // ignore file stat errors
      }
    }
  }

  await walk(rootDir);
  return newest?.path || '';
}

function parseLatestTokenCountLine(content) {
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.type !== 'event_msg') continue;
    if (obj?.payload?.type !== 'token_count') continue;
    return obj.payload;
  }
  return null;
}

async function readCodexRateStatus() {
  const sessionsRoot = '/home/pi/.codex/sessions';
  const latestFile = await findNewestJsonl(sessionsRoot);
  if (!latestFile) return { ok: false, error: '未找到 Codex 会话日志' };

  let content = '';
  try {
    content = await fs.readFile(latestFile, 'utf-8');
  } catch (e) {
    return { ok: false, error: `读取日志失败: ${String(e?.message || e)}` };
  }

  const payload = parseLatestTokenCountLine(content);
  if (!payload?.rate_limits) {
    return { ok: false, error: '日志中未找到 token_count/rate_limits' };
  }

  const rl = payload.rate_limits || {};
  const info = payload.info || {};
  const total = info.total_token_usage || {};
  const last = info.last_token_usage || {};

  const text = [
    'Codex 额度状态（本地日志）',
    `plan: ${rl.plan_type || 'unknown'}`,
    `limit_id: ${rl.limit_id || 'unknown'}`,
    `primary: ${rl.primary?.used_percent ?? 'n/a'}% / ${rl.primary?.window_minutes ?? 'n/a'} 分钟，重置: ${formatResetAt(rl.primary?.resets_at)}`,
    `secondary: ${rl.secondary?.used_percent ?? 'n/a'}% / ${rl.secondary?.window_minutes ?? 'n/a'} 分钟，重置: ${formatResetAt(rl.secondary?.resets_at)}`,
    `credits: ${rl.credits == null ? 'null' : String(rl.credits)}`,
    `context_window: ${info.model_context_window ?? 'n/a'}`,
    `total_tokens: ${total.total_tokens ?? 'n/a'} (in=${total.input_tokens ?? 'n/a'}, cached_in=${total.cached_input_tokens ?? 'n/a'}, out=${total.output_tokens ?? 'n/a'}, reasoning_out=${total.reasoning_output_tokens ?? 'n/a'})`,
    `last_tokens: ${last.total_tokens ?? 'n/a'} (in=${last.input_tokens ?? 'n/a'}, cached_in=${last.cached_input_tokens ?? 'n/a'}, out=${last.output_tokens ?? 'n/a'}, reasoning_out=${last.reasoning_output_tokens ?? 'n/a'})`,
    `log_file: ${latestFile}`,
  ].join('\n');

  return { ok: true, text };
}

function getDeepSeekBalanceEndpoint(rawBaseUrl) {
  const base = String(rawBaseUrl || '').trim();
  if (!base) return '';
  try {
    const u = new URL(base);
    // DeepSeek Anthropic compatibility base is usually https://api.deepseek.com/anthropic
    // Balance API lives under /user/balance on the same origin.
    return `${u.origin}/user/balance`;
  } catch {
    return '';
  }
}

async function readDeepSeekBalanceStatus() {
  const token = String(process.env.ANTHROPIC_AUTH_TOKEN || '').trim();
  const base = String(process.env.ANTHROPIC_BASE_URL || '').trim();
  const endpoint = getDeepSeekBalanceEndpoint(base);

  if (!token) return { ok: false, error: '未配置 ANTHROPIC_AUTH_TOKEN' };
  if (!endpoint) return { ok: false, error: '未配置有效的 ANTHROPIC_BASE_URL' };

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (e) {
    return { ok: false, error: `请求 DeepSeek 余额接口失败: ${String(e?.message || e)}` };
  }

  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  if (!res.ok) {
    return {
      ok: false,
      error: `DeepSeek 余额接口返回 ${res.status}${data?.error?.message ? `: ${data.error.message}` : ''}`,
    };
  }

  const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
  const lines = infos.map((it) => {
    const currency = it?.currency || 'unknown';
    const total = it?.total_balance ?? 'n/a';
    const granted = it?.granted_balance ?? 'n/a';
    const toppedUp = it?.topped_up_balance ?? 'n/a';
    return `${currency}: total=${total}, granted=${granted}, topped_up=${toppedUp}`;
  });

  const text = [
    'DeepSeek 额度状态',
    `is_available: ${String(Boolean(data?.is_available))}`,
    ...(lines.length > 0 ? lines : ['balance_infos: empty']),
    `endpoint: ${endpoint}`,
  ].join('\n');

  return { ok: true, text };
}

function trimReply(text) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return '我在。你可以再说具体一点。';
  return cleaned;
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeFrenchText(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[’]/g, "'")
    .normalize('NFD')
    .replace(/\p{Diacritic}+/gu, '')
    .replace(/[.,!?;:()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseFrenchQuizSubmission(raw) {
  const input = String(raw || '').trim();
  if (!input) return null;

  let choiceAnswer = '';
  let fillAnswer = '';

  const choiceLabel = input.match(/(?:选择|choice)\s*[:：]\s*([^\n]+)/i);
  if (choiceLabel) choiceAnswer = choiceLabel[1].trim();

  const fillLabel = input.match(/(?:填空|fill)\s*[:：]\s*([^\n]+)/i);
  if (fillLabel) fillAnswer = fillLabel[1].trim();

  if ((!choiceAnswer || !fillAnswer) && input.includes('|')) {
    const parts = input.split('|');
    if (!choiceAnswer) choiceAnswer = String(parts[0] || '').trim();
    if (!fillAnswer) fillAnswer = String(parts.slice(1).join('|') || '').trim();
  }

  if (!choiceAnswer || !fillAnswer) {
    const lines = input.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length >= 2) {
      if (!choiceAnswer) choiceAnswer = lines[0];
      if (!fillAnswer) fillAnswer = lines.slice(1).join(' ');
    }
  }

  if (!choiceAnswer) {
    const letter = input.match(/\b([a-e])\b/i);
    if (letter) choiceAnswer = letter[1];
  }

  if (!fillAnswer && choiceAnswer) {
    let rest = input.replace(new RegExp(`\\b${escapeRegExp(choiceAnswer)}\\b`, 'i'), ' ');
    rest = rest.replace(/(?:选择|choice|填空|fill)\s*[:：]/gi, ' ');
    rest = rest.replace(/[|,，;]/g, ' ').replace(/\s+/g, ' ').trim();
    if (rest) fillAnswer = rest;
  }

  if (!choiceAnswer || !fillAnswer) return null;
  return {
    choiceAnswer: choiceAnswer.trim(),
    fillAnswer: fillAnswer.trim(),
  };
}

function resolveChoiceLetterFromAnswer(answer, options) {
  const raw = String(answer || '').trim();
  if (!raw) return '';
  if (/^[a-e]$/i.test(raw)) return raw.toUpperCase();

  const normalized = normalizeFrenchText(raw);
  const labels = ['A', 'B', 'C', 'D', 'E'];
  for (let i = 0; i < Math.min(options.length, labels.length); i += 1) {
    if (normalizeFrenchText(options[i]) === normalized) return labels[i];
  }
  return '';
}

async function handleFrenchQuizAnswer(evt, userText) {
  const key = getSessionKey(evt);
  const pending = pendingFrenchQuizzes.get(key);
  if (!pending) return false;

  const raw = String(userText || '').trim();
  if (!raw || raw.startsWith('/')) return false;

  if (Date.now() - pending.createdAt > frenchQuizAnswerTtlMs) {
    pendingFrenchQuizzes.delete(key);
    await safeReply(evt, '这组法语题已过期，请重新发送 /fr 获取新题。');
    return true;
  }

  const parsed = parseFrenchQuizSubmission(raw);
  if (!parsed) {
    await safeReply(evt, [
      '答题格式不对，请按下面任一格式回复：',
      'A 你的填空答案',
      '或两行：第一行填 A/B/C/D，第二行填空答案',
      '例如：D habite',
    ].join('\n'));
    return true;
  }

  const userChoiceLetter = resolveChoiceLetterFromAnswer(parsed.choiceAnswer, pending.choice.options || []);
  const correctChoiceLetter = String(pending.choice.correctLetter || '').toUpperCase();
  const choiceOk = userChoiceLetter && correctChoiceLetter && userChoiceLetter === correctChoiceLetter;

  const userFillNorm = normalizeFrenchText(parsed.fillAnswer);
  const correctFill = String(pending.fill.correctText || '').trim();
  const fillOk = userFillNorm && userFillNorm === normalizeFrenchText(correctFill);

  const score = Number(choiceOk) + Number(fillOk);
  pendingFrenchQuizzes.delete(key);

  const choiceAnswerText = pending.choice.options?.length && correctChoiceLetter
    ? `${correctChoiceLetter}. ${pending.choice.options[correctChoiceLetter.charCodeAt(0) - 65] || pending.choice.correctText}`
    : pending.choice.correctText;

  await safeReply(evt, [
    '🇫🇷 法语练习批改结果',
    `选择题：${choiceOk ? '✅ 正确' : '❌ 错误'}（你的答案：${parsed.choiceAnswer}；正确答案：${choiceAnswerText || pending.choice.correctText}）`,
    `填空题：${fillOk ? '✅ 正确' : '❌ 错误'}（你的答案：${parsed.fillAnswer}；正确答案：${correctFill}）`,
    `得分：${score}/2`,
    '发送 /fr 可再来一组。',
  ].join('\n'));
  return true;
}

function isSkillQuery(text) {
  const s = String(text || '').trim().toLowerCase();
  if (!s) return false;
  return /skill|skills|技能|命令|commands?/.test(s);
}

function normalizeCommandName(item) {
  if (!item) return '';
  if (typeof item === 'string') return item.trim();
  const name = item.name || item.id || item.command || item.title || '';
  return String(name || '').trim();
}

function summarizeAvailableCommands(items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const name = normalizeCommandName(item);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function buildSkillFallbackReply(provider, items) {
  const names = summarizeAvailableCommands(items);
  const header = provider === 'claude-acp' ? 'Claude 可用命令' : '可用命令';
  if (names.length === 0) {
    return [
      `${header}（当前会话未上报具体列表）`,
      '你可以先试试：/help、/status、/new、/whoami。',
      '如果你要查 Claude 侧命令，我也可以继续帮你列一次。',
    ].join('\n');
  }
  const show = names.slice(0, 24).map((n) => `- ${n}`).join('\n');
  const extra = names.length > 24 ? `\n... 还有 ${names.length - 24} 个` : '';
  return `${header}（${names.length}）\n${show}${extra}`;
}

function makeCmdInputTag(text, show = '', reference = false) {
  const t = encodeURIComponent(String(text || ''));
  const s = encodeURIComponent(String(show || text || ''));
  return `<qqbot-cmd-input text="${t}" show="${s}" reference="${reference ? 'true' : 'false'}" />`;
}

function buildSlashCommandMarkdown() {
  return [
    '可点击指令面板（私聊）',
    '',
    makeCmdInputTag('/new', '/new 新建会话'),
    makeCmdInputTag('/status', '/status 查看额度状态'),
    makeCmdInputTag('/ip', '/ip 查询公网IP信息'),
    makeCmdInputTag('/whoami', '/whoami 查看会话信息'),
    makeCmdInputTag('/fr', '/fr 法语动词变位练习（1选择+1填空）'),
    makeCmdInputTag('/ping', '/ping 连通性测试'),
    makeCmdInputTag('/help', '/help 查看帮助'),
  ].join('\n');
}

async function readPublicIpFromCipCcNoProxy() {
  const env = { ...process.env };
  delete env.http_proxy;
  delete env.https_proxy;
  delete env.all_proxy;
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.ALL_PROXY;

  const output = await new Promise((resolve, reject) => {
    execFile('/usr/bin/curl', ['-s', 'cip.cc'], { timeout: 12000, env }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(String(stdout || ''));
    });
  });

  const ip = output.match(/^IP\s*:\s*(.+)$/m)?.[1]?.trim() || '';
  const addr = output.match(/^地址\s*:\s*(.+)$/m)?.[1]?.trim() || '';
  const isp = output.match(/^运营商\s*:\s*(.+)$/m)?.[1]?.trim() || '';

  if (!ip) return { ok: false, error: 'cip.cc 未返回 IP' };
  return { ok: true, ip, addr, isp };
}

function formatThoughtMessage(text) {
  const body = trimReply(text);
  const prefix = String(config.thoughtPrefix || '').trim();
  return prefix ? `[${prefix}] ${body}` : body;
}

async function safeReply(evt, text) {
  const str = String(text || '');
  const chunks = splitText(str, config.maxReplyChars);
  log(`[send] markdown chunks=${chunks.length}, totalChars=${str.length}`);
  for (const chunk of chunks) {
    try {
      await withTimeout(
        evt.reply([qqSegment.markdown(chunk)]),
        Math.max(config.replyTimeoutMs, 3000),
        `reply timeout after ${Math.max(config.replyTimeoutMs, 3000)}ms`,
      );
    } catch (err) {
      log(`[send] markdown reply failed: ${String(err)}`);
    }
  }
}

function normalizeMessage(evt) {
  return String(evt?.raw_message || evt?.content || '').trim();
}

function shouldHandle(evt) {
  if (!evt || (evt.message_type !== 'private' && evt.message_type !== 'group')) return false;

  if (evt.message_type === 'private') {
    if (!config.privateEnabled) return false;
    if (config.privateWhitelist.size > 0 && !config.privateWhitelist.has(String(evt.user_id))) return false;
  }

  if (evt.message_type === 'group') {
    if (!config.allowGroup) return false;
    if (config.groupWhitelist.size > 0 && !config.groupWhitelist.has(String(evt.group_id))) return false;
  }

  return true;
}

function getUserTextByTrigger(evt, text) {
  const msg = String(text || '').trim();
  if (!msg) return '';

  if (evt.message_type === 'private' && config.triggerPrefix) {
    if (!msg.startsWith(config.triggerPrefix)) return '';
    return msg.slice(config.triggerPrefix.length).trim();
  }

  return msg;
}

function buildPrompt(evt, userText) {
  const chatType = evt.message_type === 'group' ? `群聊(${evt.group_id})` : '私聊';
  const senderName = evt.sender?.user_name || String(evt.user_id || 'unknown');
  const provider = getProvider();
  const botIdentity = provider === 'codex' ? 'Codex 机器人' : 'Claude Code 机器人';
  return [
    `你是运行在 QQ 官方 Bot 通道上的 ${botIdentity}（固定身份，不可更改）。`,
    '你只能以 QQBot 身份回复，不要混入其他渠道（例如微信、Telegram、网页聊天等）。',
    `如果用户问“你是谁/你是不是QQ机器人”，请明确回答你是“QQ 官方 Bot 通道里的 ${botIdentity}”。`,
    '除非用户明确要求英文，否则默认使用中文简洁回复。',
    `会话类型: ${chatType}`,
    `机器人 AppID: ${config.appId}`,
    `发送者: ${senderName} (${evt.user_id})`,
    '用户消息：',
    userText,
  ].join('\n');
}

function getSessionKey(evt) {
  if (evt.message_type === 'group') return `group:${evt.group_id}:user:${evt.user_id}`;
  return `private:${evt.user_id}`;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

class QqAcpClient {
  constructor(opts) {
    this.opts = opts;
    this.chunks = [];
    this.chunkVersion = 0;
    this.lastChunkAt = 0;
    this.thoughtChunks = [];
    this.lastThoughtAt = 0;
    this.lastThinkingPulseAt = 0;
    this.availableCommands = [];
  }

  updateCallbacks(callbacks) {
    this.opts = { ...this.opts, ...callbacks };
  }

  async requestPermission(params) {
    const allowOpt = params.options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always');
    const optionId = allowOpt?.optionId ?? params.options[0]?.optionId ?? 'allow';
    this.opts.log(`[permission] auto-allow ${params.toolCall?.title || 'unknown'} -> ${optionId}`);
    return { outcome: { outcome: 'selected', optionId } };
  }

  async sessionUpdate(params) {
    const update = params.update;
    const collectText = (node) => {
      if (!node) return '';
      if (typeof node === 'string') return node;
      if (typeof node?.text === 'string') return node.text;
      if (Array.isArray(node)) {
        return node.map((it) => collectText(it)).filter(Boolean).join('');
      }
      if (Array.isArray(node?.content)) {
        return node.content.map((it) => collectText(it)).filter(Boolean).join('');
      }
      return '';
    };

    const pushChunk = (text) => {
      const chunk = String(text || '');
      if (!chunk) return;
      this.chunks.push(chunk);
      this.chunkVersion += 1;
      this.lastChunkAt = Date.now();
    };

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content?.type === 'text') pushChunk(update.content.text);
        await this.maybeFlushThoughts(false);
        break;

      case 'agent_message': {
        const text = collectText(update.content) || collectText(update.message) || collectText(update);
        if (text) pushChunk(text);
        await this.maybeFlushThoughts(false);
        break;
      }

      case 'message': {
        const text = collectText(update.content) || collectText(update.message) || collectText(update);
        if (text) pushChunk(text);
        await this.maybeFlushThoughts(false);
        break;
      }

      case 'agent_thought_chunk':
        if (this.opts.showThoughts) await this.maybeSendThinkingPulse();
        break;

      case 'tool_call':
        if (this.opts.showThoughts) {
          this.thoughtChunks.push(`\n[tool] ${update.title} (${update.status})\n`);
          await this.maybeFlushThoughts(false);
        }
        break;

      case 'tool_call_update':
        if (this.opts.showThoughts && update.status) {
          this.thoughtChunks.push(`\n[tool] ${update.toolCallId} -> ${update.status}\n`);
          await this.maybeFlushThoughts(false);
        }
        break;

      case 'plan':
        if (this.opts.showThoughts && Array.isArray(update.entries) && update.entries.length > 0) {
          const lines = update.entries.map((e, i) => `${i + 1}. [${e.status}] ${e.content}`).join('\n');
          this.thoughtChunks.push(`\n[plan]\n${lines}\n`);
          await this.maybeFlushThoughts(false);
        }
        break;

      case 'available_commands_update': {
        const raw = update.availableCommands ?? update.commands ?? update.entries ?? [];
        if (Array.isArray(raw)) {
          this.availableCommands = raw;
          this.opts.log(`[session/update] available_commands_update size=${raw.length}`);
        } else {
          this.opts.log('[session/update] available_commands_update received (non-array)');
        }
        break;
      }

      default:
        this.opts.log(`[session/update] unhandled type: ${String(update.sessionUpdate || 'unknown')}`);
        break;
    }
  }

  async readTextFile(params) {
    const content = await fs.readFile(params.path, 'utf-8');
    return { content };
  }

  async writeTextFile(params) {
    await fs.writeFile(params.path, params.content, 'utf-8');
    return {};
  }

  async flush() {
    await this.maybeFlushThoughts(true);
    const text = this.chunks.join('');
    this.chunks = [];
    return text;
  }

  async flushAfterQuiet(quietMs = 350, maxWaitMs = 2500) {
    const quietWindowMs = Math.max(50, Number(quietMs) || 350);
    const hardWaitMs = Math.max(quietWindowMs, Number(maxWaitMs) || 2500);
    const pollMs = Math.min(100, Math.max(20, Math.floor(quietWindowMs / 4)));
    const start = Date.now();
    let seenVersion = this.chunkVersion;
    let seenAt = this.lastChunkAt;

    while (Date.now() - start < hardWaitMs) {
      const hasChunks = this.chunks.length > 0;
      if (hasChunks) {
        const idleForMs = seenAt > 0 ? (Date.now() - seenAt) : Infinity;
        if (idleForMs >= quietWindowMs) break;
      } else if (Date.now() - start >= quietWindowMs) {
        break;
      }

      await sleep(pollMs);
      if (this.chunkVersion !== seenVersion) {
        seenVersion = this.chunkVersion;
        seenAt = this.lastChunkAt;
      }
    }

    return this.flush();
  }

  getAvailableCommands() {
    return Array.isArray(this.availableCommands) ? [...this.availableCommands] : [];
  }

  async maybeFlushThoughts(force) {
    if (!this.opts.showThoughts) {
      this.thoughtChunks = [];
      return;
    }
    if (this.thoughtChunks.length === 0) return;

    const nowMs = Date.now();
    const joined = this.thoughtChunks.join('').trim();
    if (!joined) {
      this.thoughtChunks = [];
      return;
    }

    if (!force) {
      const throttleMs = 3000;
      if (nowMs - this.lastThoughtAt < throttleMs && joined.length < 180) return;
    }

    this.thoughtChunks = [];
    this.lastThoughtAt = nowMs;

    try {
      await this.opts.onThought(joined);
    } catch {
      // best effort
    }
  }

  async maybeSendThinkingPulse() {
    const nowMs = Date.now();
    const pulseMs = 8000;
    if (nowMs - this.lastThinkingPulseAt < pulseMs) return;
    this.lastThinkingPulseAt = nowMs;
    try {
      await this.opts.onThought('正在分析中...');
    } catch {
      // best effort
    }
  }
}

function canUseResume(capabilities) {
  return Boolean(capabilities?.sessionCapabilities?.resume);
}

function canUseLoad(capabilities) {
  return capabilities?.loadSession === true;
}

function shouldForgetSessionId(errMessage) {
  const msg = String(errMessage || '').toLowerCase();
  return (
    msg.includes('invalid session')
    || msg.includes('session not found')
    || msg.includes('unknown session')
    || msg.includes('no such session')
    || msg.includes('does not exist')
  );
}

async function tryRestoreSession(connection, sessionKey, restoreSessionId, capabilities) {
  if (!restoreSessionId) return { ok: false, tried: false, reason: 'empty-session-id' };

  const modes = [];
  if (canUseResume(capabilities)) modes.push('resume');
  if (canUseLoad(capabilities)) modes.push('load');
  if (modes.length === 0) {
    // optimistic fallback for agents that do not advertise capabilities correctly
    modes.push('resume', 'load');
  }

  let lastError = null;
  for (const mode of modes) {
    try {
      if (mode === 'resume') {
        await connection.unstable_resumeSession({
          sessionId: restoreSessionId,
          cwd: config.agentCwd,
          mcpServers: [],
        });
      } else {
        await connection.loadSession({
          sessionId: restoreSessionId,
          cwd: config.agentCwd,
          mcpServers: [],
        });
      }
      log(`[${sessionKey}] restored ACP session by ${mode}: ${restoreSessionId}`);
      return { ok: true, tried: true, mode };
    } catch (err) {
      lastError = err;
      log(`[${sessionKey}] restore via ${mode} failed: ${String(err)}`);
    }
  }

  return { ok: false, tried: true, reason: String(lastError || 'restore-failed') };
}

function getProvider() {
  const p = String(config.modelProvider || '').trim().toLowerCase();
  if (p === 'claude-cli') return 'claude-cli';
  if (p === 'claude-acp') return 'claude-acp';
  if (p === 'claude') return 'claude-acp';
  return 'codex';
}

function getAcpAgentConfigByProvider(provider) {
  if (provider === 'claude-acp') {
    return {
      command: config.claudeAcpCommand,
      args: config.claudeAcpArgs,
      label: 'claude-agent-acp',
    };
  }
  return {
    command: config.agentCommand,
    args: config.agentArgs,
    label: 'codex-acp',
  };
}

async function runClaudePrompt(
  sessionKey,
  promptText,
  restoreSessionId = '',
  onThought = async () => {},
  timeoutMs = 120000,
) {
  const args = [
    ...config.claudeArgs,
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--model',
    config.claudeModel,
  ];
  if (restoreSessionId) {
    args.push('--resume', restoreSessionId);
  }
  args.push(promptText);

  log(`[${sessionKey}] spawn claude: ${config.claudeCommand} ${args.join(' ')}`);
  const proc = spawn(config.claudeCommand, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: config.agentCwd,
    env: { ...process.env },
    shell: process.platform === 'win32',
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  let parsedReply = '';
  let finalResult = '';
  let latestSessionId = '';
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore kill errors
    }
    setTimeout(() => {
      try {
        if (!proc.killed) proc.kill('SIGKILL');
      } catch {
        // ignore kill errors
      }
    }, 3000).unref?.();
  }, Math.max(timeoutMs, 10_000));
  timeoutTimer.unref?.();

  proc.stdout?.on('data', (d) => {
    stdoutBuf += String(d || '');
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() || '';

    for (const rawLine of lines) {
      const line = String(rawLine || '').trim();
      if (!line) continue;

      const event = parseNdjsonLine(line);
      if (!event) {
        parsedReply += `${line}\n`;
        continue;
      }

      if (typeof event.session_id === 'string' && event.session_id.trim()) {
        latestSessionId = event.session_id.trim();
      }

      if (event.type === 'system' && event.subtype === 'api_retry') {
        const attempt = event.attempt ?? '?';
        const maxRetries = event.max_retries ?? '?';
        onThought(`模型请求重试中：${attempt}/${maxRetries}`).catch(() => {});
      }

      const textChunk = extractClaudeTextEvent(event);
      if (textChunk) {
        if (event.type === 'result') {
          finalResult = textChunk;
        } else {
          parsedReply += textChunk;
        }
      }
    }
  });

  proc.stderr?.on('data', (d) => {
    const s = String(d || '');
    stderrBuf += s;
    const t = s.trim();
    if (t) log(`[${sessionKey}] claude stderr: ${t.slice(0, 400)}`);
  });

  const closeResult = await new Promise((resolve) => {
    proc.on('error', (err) => resolve({ ok: false, error: String(err) }));
    proc.on('exit', (code, signal) => resolve({ ok: code === 0, code, signal }));
  });
  clearTimeout(timeoutTimer);

  if (stdoutBuf.trim()) {
    const event = parseNdjsonLine(stdoutBuf.trim());
    if (event) {
      if (typeof event.session_id === 'string' && event.session_id.trim()) {
        latestSessionId = event.session_id.trim();
      }
      const textChunk = extractClaudeTextEvent(event);
      if (textChunk) {
        if (event.type === 'result') {
          finalResult = textChunk;
        } else {
          parsedReply += textChunk;
        }
      }
    } else {
      parsedReply += stdoutBuf;
    }
  }

  const mergedReply = String(finalResult || parsedReply || '').trim();
  if (timedOut) {
    throw new Error(`claude prompt timeout after ${Math.max(timeoutMs, 10_000)}ms`);
  }
  if (!closeResult.ok && !mergedReply) {
    const errTail = String(stderrBuf || '').trim().slice(-600);
    throw new Error(`claude command failed: code=${closeResult.code} signal=${closeResult.signal} ${errTail}`);
  }

  return {
    text: mergedReply,
    sessionId: latestSessionId || restoreSessionId || '',
  };
}

async function spawnAcpAgent(sessionKey, onThought, restoreSessionId = '', provider = 'codex') {
  const client = new QqAcpClient({
    showThoughts: config.showThoughts,
    log: (m) => log(`[${sessionKey}] ${m}`),
    onThought,
  });

  const acpAgent = getAcpAgentConfigByProvider(provider);

  log(`[${sessionKey}] spawn ${acpAgent.label}: ${acpAgent.command} ${acpAgent.args.join(' ')}`);
  const proc = spawn(acpAgent.command, acpAgent.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: config.agentCwd,
    env: { ...process.env },
    shell: process.platform === 'win32',
  });

  proc.on('error', (err) => log(`[${sessionKey}] agent error: ${String(err)}`));
  proc.on('exit', (code, signal) => log(`[${sessionKey}] agent exit code=${code} signal=${signal}`));

  if (proc.stderr) {
    proc.stderr.on('data', (d) => {
      const s = String(d || '').trim();
      if (s) log(`[${sessionKey}] agent stderr: ${s.slice(0, 400)}`);
    });
  }

  if (!proc.stdin || !proc.stdout) {
    proc.kill();
    throw new Error('failed to attach agent stdio');
  }

  const stream = acp.ndJsonStream(
    Writable.toWeb(proc.stdin),
    Readable.toWeb(proc.stdout),
  );

  const connection = new acp.ClientSideConnection(() => client, stream);
  const initResult = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: { name: 'qqbot-ai-bridge', title: 'qqbot-ai-bridge', version: '0.1.0' },
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });

  const capabilities = initResult?.agentCapabilities || {};
  let finalSessionId = '';
  let restored = false;

  if (restoreSessionId) {
    const r = await tryRestoreSession(connection, sessionKey, restoreSessionId, capabilities);
    if (r.ok) {
      finalSessionId = restoreSessionId;
      restored = true;
    } else if (r.tried && shouldForgetSessionId(r.reason)) {
      clearPersistedSession(sessionKey);
      log(`[${sessionKey}] dropped stale persisted sessionId`);
    }
  }

  if (!finalSessionId) {
    const sessionResult = await connection.newSession({ cwd: config.agentCwd, mcpServers: [] });
    finalSessionId = sessionResult.sessionId;
    log(`[${sessionKey}] created new ACP session: ${finalSessionId}`);
  }

  return {
    client,
    process: proc,
    connection,
    sessionId: finalSessionId,
    restored,
  };
}

function killAgent(proc) {
  if (!proc || proc.killed) return;
  proc.kill('SIGTERM');
  setTimeout(() => {
    if (!proc.killed) proc.kill('SIGKILL');
  }, 5000).unref?.();
}

function evictOldestIdle() {
  let oldest = null;
  for (const [key, s] of sessions) {
    if (s.processing) continue;
    if (!oldest || s.lastActivity < oldest.lastActivity) oldest = { key, lastActivity: s.lastActivity };
  }
  if (!oldest) return;

  const s = sessions.get(oldest.key);
  if (s?.agent?.process) killAgent(s.agent.process);
  sessions.delete(oldest.key);
  log(`evict idle session ${oldest.key}`);
}

function ensureSession(key, evt) {
  let s = sessions.get(key);
  if (s) return s;

  if (sessions.size >= config.maxConcurrentSessions) evictOldestIdle();

  s = {
    key,
    queue: [],
    processing: false,
    lastActivity: Date.now(),
    createdAt: Date.now(),
    lastEvt: evt,
    agent: null,
  };
  sessions.set(key, s);
  log(`create session ${key}, active=${sessions.size}`);
  return s;
}

function cleanupIdleSessions() {
  if (config.idleTimeoutMs <= 0) return;
  const nowMs = Date.now();

  for (const [key, s] of sessions) {
    if (s.processing) continue;
    if (nowMs - s.lastActivity > config.idleTimeoutMs) {
      if (s.agent?.process) killAgent(s.agent.process);
      sessions.delete(key);
      log(`remove idle session ${key}`);
    }
  }
}

async function getOrCreateAgent(session, evt) {
  const provider = getProvider();
  if (provider === 'claude-cli') {
    if (session.agent?.kind === 'claude') return session.agent;
    const restoreSessionId = getPersistedSessionId(session.key);
    session.agent = { kind: 'claude', sessionId: restoreSessionId };
    return session.agent;
  }

  if (session.agent && session.agent.process && session.agent.process.exitCode == null) return session.agent;

  const restoreSessionId = getPersistedSessionId(session.key);
  const agent = await spawnAcpAgent(session.key, async (t) => {
    await safeReply(evt, formatThoughtMessage(t));
  }, restoreSessionId, provider);

  agent.process.on('exit', () => {
    const cur = sessions.get(session.key);
    if (cur && cur.agent === agent) {
      cur.agent = null;
      log(`[${session.key}] agent exited, session kept for recreate`);
    }
  });

  session.agent = agent;
  setPersistedSession(session.key, agent.sessionId);
  return agent;
}

async function handleBuiltinCommand(evt, userText) {
  const raw = String(userText || '').trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();

  if (lower === '/help') {
    if (evt.message_type === 'private') {
      try {
        await evt.reply([qqSegment.markdown(buildSlashCommandMarkdown())]);
      } catch (err) {
        log(`[send] markdown command panel failed: ${String(err)}`);
      }
    }
    await safeReply(evt, [
      'QQBot AI Bridge',
      '私聊直接发消息会自动交给 Codex。',
      '群聊里 @机器人 并发送消息会触发处理。',
      '',
      '内置指令:',
      '/new      新建会话',
      '/status   查看额度状态',
      '/ip       查询公网IP信息',
      '/ping     连通性测试',
      '/whoami   查看会话信息',
      '/fr       法语动词变位练习（先答题，再判分）',
      '          答题格式示例：D habite',
      '/help     查看帮助',
    ].join('\n'));
    return true;
  }

  if (lower === '/new') {
    const key = getSessionKey(evt);
    const s = sessions.get(key);
    if (s?.agent?.process) {
      killAgent(s.agent.process);
      s.agent = null;
    }
    if (s) {
      s.queue = [];
      s.lastActivity = Date.now();
    }
    clearPersistedSession(key);
    pendingFrenchQuizzes.delete(key);
    await safeReply(evt, '已开启新会话。下一条消息将使用全新上下文。');
    return true;
  }

  if (lower === '/status') {
    const provider = getProvider();
    if (provider === 'claude-cli') {
      const base = String(process.env.ANTHROPIC_BASE_URL || '').toLowerCase();
      if (base.includes('deepseek.com')) {
        const ds = await readDeepSeekBalanceStatus();
        await safeReply(evt, ds.ok ? ds.text : `DeepSeek 额度查询失败：${ds.error}`);
        return true;
      }
      await safeReply(evt, [
        'Claude CLI 模式状态',
        `provider: claude-cli`,
        `model: ${config.claudeModel}`,
        `command: ${config.claudeCommand}`,
        '额度与用量请在 Claude Code 内执行 /status 查看。',
      ].join('\n'));
    } else if (provider === 'claude-acp') {
      const base = String(process.env.ANTHROPIC_BASE_URL || '').toLowerCase();
      if (base.includes('deepseek.com')) {
        const ds = await readDeepSeekBalanceStatus();
        await safeReply(evt, ds.ok ? ds.text : `DeepSeek 额度查询失败：${ds.error}`);
        return true;
      }
      await safeReply(evt, [
        'Claude ACP 模式状态',
        'provider: claude-acp',
        `agent: ${config.claudeAcpCommand} ${config.claudeAcpArgs.join(' ')}`,
      ].join('\n'));
    } else {
      const status = await readCodexRateStatus();
      await safeReply(evt, status.ok ? status.text : `查询失败：${status.error}`);
    }
    return true;
  }

  if (lower === '/fr') {
    const key = getSessionKey(evt);
    const quiz = await new Promise((resolve) => {
      execFile('/usr/bin/python3', ['/home/pi/scripts/fr_quiz.py', '--json'], { timeout: 15000 }, (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          if (!parsed?.ok) {
            resolve(null);
            return;
          }
          resolve(parsed);
        } catch {
          resolve(null);
        }
      });
    });

    if (!quiz) {
      await safeReply(evt, '题库加载失败，请稍后再试。');
      return true;
    }

    pendingFrenchQuizzes.set(key, {
      createdAt: Date.now(),
      choice: quiz.choice || {},
      fill: quiz.fill || {},
    });

    await safeReply(evt, [
      String(quiz.prompt || '').trim(),
      '',
      '请回复你的答案，我会自动批改。',
      '格式：A 填空答案（例如：D habite）',
    ].join('\n'));
    return true;
  }

  if (lower === '/ip') {
    try {
      const info = await readPublicIpFromCipCcNoProxy();
      if (!info.ok) {
        await safeReply(evt, `IP 查询失败：${info.error}`);
        return true;
      }
      await safeReply(evt, [
        `公网IP: ${info.ip}`,
        `地址: ${info.addr || 'unknown'}`,
        `运营商: ${info.isp || 'unknown'}`,
        'source: cip.cc（no-proxy）',
      ].join('\n'));
    } catch (err) {
      await safeReply(evt, `IP 查询失败：${String(err?.message || err)}`);
    }
    return true;
  }

  if (lower === '/ping') {
    await safeReply(evt, 'pong');
    return true;
  }

  if (lower === '/whoami') {
    await safeReply(evt, [
      '当前会话信息',
      `类型: ${evt.message_type}`,
      `发送者: ${evt.sender?.user_name || evt.user_id} (${evt.user_id})`,
      evt.message_type === 'group' ? `群号: ${evt.group_id}` : '群号: N/A',
      `message_id: ${evt.message_id || 'unknown'}`,
    ].join('\n'));
    return true;
  }

  return false;
}

function enqueue(evt) {
  if (shouldDropDuplicateEvent(evt)) {
    log(`[dedup] drop duplicate event message_id=${getEventMessageId(evt)}`);
    return;
  }
  const key = getSessionKey(evt);
  const s = ensureSession(key, evt);
  s.lastEvt = evt;
  s.lastActivity = Date.now();
  if (s.processing) {
    safeReply(evt, `上一条还在处理中，已排队（当前队列 ${s.queue.length + 1}）。`).catch(() => {});
  }
  s.queue.push({ evt });

  if (!s.processing) {
    s.processing = true;
    processSession(s).catch((err) => log(`[${s.key}] session loop error: ${String(err)}`));
  }
}

async function processSession(session) {
  try {
    while (session.queue.length > 0) {
      const { evt } = session.queue.shift();
      const normalized = normalizeMessage(evt);
      const userText = getUserTextByTrigger(evt, normalized);
      if (!userText) continue;

      session.lastActivity = Date.now();
      log(`[${session.key}] handling ${evt.message_type} message`);

      try {
        if (await handleBuiltinCommand(evt, userText)) {
          log(`[${session.key}] handled by builtin command`);
          continue;
        }
        if (await handleFrenchQuizAnswer(evt, userText)) {
          log(`[${session.key}] handled by french quiz answer`);
          continue;
        }

        const effectivePromptTimeoutMs = Math.max(
          10_000,
          Math.min(
            config.promptTimeoutMs,
            config.maxPromptTimeoutMs,
          ),
        );
        const provider = getProvider();
        const agent = await getOrCreateAgent(session, evt);

        let replyText = '';
        let latestAvailableCommands = [];
        if (provider === 'claude-cli') {
          const builtPrompt = buildPrompt(evt, userText);
          const runResult = await runClaudePrompt(
            session.key,
            builtPrompt,
            agent.sessionId || '',
            async (t) => safeReply(evt, formatThoughtMessage(t)),
            effectivePromptTimeoutMs,
          );
          replyText = runResult.text || '';
          if (runResult.sessionId) {
            agent.sessionId = runResult.sessionId;
            setPersistedSession(session.key, runResult.sessionId);
          }
        } else {
          const runAcpPromptOnce = async (acpAgent) => {
            acpAgent.client.updateCallbacks({
              onThought: async (t) => safeReply(evt, formatThoughtMessage(t)),
            });

            await acpAgent.client.flush();

            const prompt = [{ type: 'text', text: buildPrompt(evt, userText) }];
            const result = await withTimeout(
              acpAgent.connection.prompt({ sessionId: acpAgent.sessionId, prompt }),
              effectivePromptTimeoutMs,
              `acp prompt timeout after ${effectivePromptTimeoutMs}ms`,
            );
            log(`[${session.key}] prompt stopReason=${String(result?.stopReason || 'unknown')}`);
            let text = await acpAgent.client.flushAfterQuiet(
              config.acpPostPromptGraceMs,
              config.acpPostPromptMaxWaitMs,
            );
            if (!text.trim()) {
              const fromResult = extractTextFromAcpPromptResult(result);
              if (fromResult) {
                text = fromResult;
                log(`[${session.key}] recovered reply text from prompt result payload`);
              } else {
                const keys = Object.keys(result || {}).join(',');
                log(`[${session.key}] empty reply after prompt; result keys=[${keys}]`);
              }
            }
            latestAvailableCommands = acpAgent.client.getAvailableCommands();
            if (result?.stopReason === 'cancelled') text += '\n[cancelled]';
            if (result?.stopReason === 'refusal') text += '\n[agent refused]';
            return text;
          };

          try {
            replyText = await runAcpPromptOnce(agent);
          } catch (err) {
            if (provider === 'claude-acp' && isDeepSeekThinkingCompatError(err)) {
              log(`[${session.key}] DeepSeek thinking compatibility error, clear session and retry once`);
              if (session.agent?.process) killAgent(session.agent.process);
              session.agent = null;
              clearPersistedSession(session.key);
              const freshAgent = await getOrCreateAgent(session, evt);
              replyText = await runAcpPromptOnce(freshAgent);
            } else {
              throw err;
            }
          }
          if (!replyText.trim() && provider === 'claude-acp') {
            log(`[${session.key}] empty ACP reply, recreate claude session and retry once`);
            if (session.agent?.process) killAgent(session.agent.process);
            session.agent = null;
            clearPersistedSession(session.key);
            const freshAgent = await getOrCreateAgent(session, evt);
            replyText = await runAcpPromptOnce(freshAgent);
          }

          if (!replyText.trim() && provider === 'claude-acp') {
            log(`[${session.key}] empty ACP reply after retry, fallback to claude-cli prompt`);
            const builtPrompt = buildPrompt(evt, userText);
            const runResult = await runClaudePrompt(
              session.key,
              builtPrompt,
              '',
              async (t) => safeReply(evt, formatThoughtMessage(t)),
              effectivePromptTimeoutMs,
            );
            replyText = runResult.text || '';
          }
        }

        if (replyText.trim()) {
          await safeReply(evt, trimReply(replyText));
          log(`[${session.key}] replied`);
        } else if (provider !== 'claude-cli' && isSkillQuery(userText)) {
          const fallback = buildSkillFallbackReply(provider, latestAvailableCommands);
          await safeReply(evt, fallback);
          log(`[${session.key}] replied with skill fallback, commands=${latestAvailableCommands.length}`);
        } else {
          await safeReply(evt, '我收到了请求，但这次模型没有返回可发送的文本。请再试一次，或发“继续”。');
          log(`[${session.key}] replied with empty-output fallback`);
        }
      } catch (err) {
        const msg = String(err);
        log(`[${session.key}] model call failed: ${msg}`);

        if (session.agent?.process) {
          killAgent(session.agent.process);
          session.agent = null;
        }

        if (msg.includes('timeout')) {
          await safeReply(evt, '任务执行超时。它可能已部分完成，请发“继续”让我接着处理。');
        } else {
          await safeReply(evt, '我这边调用模型失败了，请稍后再试。');
        }
      }
    }
  } finally {
    session.processing = false;
  }
}

function startCleanupLoop() {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = setInterval(() => {
    cleanupIdleSessions();
    cleanupSeenMessageIds();
  }, 2 * 60_000);
  cleanupTimer.unref?.();
}

function getAuthManager(bot) {
  return bot?.sessionManager?.authManager;
}

function getSessionManager(bot) {
  return bot?.sessionManager;
}

async function keepTokenFresh(bot) {
  const sessionManager = getSessionManager(bot);
  const authManager = getAuthManager(bot);
  if (!sessionManager || !authManager) return;

  const current = authManager.getCurrentTokenInfo?.();
  const ttlMs = Number(current?.expires_at || 0) - Date.now();
  const needRefresh = !Number.isFinite(ttlMs) || ttlMs <= config.tokenRefreshThresholdMs;
  if (!needRefresh) return;

  try {
    const tokenInfo = await sessionManager.getAccessToken();
    log(`[auth] token refreshed, expires_in=${tokenInfo?.expires_in ?? 'unknown'}s`);
  } catch (err) {
    log(`[auth] token refresh failed: ${String(err)}`);
  }
}

async function reconnectIfDead(bot) {
  if (reconnecting) return;
  const sessionManager = getSessionManager(bot);
  if (!sessionManager) return;
  if (sessionManager.alive) return;

  reconnecting = true;
  try {
    log('[reconnect] session not alive, restarting bot session');
    await keepTokenFresh(bot);
    await bot.stop().catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    await bot.start();
    log('[reconnect] bot session restarted');
  } catch (err) {
    log(`[reconnect] restart failed: ${String(err)}`);
  } finally {
    reconnecting = false;
  }
}

function startBotHealthLoops(bot) {
  if (tokenRefreshTimer) clearInterval(tokenRefreshTimer);
  tokenRefreshTimer = setInterval(() => {
    keepTokenFresh(bot).catch(() => {});
  }, Math.max(config.tokenRefreshCheckMs, 5000));
  tokenRefreshTimer.unref?.();

  if (reconnectTimer) clearInterval(reconnectTimer);
  reconnectTimer = setInterval(() => {
    reconnectIfDead(bot).catch(() => {});
  }, Math.max(config.reconnectCheckMs, 5000));
  reconnectTimer.unref?.();
}

async function main() {
  log('starting qqbot-ai-bridge');
  log(`sandbox=${config.sandbox}, allowGroup=${config.allowGroup}, privateEnabled=${config.privateEnabled}`);
  log(`showThoughts=${config.showThoughts}, thoughtPrefix='${config.thoughtPrefix}'`);
  const provider = getProvider();
  log(`provider=${provider}`);
  if (provider === 'claude-cli') {
    log(`claude=${config.claudeCommand} ${config.claudeArgs.join(' ')} --model ${config.claudeModel}`);
  } else if (provider === 'claude-acp') {
    log(`claude-acp=${config.claudeAcpCommand} ${config.claudeAcpArgs.join(' ')}`);
  } else {
    log(`agent=${config.agentCommand} ${config.agentArgs.join(' ')}`);
  }
  await loadPersistedSessions();

  const bot = new Bot({
    appid: config.appId,
    secret: config.appSecret,
    sandbox: config.sandbox,
    removeAt: config.removeAt,
    mode: ReceiverMode.WEBSOCKET,
    intents: config.intents,
    logLevel: process.env.QQBOT_LOG_LEVEL || 'info',
    maxRetry: Number(process.env.QQBOT_MAX_RETRY || 10),
  });

  bot.on('message.private', async (evt) => {
    try {
      if (!shouldHandle(evt)) return;
      enqueue(evt);
    } catch (err) {
      log(`[private] handler failed: ${String(err)}`);
    }
  });

  bot.on('message.group', async (evt) => {
    try {
      if (!shouldHandle(evt)) return;
      enqueue(evt);
    } catch (err) {
      log(`[group] handler failed: ${String(err)}`);
    }
  });

  bot.on('system.online', () => {
    log('qqbot online');
  });

  bot.on('system.offline', () => {
    log('qqbot offline');
    keepTokenFresh(bot).catch(() => {});
  });

  startCleanupLoop();
  await bot.start();
  await keepTokenFresh(bot);
  startBotHealthLoops(bot);
}

main().catch((err) => {
  log(`[fatal] ${String(err?.stack || err)}`);
  process.exit(1);
});
