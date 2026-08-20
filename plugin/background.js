// background.js — MV3 service worker
// 职责：
//   1) （推荐路径）在后台做 LLM fetch(OpenAI 兼容) — 用 host_permissions 绕过页面 CORS，
//     且 API key 只存在于 service worker / chrome.storage，不注入页面。
//   2) 中转 MAIN world ⇄ ISOLATED(popup/存储) 的消息。
self.chrome = self.chrome || chrome;

const PROVIDER_BASE = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  volc: 'https://ark.cn-beijing.volces.com/api/v3',
  siliconflow: 'https://api.siliconflow.cn/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

async function cfg() {
  const c = await chrome.storage.local.get(['apiKey', 'apiBase', 'provider', 'model', 'temperature']);
  return {
    apiKey: c.apiKey || '',
    apiBase: c.apiBase || PROVIDER_BASE[c.provider] || PROVIDER_BASE.deepseek,
    provider: c.provider || 'deepseek',
    model: c.model || (c.provider === 'deepseek' ? 'deepseek-chat' : c.provider === 'moonshot' ? 'moonshot-v1-8k' : 'deepseek-chat'),
    temperature: c.temperature ?? 0.9,
  };
}

// ---- LLM chat（OpenAI 兼容）----
async function chat({ model, apiKey, apiBase, temperature, messages, maxTokens }) {
  const body = {
    model,
    temperature: Number(temperature) || 0.9,
    messages,
  };
  const maxTok = Number(maxTokens);
  if (Number.isFinite(maxTok) && maxTok > 0) body.max_tokens = maxTok;
  let resp;
  try {
    resp = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: '网络请求失败: ' + e.message };
  }
  if (!resp.ok) {
    let detail = '';
    try {
      const j = await resp.json();
      detail = j?.error?.message || JSON.stringify(j).slice(0, 300);
    } catch (_) {
      detail = await resp.text().catch(() => '');
    }
    return { ok: false, error: `HTTP ${resp.status}: ${detail}` };
  }
  const j = await resp.json();
  const text = j?.choices?.[0]?.message?.content || '';
  return { ok: true, text };
}

// ---- 命令中继：popup → 本 worker → 客服台页面的 host-bridge（ISOLATED）----
// 解决 popup 的 window.postMessage 到不了页面的问题：配置保存/开关/解除静音即改即生效。
function relayCmdToCsTabs(cmd, payload) {
  chrome.tabs.query({ url: 'https://life.douyin.com/cs/web*' }, (tabs) => {
    for (const t of tabs || []) {
      chrome.tabs.sendMessage(t.id, { type: 'aics-cmd', cmd, payload }, () => void chrome.runtime.lastError);
    }
  });
}

// ---- 待人工处理：AI 答不了的买家问题，通知店主 ----
async function updateBadge() {
  const r = await chrome.storage.local.get('pendingHuman');
  const n = (Array.isArray(r.pendingHuman) ? r.pendingHuman : []).filter((x) => !x.done).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#f53f3f' });
  await chrome.action.setBadgeText({ text: n ? String(n) : '' });
}

// pendingHuman 的 get→改→set 串行化：needs-human 事件可能并发/重发，
// 不串行会出现读旧数组互相覆盖、待处理重复、角标不准。
let pendingQueue = Promise.resolve();
function withPendingHuman(fn) {
  pendingQueue = pendingQueue.then(async () => {
    const r = await chrome.storage.local.get('pendingHuman');
    const arr = Array.isArray(r.pendingHuman) ? r.pendingHuman : [];
    const next = await fn(arr);
    if (next !== arr) await chrome.storage.local.set({ pendingHuman: next });
    return next;
  });
  return pendingQueue;
}

// ---- 飞书通知：支持「群自定义机器人 webhook」或「开放平台自建应用 API」两种方式 ----
// webhook：在飞书客户端「群设置 → 群机器人 → 自定义机器人」创建，拿 https://open.feishu.cn/open-apis/bot/v2/hook/…
// API：用「您的自建应用」这类自建应用（app_id+app_secret）以机器人身份发到群 chat_id
async function feishuSend(text) {
  const c = await chrome.storage.local.get(['feishuWebhook', 'feishuAppId', 'feishuAppSecret', 'feishuChatId']);
  const webhook = (c.feishuWebhook || '').trim();
  if (webhook) {
    try {
      const resp = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg_type: 'text', content: { text } }),
      });
      const j = await resp.json().catch(() => ({}));
      if (j.code === 0 || j.StatusCode === 0) return { ok: true };
      return { ok: false, error: j.msg || j.message || ('HTTP ' + resp.status) };
    } catch (e) {
      return { ok: false, error: '飞书请求失败: ' + e.message };
    }
  }
  const appId = (c.feishuAppId || '').trim();
  const appSecret = (c.feishuAppSecret || '').trim();
  const chatId = (c.feishuChatId || '').trim();
  if (appId && appSecret && chatId) {
    try {
      const tr = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      });
      const tj = await tr.json();
      if (tj.code !== 0 || !tj.tenant_access_token) return { ok: false, error: '飞书 token 失败: ' + (tj.msg || ('code ' + tj.code)) };
      const resp = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tj.tenant_access_token },
        body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) }),
      });
      const j = await resp.json();
      if (j.code === 0) return { ok: true };
      return { ok: false, error: '飞书发送失败: ' + (j.msg || ('code ' + j.code)) };
    } catch (e) {
      return { ok: false, error: '飞书请求失败: ' + e.message };
    }
  }
  return { ok: false, error: '未配置飞书通知（webhook 或 API）' };
}

async function handleNeedsHuman(p) {
  const isFollowup = p && p.kind === 'followup';   // 转办承诺：AI 答了但承诺了要人办的事；区别于"答不了"
  const now = Date.now();
  const item = {
    id: now + '_' + Math.random().toString(36).slice(2, 8),
    t: now,
    conv: String(p.conversationId || ''),
    buyer: String(p.buyerText || '').slice(0, 200),
    reply: String(p.reply || '').slice(0, 200),
    kind: isFollowup ? 'followup' : 'human',
    done: false,
  };
  // 同会话同买家话术 10 分钟冷却内不重复提醒（SDK 重推/连发合并可能反复触发同一 needs-human）
  const COOLDOWN_MS = 10 * 60 * 1000;
  const added = await withPendingHuman((arr) => {
    const hit = arr.find((x) => !x.done && x.conv === item.conv && x.buyer === item.buyer && (now - (Number(x.t) || 0)) < COOLDOWN_MS);
    if (hit) return arr;
    return arr.concat(item).slice(-50);
  });
  if (added.length && added[added.length - 1].id === item.id) updateBadge();
  else return;
  // 桌面通知（静默模式：只弹横幅不响铃，声音提醒走飞书手机端；macOS 需在系统设置允许 Chrome 通知；失败不影响角标/飞书）
  try {
    chrome.notifications.create('nh_' + item.id, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: isFollowup ? '抖音客服：AI 向买家承诺了事，需要你落实' : '抖音客服：有买家问题需要人工处理',
      message: '买家：' + item.buyer,
      priority: 2,
      silent: true,
    });
  } catch (e) { /* 通知不可用时静默 */ }
  // 飞书推送
  const time = new Date(item.t).toLocaleString('zh-CN', { hour12: false });
  feishuSend(isFollowup
    ? '📌 抖音客服·承诺转办\n' +
      '买家：' + item.buyer + '\n' +
      'AI 已回复：' + item.reply + '\n' +
      '时间：' + time + '\n' +
      'AI 已向买家承诺了要人办的事（加 VX/回电/专员对接/核实等），请按承诺跟进落实；该会话 AI 仍在正常接待。'
    : '🔔 抖音客服·需要人工介入\n' +
      '买家：' + item.buyer + '\n' +
      'AI 已兜底回复：' + item.reply + '\n' +
      '时间：' + time + '\n' +
      '请到客服台处理（该会话已自动静音 15 分钟，你发消息即接管）'
  ).then((res) => { if (!res.ok) console.warn('[background] 飞书推送失败:', res.error); });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  switch (msg.type) {
    case 'llm-chat': {
      // MAIN world 经由 host-bridge → 本 worker 发起真实 LLM 请求
      cfg().then(async (c) => {
        if (!c.apiKey) {
          sendResponse({ ok: false, error: '未配置 API Key，请到插件弹层填写' });
          return;
        }
        const prompt = msg.payload && msg.payload.messages;
        if (!Array.isArray(prompt)) {
          sendResponse({ ok: false, error: 'payload.messages 缺失' });
          return;
        }
        const opts = msg.payload && msg.payload.options;
        const maxTokens = opts && Number(opts.maxTokens);
        const res = await chat({ ...c, messages: prompt, maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : undefined });
        sendResponse(res);
      }).catch((e) => {
        sendResponse({ ok: false, error: '后台异常: ' + e.message });
      });
      return true; // 异步响应
    }
    case 'cfg-get': {
      cfg().then(sendResponse);
      return true;
    }
    case 'cfg-set': {
      const patch = msg.payload || {};
      chrome.storage.local.set(patch, () => sendResponse({ ok: true }));
      return true;
    }
    case 'aics-cmd': {
      // popup 命令中继到客服台页面（apply-config / enable / disable / unmute-conv …）
      relayCmdToCsTabs(msg.cmd, msg.payload);
      sendResponse({ ok: true });
      return true;
    }
    case 'feishu-test': {
      feishuSend('✅ 测试消息：抖音客服插件 ↔ 飞书 通知通道已连通。AI 答不了买家问题时会推送到这里。')
        .then(sendResponse);
      return true;
    }
    case 'pending-list': {
      chrome.storage.local.get('pendingHuman', (r) => {
        sendResponse({ list: Array.isArray(r.pendingHuman) ? r.pendingHuman : [] });
      });
      return true;
    }
    case 'pending-done': {
      const id = msg.payload && msg.payload.id;
      const conv = msg.payload && msg.payload.conversationId;
      withPendingHuman((arr) => {
        const it = arr.find((x) => x.id === id);
        if (it) it.done = true;
        return arr;
      }).then(() => {
        updateBadge();
        if (conv) relayCmdToCsTabs('unmute-conv', { conversationId: conv }); // 你已处理 → 该会话 AI 恢复
        sendResponse({ ok: true });
      });
      return true;
    }
    case 'pending-clear': {
      withPendingHuman(() => []).then(() => { updateBadge(); sendResponse({ ok: true }); });
      return true;
    }
    case 'aics-event': {
      // 事件日志持久化：popup 打开时回显最近 100 条（复盘/排查用）
      const { channel, payload } = msg;
      if (!channel || channel === 'chatlog') return false;   // 对话记录单独落盘，不入事件日志
      const p = payload || {};
      let level = 'ok', text = channel;
      switch (channel) {
        case 'sent': text = '已回复 ' + String(p.reply || '').slice(0, 60); break;
        case 'preview': text = 'AI建议回复：' + String(p.reply || '').slice(0, 60); break;
        case 'notice': level = p.level === 'error' ? 'error' : (p.level === 'warn' ? 'warn' : 'ok'); text = String(p.text || ''); break;
        case 'assigned': text = '新会话已转人工接管'; break;
        case 'needs-human':
          level = 'warn';
          text = '需要人工：买家问「' + String(p.buyerText || '').slice(0, 40) + '」';
          handleNeedsHuman(p);
          break;
        case 'ready': text = '页面已连接，插件就绪'; break;
        case 'config-applied': text = p.ok ? '配置已应用' : '配置应用失败'; level = p.ok ? 'ok' : 'error'; break;
        default: text = channel;
      }
      chrome.storage.local.get('events', (r) => {
        const arr = Array.isArray(r.events) ? r.events : [];
        arr.push({ t: Date.now(), channel, level, text });
        chrome.storage.local.set({ events: arr.slice(-100) });
      });
      return false;
    }
    default:
      return false;
  }
});
