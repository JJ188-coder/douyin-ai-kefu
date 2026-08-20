// host-bridge.js — ISOLATED world：MAIN ⇄ background/popup
// 监听 MAIN 的 postMessage → 转给 chrome.runtime（background 做 LLM / 存储）。
// 同时也把 popup 需要持久化的配置存 storage，并回推状态给 MAIN。
(() => {
  'use strict';
  const log = (...a) => console.log('[host-bridge]', ...a);

  // MAIN → background（llm 请求等）
  window.addEventListener('message', (ev) => {
    if (!ev || !ev.data) return;
    const d = ev.data;
    if (d.__aics === 'llm-req') {
      const payload = d.payload || {};
      chrome.runtime.sendMessage({ type: 'llm-chat', payload: { messages: payload.messages || [], options: payload.options || {} } }, (res) => {
        const ok = !chrome.runtime.lastError;
        window.postMessage(
          // reqId 原样带回：并发请求各认各的回复
          { __aics: 'llm-reply', reqId: d.reqId, ok: ok && !!(res && res.ok), text: ok ? res.text : '', error: ok ? (res.error || '') : (chrome.runtime.lastError.message || '') },
          window.location.origin
        );
      });
      return;
    }
    if (d.__aics === 'cmd' && d.cmd === 'get-state') {
      broadcastState();
    }
  });

  // ---- chatlog 串行批量落盘（防并发 get/set 丢消息、乱序）----
  let chatQueue = [];
  let chatWriting = false;
  async function flushChat() {
    if (chatWriting) return;
    chatWriting = true;
    try {
      while (chatQueue.length) {
        const batch = chatQueue.splice(0, 25);
        const r = await chrome.storage.local.get('chatlog');
        const arr = Array.isArray(r.chatlog) ? r.chatlog : [];
        // 去重：刷新页面时 backfill 会把同样的历史消息再推一遍，按 时间|会话|角色|内容 判重，只落新条目
        const seen = new Set(arr.map((x) => x.t + '|' + x.conv + '|' + x.who + '|' + x.text));
        const fresh = batch.filter((x) => {
          const k = x.t + '|' + x.conv + '|' + x.who + '|' + x.text;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        if (!fresh.length) continue;
        arr.push(...fresh);
        await chrome.storage.local.set({ chatlog: arr.slice(-3000) });
      }
    } catch (e) {
      log('flushChat err', e);
    } finally {
      chatWriting = false;
    }
  }
  function appendChat(payload) {
    chatQueue.push(payload);
    flushChat();
  }

  // MAIN → popup：把 bridge-* 的事件/状态转发给 popup（若无 popup 打开则忽略）
  window.addEventListener('message', (ev) => {
    if (!ev || !ev.data || typeof ev.data.__aics !== 'string') return;
    const tag = ev.data.__aics;
    if (tag && tag.startsWith('bridge-')) {
      // 对话记录额外落盘（本地复盘用）
      if (tag === 'bridge-chatlog') appendChat(ev.data.payload);
      // 运行态持久化：agent 把人工静音表/每日计数同步过来，避免刷新后丢失（不再转发给 popup 噪音）
      if (tag === 'bridge-mute-state' && ev.data.payload && typeof ev.data.payload === 'object') {
        chrome.storage.local.set({ staffMutes: ev.data.payload.mutes || {} }, () => void chrome.runtime.lastError);
        return;
      }
      if (tag === 'bridge-daily-state' && ev.data.payload && typeof ev.data.payload === 'object') {
        chrome.storage.local.set({ daily: { date: String(ev.data.payload.date || ''), count: Number(ev.data.payload.count) || 0 } }, () => void chrome.runtime.lastError);
        return;
      }
      chrome.runtime.sendMessage({ type: 'aics-event', channel: tag.slice(7), payload: ev.data.payload });
    }
  });

  function broadcastState() {
    window.postMessage({ __aics: 'state-request' }, window.location.origin);
  }

  // background 中继的命令（popup 保存配置 / 待处理「已处理」等）→ 转发给 MAIN world 的 host.js
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'aics-cmd') return;
    window.postMessage({ __aics: 'cmd', cmd: msg.cmd, payload: msg.payload }, window.location.origin);
  });

  // ---- 启动时把持久化配置下发给 MAIN（MAIN world 无法访问 chrome.storage）----
  // host.js 的 apply-config 是幂等的；MAIN 注入时序不保证，故重试几次确保送达。
  // 持久化项：配置 + 运行态（人工静音表/每日计数）。配置由 popup 写入，运行态由 agent 通过 bridge-* 回写。
  const CFG_KEYS = ['enabled', 'autoSend', 'provider', 'profile', 'kb', 'quietEnabled', 'quietFrom', 'quietTo', 'dailyLimit', 'minIntervalMs', 'maxRepliesPerConv', 'staffMuteMinutes', 'staffMutes', 'daily'];
  async function pushPersistedConfig() {
    try {
      const c = await chrome.storage.local.get(CFG_KEYS);
      if (!c || Object.keys(c).length === 0) return;   // 从未保存过配置：用 boot 默认值
      window.postMessage({ __aics: 'cmd', cmd: 'apply-config', payload: c }, window.location.origin);
      log('persisted config pushed');
    } catch (e) {
      log('pushPersistedConfig err', e);
    }
  }
  pushPersistedConfig();
  setTimeout(pushPersistedConfig, 1500);
  setTimeout(pushPersistedConfig, 4000);

  log('host-bridge up');
})();
