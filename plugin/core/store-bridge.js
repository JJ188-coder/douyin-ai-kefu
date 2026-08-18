// store-bridge.js — 接管飞鸽页面内部 store 的桥（content script / page 内联均可）
// 目标：把「转人工后 AI 自动回复」需要的页面能力包成稳定接口。
// 依据 `docs/REQUIREMENTS.md` 已实锤的 live store 结构。
// 注意：本模块不强依赖 DOM 选择器，只依赖页面的公开运行时对象。

(function () {
  'use strict';

  // ---- 1. 定位页面里的 store（Garfish 沙箱）----
  function getChatStore() {
    const g = window.Garfish && window.Garfish.apps && window.Garfish.apps.cs_web;
    const global = g && g.global;
    return global && global._chatStore ? global._chatStore : null;
  }

  // ---- 2. 事件总线（供 content script 使用，模拟简单 pub/sub）----
  const listeners = {};
  function on(evt, fn) {
    (listeners[evt] = listeners[evt] || []).push(fn);
    return () => off(evt, fn);
  }
  function off(evt, fn) {
    const arr = listeners[evt] || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  function emit(evt, data) {
    (listeners[evt] || []).forEach((fn) => {
      try { fn(data); } catch (e) { console.error('[store-bridge] emit fail', evt, e); }
    });
  }

  // ---- 3. 工具：安全的 MobX/plain 深度读出 ----
  function snap(v) {
    if (v == null) return v;
    if (typeof v !== 'object') return v;
    // 把 ObservableMap / Map 转 plain object
    if (typeof v.forEach === 'function' && typeof v.get === 'function' && typeof v.keys === 'function') {
      const o = {};
      v.forEach((val, key) => { o[key] = snap(val); });
      return o;
    }
    if (Array.isArray(v) || typeof v.slice === 'function') {
      return Array.prototype.slice.call(v).map(snap);
    }
    const o = {};
    for (const k of Object.keys(v)) {
      try { o[k] = snap(v[k]); } catch (e) { o[k] = undefined; }
    }
    return o;
  }

  // ---- 4. 只读映射：会话 → 结构 ----
  function listConversations() {
    const cs = getChatStore();
    if (!cs) return [];
    const conv = cs._conversationStore;
    if (!conv || !conv.totalContacts) return [];
    const out = [];
    try {
      conv.totalContacts.forEach((c, key) => {
        out.push({
          key,
          bizConversationId: c.bizConversationId,
          type: c.type,
          closed: !!(c.rawConversation && c.rawConversation.closed) || c.closed === true,
          pigeonUid: c.pigeonUid,
          unread: c.unreadCount,
          lastMessage: c.lastEyeableMessage
            ? {
                type: c.lastEyeableMessage.pigeonMsgType,
                content: c.lastEyeableMessage.content,
                isFromMe: c.lastEyeableMessage.isFromMe,
                senderRole: c.lastEyeableMessage.senderRole,
              }
            : null,
        });
      });
    } catch (e) {
      console.error('[store-bridge] listConversations fail', e);
    }
    return out;
  }

  // ---- 5. 发送文本：直接用页面 SDK ----
  // opts: { ai:boolean } —— 传 ai=true 会在 bizExt 打 aiFlag=1 标记，便于回读时识别「这是 AI 回的」
  function sendText(conversationId, content, opts) {
    const cs = getChatStore();
    if (!cs || !cs._imSdkStore) throw new Error('imSdkStore not ready');
    const bizType = (cs._config && cs._config.pigeonBizType) || '7';
    const bizExt = (opts && opts.ai) ? { aiFlag: '1' } : (opts && opts.bizExt) || {};
    try {
      return cs._imSdkStore.sendText(bizType, conversationId, content, bizExt);
    } catch (e) {
      // 某些版本 sendText 只接受 3 参，降级为不带 biExt
      console.warn('[store-bridge] sendText(4-arg) failed, fallback 3-arg:', e && e.message);
      return cs._imSdkStore.sendText(bizType, conversationId, content);
    }
  }

  // ---- 5.1 消息角色分类：区分买家/人工客服/AI 自己/系统 ----
  // 买家：isFromMe=false（senderRole 1/3 多属买家）
  // AI 自己：我们发的（bizExt.aiFlag=1）
  // 人工客服：isFromMe=true 且非 AI 标记（senderRole=2）
  // 系统/事件：allocated_service / close / 空内容
  function classifyMessage(msg) {
    const ext = (msg && msg.bizExt) || {};
    const oext = (msg && msg.originExt) || {};
    const type = msg.pigeonMsgType || msg.messageType || oext.type;
    // 事件型
    if (type === 'allocated_service' || type === 'close_conversation' || type === 'user_enter_time') {
      return 'system';
    }
    // AI 自己发的（历史兼容：aiFlag 标记；新发的靠发送记录内容匹配识别，不再往 bizExt 打标——平台会显示 AI 标识）
    if (ext.aiFlag === '1' || ext.sender === 'ai' || oext.aiFlag === '1') {
      return 'aiSelf';
    }
    if (msg.isFromMe === false) {
      return 'buyer';
    }
    if (msg.isFromMe === true) {
      return isSent(msg.content) ? 'aiSelf' : 'staff';
    }
    return 'system';
  }

  // ---- 6.1 判断会话是否"当前人工接待"状态 ----
  // 场景：已有 current 会话（人工客服已在接待），买家发新消息时不会再触发 allocated_service，
  // 但只要会话是 current 且未关闭，就应按"已转人工"接管。
  function isConversationLive(conversationId) {
    const cs = getChatStore();
    if (!cs || !cs._conversationStore) return false;
    const conv = cs._conversationStore.totalContacts
      ? cs._conversationStore.totalContacts.get(conversationId)
      : null;
    if (!conv) return false;
    const closed = !!(conv.rawConversation && conv.rawConversation.closed) || conv.closed === true;
    if (closed) return false;
    return true; // 无论 type=current/history 只要未关闭即视为可接管
  }

  // ---- 6. 判断「这个会话是否已转人工 / 值得接管」 ----
  // 依据：allocated_service（is_allocated_event=1）消息 = 已分配人工客服。
  function shouldTakeOver(message) {
    if (!message) return false;
    if (message.pigeonMsgType === 'allocated_service') return true;
    const ext = message.originExt || {};
    return ext.type === 'allocated_service' || ext.is_allocated_event === '1';
  }

  // ---- 7. 包一层：订阅消息，自动把「买家消息」+「转人工事件」+「人工客服活动」派发出来 ----
  // opts: { onMessage, onAssign, onStaff } —— 直接回调（比事件总线更可靠，避免事件名错位）
  function startListening(opts = {}) {
    const cs = getChatStore();
    if (!cs || !cs._imSdkStore) return null;
    const sdk = cs._imSdkStore;
    const { onMessage, onAssign, onStaff, onClose } = opts;
    const listenAt = Date.now();   // 开始监听时刻：早于它的 isFromMe 消息都是历史重推，不算人工活动
    // 平台系统提示/自动欢迎语不是人工打字（方括号系统提示 + 欢迎语/转接模板）
    const SYS_STAFF_RE = /^\[.+\]$|很高兴为您服务|已为您转接|服务已结束|已结束服务/;
    // 会话关闭信号：事件型 close_conversation 或「[xx关闭会话]」系统提示（isFromMe=true 也要捕获）
    const CLOSE_RE = /^\[.*关闭会话.*\]$|^会话已关闭$/;

    const onMsg = (msg) => {
      try {
        const isAllocated = shouldTakeOver(msg);
        const ext = msg.originExt || {};
        const item = {
          clientId: msg.clientId,
          type: msg.pigeonMsgType || msg.messageType,
          content: msg.content,
          isFromMe: msg.isFromMe,
          senderRole: msg.senderRole,
          conversationId: msg.bizConversationId,
          bizExt: msg.bizExt,
          originExt: snap(ext),
          allocated: isAllocated,
          timestamp: msg.createTime,
        };
        if (isAllocated) {
          emit('conversation-assigned', item);
          if (typeof onAssign === 'function') onAssign(item); // 直接回调 -> 立即标记接管
        }
        // 会话关闭（事件型或「[xx关闭会话]」系统提示，isFromMe=true 也走这里）→ 通知 agent 清理该会话状态
        if (item.type === 'close_conversation' || ext.type === 'close_conversation' || CLOSE_RE.test(String(msg.content || '').trim())) {
          emit('conversation-closed', item);
          if (typeof onClose === 'function') onClose(item);
          return;
        }
        if (!msg.isFromMe) {
          emit('message', item);
          if (typeof onMessage === 'function') onMessage(item);
        } else if (String(msg.content || '').trim() && !isSent(msg.content)) {
          // 人工客服本人在发消息（排除 AI 自己发的）→ 派发人工活动，agent 据此静音防抢答
          const ts = msg.createTime || 0;
          if (ts && ts < listenAt - 3000) return;                 // 历史重推（重载/重连后 SDK 重放）不算人工活动
          if (SYS_STAFF_RE.test(String(msg.content).trim())) return; // 系统提示/自动欢迎语不算人工打字
          emit('staff-activity', item);
          if (typeof onStaff === 'function') onStaff(item);
        }
      } catch (e) {
        console.error('[store-bridge] onMessage fail', e);
      }
    };

    const un1 = sdk.onMessage ? sdk.onMessage(onMsg) : null;
    const un2 = sdk.onMessageUpsert ? sdk.onMessageUpsert(onMsg) : null;
    const un3 = sdk.onConversationChange ? sdk.onConversationChange((c) => emit('conversation-change', { conversation: c && c.bizConversationId })) : null;
    const un4 = sdk.onConversationsChange ? sdk.onConversationsChange(() => emit('conversations-change')) : null;
    const un5 = sdk.onWsClosed ? sdk.onWsClosed(() => emit('ws-closed')) : null;

    return () => {
      un1 && un1();
      un2 && un2();
      un3 && un3();
      un4 && un4();
      un5 && un5();
    };
  }

  // ---- 8. 防回环：标记「这条消息是我发的」 ----
  const sentMemory = new Set();
  function rememberSent(content) {
    const key = String(content || '').slice(0, 200);
    sentMemory.add(key);
    setTimeout(() => sentMemory.delete(key), 1000 * 60 * 30);
  }
  function isSent(content) {
    const key = String(content || '').slice(0, 200);
    return sentMemory.has(key);
  }
  function clearSent() {
    sentMemory.clear();
  }

  // ---- 导出到 window ----
  const api = {
    getChatStore,
    listConversations,
    sendText,
    classifyMessage,
    shouldTakeOver,
    isConversationLive,
    startListening,
    on,
    off,
    emit,
    snap,
    rememberSent,
    isSent,
    clearSent,
  };
  window.__storeBridge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  console.log('[store-bridge] ready; store found =', !!getChatStore());
  return api;
})();
