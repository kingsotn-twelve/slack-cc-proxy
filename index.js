'use strict';
require('dotenv').config();
const { App } = require('@slack/bolt');
const { spawn } = require('child_process');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const ALLOWED_USER    = process.env.ALLOWED_USER_ID;
const WORK_DIR        = process.env.WORKING_DIR;
const CLAUDE_BIN      = '/Users/kingsotn-twelve/.local/bin/claude';
const MCP_CONFIG      = '/tmp/slack-cc-empty-mcp.json';
const API_KEY         = process.env.ANTHROPIC_API_KEY || '';

require('fs').writeFileSync(MCP_CONFIG, JSON.stringify({mcpServers:{}}));

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN || !ALLOWED_USER || !WORK_DIR) {
  console.error('Missing env vars'); process.exit(1);
}

// Use Anthropic SDK if a real key is present (sk-ant-api... or sk-ant-sid...)
const USE_SDK = API_KEY.startsWith('sk-ant-api') || API_KEY.startsWith('sk-ant-sid');
let anthropic = null;
if (USE_SDK) {
  const Anthropic = require('@anthropic-ai/sdk');
  anthropic = new Anthropic({ apiKey: API_KEY });
  console.log('FAST MODE: Anthropic SDK enabled (~1-3s per message)');
} else {
  console.log('NORMAL MODE: Claude subprocess (~10-15s). Add sk-ant-api key to .env for 3s.');
}

// ---------------------------------------------------------------------------
// Fast path: Anthropic SDK streaming
// ---------------------------------------------------------------------------
async function askSDK(text, history, onChunk) {
  const messages = [...history, { role: 'user', content: text }];
  const stream = anthropic.messages.stream({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    system: 'You are Claude Code running in the TwelveLabs tl-api repo. Be concise.',
    messages,
  });
  let acc = '';
  stream.on('text', (t) => { acc += t; onChunk(acc); });
  const final = await stream.finalMessage();
  const cost = final.usage.input_tokens * 0.00000025 + final.usage.output_tokens * 0.00000125;
  return { result: acc, cost };
}

// ---------------------------------------------------------------------------
// Normal path: claude subprocess
// ---------------------------------------------------------------------------
function askClaude(text, continueSession, onChunk) {
  return new Promise((resolve, reject) => {
    const args = ['--dangerously-skip-permissions', '--model', 'claude-haiku-4-5-20251001',
      '--output-format', 'stream-json', '--verbose'];
    if (continueSession) args.push('--continue');
    args.push('-p', text);

    const env = Object.assign({}, process.env);
    delete env.CLAUDECODE; delete env.ANTHROPIC_API_KEY;

    const proc = spawn(CLAUDE_BIN, args, { cwd: WORK_DIR, env, stdio: ['ignore','pipe','pipe'] });
    let buf = '', acc = '', t0 = Date.now();
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'assistant')
            for (const b of ((ev.message && ev.message.content) || []))
              if (b.type === 'text' && b.text) { acc += b.text; onChunk(acc); }
          if (ev.type === 'result' && ev.subtype === 'success')
            resolve({ result: ev.result || acc, durationMs: Date.now()-t0, costUsd: ev.total_cost_usd });
          if (ev.type === 'result' && ev.is_error) reject(new Error(ev.result || 'Claude error'));
        } catch {}
      }
    });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Timeout 5min')); }, 5*60*1000);
    proc.on('close', (code) => { clearTimeout(timer); if (code !== 0 && !acc) reject(new Error('exit '+code)); });
    proc.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------
const app = new App({ token: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN, socketMode: true, logLevel: 'warn' });
let DM_CHANNEL = null;
const histories = new Map();  // for SDK mode
const sessions = new Set();   // for subprocess --continue

function fmtMs(ms) { return ms < 60000 ? (ms/1000).toFixed(1)+'s' : Math.floor(ms/60000)+'m'+Math.floor((ms%60000)/1000)+'s'; }
function trim(t, max) { max=max||3800; return t.length<=max?t:'...'+t.slice(-(max-3)); }

app.message(async function({ message, client }) {
  if (message.channel_type !== 'im') return;
  if (message.user !== ALLOWED_USER) return;
  if (message.subtype) return;
  const text = message.text && message.text.trim();
  if (!text) return;

  const threadTs = message.thread_ts || message.ts;
  const chan = DM_CHANNEL || message.channel;

  if (/^reset\b/i.test(text)) {
    histories.delete(threadTs); sessions.delete(threadTs);
    await client.chat.postMessage({ channel: chan, thread_ts: threadTs, text: 'Reset.' });
    return;
  }

  const posted = await client.chat.postMessage({ channel: chan, thread_ts: threadTs, text: '_..._' })
    .catch(function(e) { console.log('post err:', e.message); return null; });
  if (!posted) return;

  let lastText='', lastAt=0;
  function liveUpdate(t) {
    t = trim(t); if (t === lastText) return; lastText = t;
    const now = Date.now(); if (now-lastAt < 600) return; lastAt = now;
    client.chat.update({ channel: chan, ts: posted.ts, text: t }).catch(function(){});
  }

  const t0 = Date.now();
  try {
    let result, meta;
    if (USE_SDK) {
      const history = histories.get(threadTs) || [];
      const out = await askSDK(text, history, liveUpdate);
      result = out.result;
      history.push({ role: 'user', content: text }, { role: 'assistant', content: result });
      if (history.length > 20) history.splice(0, 2);
      histories.set(threadTs, history);
      const elapsed = Date.now()-t0;
      meta = '\n\n_' + fmtMs(elapsed) + ' $' + out.cost.toFixed(4) + ' · reply to continue · reset_';
    } else {
      const isContinue = sessions.has(threadTs);
      const out = await askClaude(text, isContinue, liveUpdate);
      sessions.add(threadTs);
      result = out.result;
      const costStr = out.costUsd ? ' $'+out.costUsd.toFixed(4) : '';
      meta = '\n\n_' + fmtMs(out.durationMs) + costStr + ' · reply to continue · reset_';
    }
    await client.chat.update({ channel: chan, ts: posted.ts, text: trim(result) + meta });
    await client.reactions.add({ channel: chan, timestamp: message.ts, name: 'white_check_mark' }).catch(function(){});
  } catch(err) {
    console.log('err:', err.message);
    await client.chat.update({ channel: chan, ts: posted.ts, text: 'Error: '+err.message }).catch(function(){});
    await client.reactions.add({ channel: chan, timestamp: message.ts, name: 'x' }).catch(function(){});
  }
});

(async function() {
  await app.start();
  try { const r = await app.client.conversations.open({ users: ALLOWED_USER }); DM_CHANNEL = r.channel.id; }
  catch(e) { console.log('WARN:', e.message); }
  console.log('slack-cc-proxy running  dm='+DM_CHANNEL);
})();
