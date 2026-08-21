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

  // ---- 5.1 消息角色分类：区分买家/真人客服/平台AI/AI自己/系统 ----
  // 买家：isFromMe=false（senderRole 1/3 多属买家）
  // 平台AI/平台系统：senderRole=4（智能客服机器人以店铺身份发言时 isFromMe=true；欢迎语等系统通知 isFromMe=false）
  // AI 自己：我们发的（bizExt.aiFlag=1 或内容在发送记录里）
  // 真人客服：isFromMe=true、role≠4、且非 AI 发送记录（senderRole=2）
  // 系统/事件：allocated_service / close / user_enter_time / 空内容
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
    // 平台侧发言（智能客服机器人/平台系统通知）：不是真人打字，绝不触发人工静音
    if (msg.senderRole === '4') {
      return 'platformAi';
    }
    if (msg.isFromMe === false) {
      return 'buyer';
    }
    if (msg.isFromMe === true) {
      const convId = msg.bizConversationId || msg.conversationId || msg.convId || '';
      return (isSent(msg.content, convId) || isSentClientId(msg.clientId)) ? 'aiSelf' : 'staff';
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
    // 只接管"当前接待中"的会话；history 列表里的会话不算 live，否则刷新/切换列表会把历史买家消息也接管回复
    if (conv.type === 'history') return false;
    const closed = !!(conv.rawConversation && conv.rawConversation.closed) || conv.closed === true;
    if (closed) return false;
    return true; // 仅 current/进行中会话视为可接管（history 已在上面排除）
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
        } else if (String(msg.content || '').trim()) {
          if (isSent(msg.content, msg.bizConversationId)) {
            learnSentClientId(msg.clientId);   // 内容指纹新鲜时学到 clientId，之后这条消息重推永久认得
          } else if (!isSentClientId(msg.clientId)) {
            // 人工客服本人在发消息（排除 AI 自己发的）→ 派发人工活动，agent 据此静音防抢答
            if (msg.senderRole === '4') return;                        // 平台智能客服/系统发言不是真人打字，不静音
            const ts = msg.createTime || 0;
            if (ts && ts < listenAt - 3000) return;                 // 历史重推（重载/重连后 SDK 重放）不算人工活动
            if (SYS_STAFF_RE.test(String(msg.content).trim())) return; // 系统提示/自动欢迎语不算人工打字
            emit('staff-activity', item);
            if (typeof onStaff === 'function') onStaff(item);
          }
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
  // 内容指纹不带过期时间（原来 30 分钟过期后，SDK 因已读回执/重连重推 AI 自己的回复，
  // isSent 失配被误判成人工发言 → 误静音会话），改用容量上限控制内存；
  // clientId 指纹：回推到达且内容匹配时学到，之后这条消息无论过多久重推都能认出是自己发的。
  const sentMemory = new Set();
  const sentClientIds = new Set();
  const capSet = (set, max) => { while (set.size > max) set.delete(set.values().next().value); };
  const sentKey = (content, conv) => String(conv || '') + '|' + String(content || '').slice(0, 200);
  // 兼容旧调用：rememberSent(content) / isSent(content) 按全局匹配；新代码用 (conv, content) / (content, conv) 按会话隔离
  function rememberSent(conv, content) {
    if (content === undefined) { content = conv; conv = ''; }
    sentMemory.add(sentKey(content, conv));
    capSet(sentMemory, 2000);
  }
  function isSent(content, conv) {
    const key = String(content || '').slice(0, 200);
    return sentMemory.has(sentKey(key, conv)) || sentMemory.has(sentKey(key, ''));
  }
  function forgetSent(conv, content) {
    if (content === undefined) { content = conv; conv = ''; }
    sentMemory.delete(sentKey(content, conv));
    if (conv) sentMemory.delete(sentKey(content, ''));
  }
  function learnSentClientId(id) {
    if (!id) return;
    sentClientIds.add(id);
    capSet(sentClientIds, 5000);
  }
  function isSentClientId(id) {
    return !!id && sentClientIds.has(id);
  }
  function clearSent() {
    sentMemory.clear();
    sentClientIds.clear();
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
    forgetSent,
    isSentClientId,
    clearSent,
  };
  window.__storeBridge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  console.log('[store-bridge] ready; store found =', !!getChatStore());
  return api;
})();
