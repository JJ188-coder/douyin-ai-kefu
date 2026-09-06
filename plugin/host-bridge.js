// host-bridge.js — ISOLATED world：MAIN ⇄ background/popup
// 监听 MAIN 的 postMessage → 转给 chrome.runtime（background 做 LLM / 存储）。
// 同时也把 popup 需要持久化的配置存 storage，并回推状态给 MAIN。
(() => {
  'use strict';
  const log = (...a) => console.log('[host-bridge]', ...a);
  let configAcknowledged = false;
  let configRevision = 0;
  let configPushing = false;
  let startupConfig;
  const startupPatch = {};
  const startupCommands = [];

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
      if (!configAcknowledged && tag === 'bridge-config-applied' && ev.data.payload?.ok && ev.data.payload.cmd === 'apply-config' && ev.data.payload.configRevision === configRevision) {
        configAcknowledged = true;
        const queued = startupCommands.splice(0);
        for (const cmd of queued) window.postMessage({ __aics: 'cmd', ...cmd }, window.location.origin);
        if (queued.length) window.postMessage({ __aics: 'cmd', cmd: 'apply-config', payload: startupConfig }, window.location.origin);
      }
      if (tag === 'bridge-ready') pushPersistedConfig();
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
    const payload = msg.cmd === 'apply-config' ? pageConfig(msg.payload) : msg.payload;
    if (!configAcknowledged && msg.cmd !== 'get-state') {
      configRevision += 1;
      if (msg.cmd === 'apply-config') Object.assign(startupPatch, payload);
      else if (msg.cmd === 'enable') Object.assign(startupPatch, { enabled: true, autoSend: !!payload?.autoSend });
      else if (msg.cmd === 'disable') {
        startupPatch.enabled = false;
        window.postMessage({ __aics: 'cmd', cmd: 'disable' }, window.location.origin);
      } else startupCommands.push({ cmd: msg.cmd, payload });
      pushPersistedConfig();
      return;
    }
    window.postMessage({ __aics: 'cmd', cmd: msg.cmd, payload }, window.location.origin);
  });

  // ---- 启动时把持久化配置下发给 MAIN（MAIN world 无法访问 chrome.storage）----
  // host.js 的 apply-config 是幂等的；MAIN 注入时序不保证，故重试几次确保送达。
  // 持久化项：配置 + 运行态（人工静音表/每日计数）。配置由 popup 写入，运行态由 agent 通过 bridge-* 回写。
  const CFG_KEYS = ['enabled', 'autoSend', 'provider', 'profile', 'kb', 'quietEnabled', 'quietFrom', 'quietTo', 'dailyLimit', 'minIntervalMs', 'maxRepliesPerConv', 'staffMuteMinutes', 'staffMutes', 'daily'];
  function pageConfig(c) {
    return Object.fromEntries(CFG_KEYS.filter((k) => c && Object.prototype.hasOwnProperty.call(c, k)).map((k) => [k, c[k]]));
  }
  async function pushPersistedConfig() {
    if (configAcknowledged || configPushing) return;
    configPushing = true;
    try {
      const c = await chrome.storage.local.get(CFG_KEYS);
      if (configAcknowledged) return;
      startupConfig = { ...pageConfig(c), enabled: c?.enabled !== false, ...startupPatch };
      // 先恢复运行态，再执行启动期间的解除静音/重置命令，最后才允许接待消息。
      const payload = startupCommands.length ? { ...startupConfig, enabled: false } : startupConfig;
      window.postMessage({ __aics: 'cmd', cmd: 'apply-config', payload, configRevision }, window.location.origin);
      log('persisted config pushed');
    } catch (e) {
      log('pushPersistedConfig err', e);
    } finally {
      configPushing = false;
    }
  }
  pushPersistedConfig();
  setTimeout(pushPersistedConfig, 1500);
  setTimeout(pushPersistedConfig, 4000);

  log('host-bridge up');
})();
