// host.js — MAIN world 与 ISOLATED world 的双向桥（配置/命令/状态回传）
// 由 manifest 的 MAIN content_script 随 core 一起注入。
(() => {
  'use strict';
  const log = (...a) => console.log('[host]', ...a);

  // MAIN → ISOLATED：把内部状态/事件广播给 host-bridge（进而到 popup）
  function publish(channel, data) {
    window.postMessage({ __aics: 'bridge-' + channel, payload: data }, window.location.origin);
  }

  // 兜底：等待 store 就绪后自动 enable（配置由 popup/host-bridge 注入后再二次应用）
  let started = false;

  // 回填最近会话消息到对话记录（只读，不触发回复）
  async function backfillChatlog() {
    try {
      const bridge = window.__storeBridge;
      const cs = bridge && bridge.getChatStore();
      const sdk = cs && cs._imSdkStore;
      if (!sdk || typeof sdk.getMessagesByConversation !== 'function') return;
      const bizType = (cs._config && cs._config.pigeonBizType) || '7';
      const convStore = cs._conversationStore && cs._conversationStore.totalContacts;
      if (!convStore) return;
      const convIds = [];
      convStore.forEach((c) => { if (c && c.bizConversationId) convIds.push(c.bizConversationId); });
      const seen = new Set();
      for (const conv of convIds.slice(0, 6)) {   // 最多回填 6 个会话
        let msgs;
        try { msgs = await sdk.getMessagesByConversation(bizType, conv); } catch (e) { continue; }
        const arr = msgs && msgs.slice ? msgs.slice() : msgs || [];
        for (const m of arr.slice(-20)) {          // 每会话最近 20 条
          let who;
          try { who = bridge.classifyMessage(m); } catch (e) { continue; }
          if (who === 'system') continue;
          const text = String(m.content || '').trim();
          if (!text) continue;
          const dedupKey = 'bf|' + conv + '|' + who + '|' + text;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);
          publish('chatlog', {
            t: new Date(m.createTime || Date.now()).toISOString(),
            conv: String(conv).slice(-12),
            who: who === 'buyer' ? 'buyer' : (who === 'aiSelf' ? 'ai' : (who === 'platformAi' ? 'platform' : 'staff')),
            text: text.slice(0, 500),
          });
        }
      }
      log('chatlog backfilled');
    } catch (e) {
      log('backfill err', e);
    }
  }

  function boot() {
    if (started) return;
    const bridge = window.__storeBridge;
    const agent = window.__agent;
    if (!bridge || !agent || !bridge.getChatStore()) {
      setTimeout(boot, 800);
      return;
    }
    started = true;
    agent.enable();   // 不带参：避免覆盖 host-bridge 随后下发的持久化配置
    publish('ready', { storeFound: true });
    log('store found; agent auto-enabled (waiting config from popup)');

    // 把 store-bridge 的 emit 事件也转发给 popup
    bridge.on('sent', (d) => publish('sent', d));
    bridge.on('preview', (d) => publish('preview', d));
    bridge.on('notice', (d) => publish('notice', d));
    // AI 答不了 → 转 background 通知店主（角标/桌面通知/飞书）
    bridge.on('needs-human', (d) => publish('needs-human', d));

    // ---- 对话记录：买家/AI/人工客服 的往来消息，落本地供复盘分析 ----
    const lastChat = new Map();   // 去重：同会话同内容 3s 内只记一次
    const chatDedup = (key) => {
      const now = Date.now();
      if (lastChat.has(key) && now - lastChat.get(key) < 3000) return false;
      lastChat.set(key, now);
      return true;
    };
    bridge.on('message', (item) => {
      let who = 'buyer';
      try { who = bridge.classifyMessage(item); } catch (e) { /* ignore */ }
      if (who === 'system') return;                       // 事件/系统消息不入复盘
      const text = String(item.content || '').trim();
      if (!text) return;
      const key = String(item.conversationId) + '|' + who + '|' + text;
      if (!chatDedup(key)) return;
      publish('chatlog', {
        t: new Date(item.timestamp || Date.now()).toISOString(),
        conv: String(item.conversationId || '').slice(-12),
        who: who === 'buyer' ? 'buyer' : (who === 'platformAi' ? 'platform' : 'staff'),
        text: text.slice(0, 500),
      });
    });
    bridge.on('sent', (d) => {
      const key = 'sent|' + String(d.conversationId) + '|' + String(d.reply);
      if (!chatDedup(key)) return;
      publish('chatlog', {
        t: new Date().toISOString(),
        conv: String(d.conversationId || '').slice(-12),
        who: 'ai',
        text: String(d.reply || '').slice(0, 500),
      });
    });
    // 人工客服实时发的消息也进对话记录（store-bridge 的 message 事件只推买家消息，人工走 staff-activity）
    bridge.on('staff-activity', (item) => {
      const text = String(item.content || '').trim();
      if (!text) return;
      const key = String(item.conversationId) + '|staff|' + text;
      if (!chatDedup(key)) return;
      publish('chatlog', {
        t: new Date(item.timestamp || Date.now()).toISOString(),
        conv: String(item.conversationId || '').slice(-12),
        who: 'staff',
        text: text.slice(0, 500),
      });
    });

    // 回填最近会话历史到对话记录（只读消息、只做记录，不触发任何回复）
    setTimeout(backfillChatlog, 2000);
  }

  window.addEventListener('message', (ev) => {
    if (!ev || !ev.data || ev.data.__aics !== 'cmd') return;
    const { cmd, payload } = ev.data;
    const bridge = window.__storeBridge;
    const agent = window.__agent;
    if (!bridge || !agent) return;
    try {
      switch (cmd) {
        case 'apply-config': {
          // payload：{enabled, autoSend, provider, profile, quiet...}
          agent.applyConfig(payload || {});
          if (agent.getState().enabled) agent.enable(); // 幂等：已有 listener 则不变
          publish('config-applied', { ok: true });
          break;
        }
        case 'enable': agent.enable({ autoSend: !!payload?.autoSend }); publish('config-applied', { ok: true }); break;
        case 'disable': agent.disable(); publish('config-applied', { ok: true }); break;
        case 'unmute-conv':
          // 店主在待处理列表点了「已处理」→ 解除该会话人工静音，AI 恢复接管
          if (payload && payload.conversationId && agent.unmuteConv) agent.unmuteConv(payload.conversationId);
          publish('config-applied', { ok: true });
          break;
        case 'get-state':
          publish('state', {
            enabled: agent.getState().enabled,
            autoSend: agent.getState().autoSend,
            provider: agent.getState().provider,
            dailyCount: agent.getState().dailyCount,
            dailyLimit: agent.getState().dailyLimit,
            assigned: [...agent.getState().assigned.keys()].length,
          });
          break;
        case 'send-test': {
          // 联调：手动让一条测试消息走完整管线（autoSend=false→只预览）
          const payload2 = payload || {};
          agent.handleMessage({
            conversationId: payload2.conversationId,
            content: payload2.text || '测试：在吗？',
            isFromMe: false,
            type: 'text',
            senderRole: '3',
          }).catch((e) => log('send-test err', e));
          publish('config-applied', { ok: true });
          break;
        }
        default:
          log('unknown cmd', cmd);
      }
    } catch (e) {
      log('cmd error', cmd, e);
      publish('config-applied', { ok: false, error: e.message });
    }
  });

  boot();
  log('host bridge up');
})();
