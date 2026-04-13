import 'dotenv/config';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

function collectText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (typeof node?.text === 'string') return node.text;
  if (Array.isArray(node)) return node.map((x) => collectText(x)).join('');
  if (Array.isArray(node?.content)) return node.content.map((x) => collectText(x)).join('');
  return '';
}

const cmd = process.env.CLAUDE_ACP_COMMAND || '/usr/local/nodejs/bin/claude-agent-acp';
const args = (process.env.CLAUDE_ACP_ARGS || '').split(/\s+/).filter(Boolean);
console.log('spawn', cmd, args.join(' '));

const proc = spawn(cmd, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: process.env.AGENT_CWD || '/home/pi',
  env: { ...process.env },
});

proc.on('exit', (code, signal) => console.log('[agent-exit]', code, signal));
proc.on('error', (err) => console.log('[agent-error]', String(err)));
proc.stderr.on('data', (d) => {
  const text = String(d || '').trim();
  if (text) console.log('[agent-stderr]', text);
});

const stream = acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout));
const typeCounts = {};
const chunks = [];

const client = {
  async sessionUpdate(params) {
    const u = params?.update || {};
    const t = String(u.sessionUpdate || 'unknown');
    typeCounts[t] = (typeCounts[t] || 0) + 1;

    if (t === 'agent_message_chunk') {
      const c = collectText(u.content);
      if (c) chunks.push(c);
    }
    if (t === 'agent_message' || t === 'message') {
      const c = collectText(u.content) || collectText(u.message) || collectText(u);
      if (c) chunks.push(c);
    }
  },
  async requestPermission(params) {
    const options = Array.isArray(params?.options) ? params.options : [];
    const opt = options.find((o) => o.kind === 'allow_always' || o.kind === 'allow_once') || options[0];
    if (!opt) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: opt.optionId } };
  },
  async readTextFile() {
    return { content: '' };
  },
  async writeTextFile() {
    return {};
  },
};

const conn = new acp.ClientSideConnection(() => client, stream);

try {
  const init = await conn.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: { name: 'acp-probe', title: 'acp-probe', version: '0.0.1' },
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  console.log('init-ok', Boolean(init));
  console.log('agent-capabilities', JSON.stringify(init?.agentCapabilities || {}));

  const ns = await conn.newSession({ cwd: process.env.AGENT_CWD || '/home/pi', mcpServers: [] });
  console.log('session', ns.sessionId);

  const result = await conn.prompt({
    sessionId: ns.sessionId,
    prompt: [{ type: 'text', text: process.argv[2] || '你是谁？请一句话回答。' }],
  });

  const resultText = collectText(result?.content)
    || collectText(result?.message)
    || collectText(result?.messages)
    || collectText(result?.result)
    || collectText(result?.response)
    || collectText(result?.output)
    || collectText(result?.completion)
    || collectText(result?.final)
    || collectText(result?.text);

  console.log('stopReason', result?.stopReason || 'unknown');
  console.log('result-keys', Object.keys(result || {}).join(','));
  console.log('chunk-text-len', chunks.join('').length);
  console.log('result-text-len', String(resultText || '').length);
  console.log('update-types', JSON.stringify(typeCounts));
} catch (err) {
  console.log('[probe-error]', String(err));
}

try {
  proc.kill('SIGTERM');
} catch {}
setTimeout(() => {
  try {
    proc.kill('SIGKILL');
  } catch {}
}, 1000).unref();
