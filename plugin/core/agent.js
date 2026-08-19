// agent.js — 大脑（MAIN world）：把「转人工 → 收到买家消息 → AI 决策 → 真人化延迟 → 发送」串起来
(() => {
  'use strict';

  const log = (...a) => console.log('[agent]', ...a);

  function deps() {
    const b = window.__storeBridge;
    const l = window.__llmEngine;
    if (!b) throw new Error('__storeBridge missing');
    if (!l) throw new Error('__llmEngine missing');
    return { b, l };
  }

  const state = {
    enabled: false,
    autoSend: false,
    provider: 'remote',       // remote=真实模型走 background；placeholder=本地兜底
    profile: undefined,
    kb: undefined,
    assigned: new Map(),      // conversationId -> { assigned:true }
    lastUserTextByConv: new Map(), // convId -> {text}
    minIntervalMs: 15000,     // 同一会话两次自动回复最小间隔（真人节奏）
    lastReplyAtByConv: new Map(),
    dailyCount: 0,
    dailyLimit: 200,
    quietFrom: 0,             // 免打扰起始小时
    quietTo: 0,
    quietEnabled: false,
    lastNudge: 0,             // 免打扰提醒去抖
    unsubscribe: null,
    historyCache: new Map(),  // convId -> messages[]
    // ---- 回合制门禁 ----
    // 语义：每次消费者发新消息，重置本会话"本轮"剩余可回条数；
    // 每回一条耗一格；在消费者下次发消息前，最多连回 maxRepliesPerReply 条。
    turnByConv: new Map(),    // conversationId -> { remaining }
    seenTurnMsg: new Map(),   // conversationId -> lastConsumerClientId（判断"是否新的一轮"）
    seenClientId: new Set(),  // 去重：相同 clientId 只处理一次
    bootAt: 0,                // agent 启动时间；早于它的消息都是历史重推，不回
    lastBuyerFp: new Map(),   // convId -> {fp, at} 内容指纹去重（SDK 换 clientId 重推的兜底）
    sendLock: new Map(),      // convId -> true 发送锁：同一会话同时只跑一个决策-发送流程
    pendingMsg: new Map(),    // convId -> item 锁期间到达的最新买家消息，锁释放后补处理
    // ---- 人工接管静音：你在会话里发消息，AI 就闭嘴 ----
    staffMuteByConv: new Map(), // convId -> mutedUntil（时间戳）。人工每发一条刷新计时
    staffMuteMinutes: 15,     // 人工接管后 AI 静音时长（分钟）
  };

  const DEFAULT_PER_TURN = 3; // 每个"消费者一条消息"回合，最多自动回复条数

  // ---- 会话归一化 key：买家 ID ----
  // 实测 convId 结构：买家ID:店铺ID:接待组ID（买家消息的 sender_id 与第一段一致；
  // 店铺ID:接待组ID 是全店共用的常量，绝不能拿来当 key——否则所有买家共用同一把锁/指纹/静音，
  // 跨买家互相排队、同内容互相误杀）。SDK 对同一买家的推送可能在尾段漂移，按第一段归一化即可兜住。
  // 只有发送和拉历史用原始 convId。
  function convKey(conv) {
    return String(conv || '').split(':')[0];
  }

  // ---- 回合制配额 ----
  // turn = { sentSinceTurnReset: 当前消费者消息这轮里 AI 已连发条数（兜底用） }
  function getTurn(conv) {
    let t = state.turnByConv.get(conv);
    if (!t) { t = { sentSinceTurnReset: 0 }; state.turnByConv.set(conv, t); }
    return t;
  }
  function consumeTurn(conv) {
    const t = getTurn(conv);
    t.sentSinceTurnReset += 1;
    return t.sentSinceTurnReset;
  }

  // ---- 配置写入（popup/host 会用）----
  function applyConfig(c) {
    if (c) {
      if (typeof c.autoSend === 'boolean') state.autoSend = c.autoSend;
      if (typeof c.enabled === 'boolean') state.enabled = c.enabled;
      if (c.provider) state.provider = (c.provider === 'placeholder') ? 'placeholder' : 'remote'; // 具体供应商由 background 按 storage.provider 选 apiBase
      if (c.profile) state.profile = typeof c.profile === 'string' ? { tone: c.profile } : c.profile;   // popup 存的是纯文本人设，包一层避免 Object.assign 把字符串打散成字符、人设静默丢失
      if (c.quietEnabled !== undefined) state.quietEnabled = !!c.quietEnabled;
      if (c.quietFrom !== undefined) state.quietFrom = Number(c.quietFrom) || 0;
      if (c.quietTo !== undefined) state.quietTo = Number(c.quietTo) || 0;
      if (c.dailyLimit !== undefined) state.dailyLimit = Number(c.dailyLimit) || 200;
      if (c.minIntervalMs !== undefined) state.minIntervalMs = Number(c.minIntervalMs) || 15000;
      if (c.maxRepliesPerConv !== undefined) state.maxRepliesPerConv = Number(c.maxRepliesPerConv) || DEFAULT_PER_TURN;
      if (c.staffMuteMinutes !== undefined) { const n = Number(c.staffMuteMinutes); state.staffMuteMinutes = Number.isFinite(n) ? n : 15; } // 允许 0 = 不静音
      if (c.kb) state.kb = c.kb;
    }
    return state;
  }

  function inQuietHours() {
    if (!state.quietEnabled) return false;
    const h = new Date().getHours();
    const from = state.quietFrom, to = state.quietTo;
    if (from === to) return false; // 无效区间
    if (from < to) return h >= from && h < to;
    return h >= from || h < to; // 跨天
  }

  // ---- 人工接管静音 ----
  // 语义：检测到你（人工客服）在某会话发了消息 → AI 对该会话静音 staffMuteMinutes 分钟；
  // 你每发一条刷新计时，你一直聊 AI 一直闭嘴；超时无人工活动后 AI 自动回来兜底。
  function muteConv(conv, minutes, reason) {
    conv = convKey(conv);   // 归一化：同一买家多个 convId 前缀共享同一份静音状态
    if (!conv) return;
    let mins = minutes;
    if (mins === undefined || mins === null) mins = state.staffMuteMinutes;
    if (mins === undefined || mins === null) mins = 15;
    if (!(mins > 0)) { state.staffMuteByConv.delete(conv); return; }   // 0 = 不静音
    const wasMuted = (state.staffMuteByConv.get(conv) || 0) > Date.now();
    state.staffMuteByConv.set(conv, mins === Infinity ? Infinity : Date.now() + mins * 60000);
    if (!wasMuted) {
      const { b } = deps();
      const label = mins === Infinity ? '直到你来处理' : `${mins} 分钟`;
      b.emit('notice', { level: 'ok', text: `${reason || '检测到人工接待'}，本会话 AI 静音 ${label}` });
    }
    log('conv muted', mins, 'min:', conv, reason || '');
  }
  function isMuted(conv) {
    const until = state.staffMuteByConv.get(convKey(conv)) || 0;
    if (Date.now() >= until) { if (until) state.staffMuteByConv.delete(convKey(conv)); return false; }
    return true;
  }
  // 人工客服发消息（store-bridge onStaff 回调）→ 刷新该会话静音
  function noteStaff(item) {
    if (!item || !item.conversationId) return;
    const { b } = deps();
    if (item.content && b.isSent(item.content)) return;    // 自己刚发的（SDK 回推），不是人工活动
    // 历史重推不算人工活动：重载/重连后 SDK 会重放旧消息，此时发送记录已清空，不能误判成人工接管
    if (item.timestamp && state.bootAt && item.timestamp < state.bootAt - 3000) return;
    muteConv(item.conversationId, state.staffMuteMinutes, '检测到你正在人工接待');
  }

  async function historyOf(conversationId) {
    const { b } = deps();
    const cs = b.getChatStore();
    if (!cs || !cs._imSdkStore) return [];
    try {
      const bizType = (cs._config && cs._config.pigeonBizType) || '7';
      const msgs = await cs._imSdkStore.getMessagesByConversation(bizType, conversationId);
      const arr = msgs || [];
      state.historyCache.set(conversationId, arr);
      return arr;
    } catch (e) {
      log('historyOf fail', e);
      return [];
    }
  }

  async function handleMessage(item) {
    const { b, l } = deps();
    if (!state.enabled) return;
    if (!item) return;
    if (item.isFromMe) return;               // 只响应买家

    // 转人工事件型消息：直接标记接管，即使时序上先于普通消息到达
    if (item.type === 'allocated_service' || item.allocated === true) {
      markAssigned(item);
      return;
    }
    // 历史重推防护：页面刷新/重连后 SDK 会把近期旧消息再推一遍，早于启动时间的一律不回
    if (item.timestamp && state.bootAt && item.timestamp < state.bootAt - 3000) {
      log('ignore history replay:', item.conversationId, String(item.content || '').slice(0, 30));
      return;
    }
    // ---- 只回真人买家：type 必须是 text 或买家卡片；role=4(平台机器人/欢迎语)/2(客服)一律不回 ----
    // 实测：平台欢迎语/系统卡片 type=card&role=4，买家商品卡咨询 type=card&role=1，真人文字 type=text&role=1/3
    const msgType = item.type || 'text';
    const isBuyerText = msgType === 'text';
    const isBuyerCard = msgType === 'card' && (item.senderRole === '1' || item.senderRole === '3');
    if (!isBuyerText && !isBuyerCard) {
      log('skip non-buyer-text:', msgType, 'role=', item.senderRole, String(item.content || '').slice(0, 20));
      return;
    }
    if (item.senderRole && item.senderRole !== '1' && item.senderRole !== '3') {
      log('skip non-buyer role:', item.senderRole, String(item.content || '').slice(0, 20));
      return;
    }
    if (b.isSent(item.content)) return;      // 防回环
    const conv = item.conversationId;
    if (!conv) return;
    const ckey = convKey(conv);   // 门禁/状态统一按买家维度，避免 SDK 多 convId 前缀绕过防重

    const ctx = state.assigned.get(ckey);
    // 动态接管：即使没有 allocated_service 事件，只要该会话是"当前人工接待(未关闭)"，也接管买家新消息
    if (!ctx || !ctx.assigned) {
      if (b.isConversationLive(conv)) {
        state.assigned.set(ckey, { assigned: true });
        log('auto-adopt live (current) conversation:', conv);
      } else {
        log('skip, conversation not assigned/live:', conv);
        return;
      }
    }

    // 关闭会话判据：消息 type=close_conversation → 停止接管该会话（完整清理由 markClosed 统一处理）
    if (item.type === 'close_conversation' || (item.originExt && item.originExt.type === 'close_conversation')) {
      markClosed(item);
      return;
    }

    const text = String(item.content || '').trim();
    if (!text) {
      log('skip non-text message:', conv, item.type);
      return;
    }

    // ---- 人工静音门禁：你正在/刚接待过这个会话，AI 不抢答（跳过且不占任何记账）----
    if (isMuted(conv)) {
      log('staff-muted, skip auto reply:', conv, text.slice(0, 30));
      return;
    }

    // ---- 发送锁（最优先）：同一买家同一时刻只跑一个处理流程 ----
    // 锁期间到达的消息进队列（不记账）；锁释放后逐条取出重进完整流程。
    // 这样重推/连发/系统通知无论怎么叠加，出口永远串行、每条真人消息恰好处理一次。
    if (state.sendLock.get(ckey)) {
      const q = state.pendingMsg.get(ckey) || [];
      q.push(item);
      state.pendingMsg.set(ckey, q);
      log('send locked, queued:', conv, text.slice(0, 20));
      return;
    }
    state.sendLock.set(ckey, true);
    try {
      // ---- 门禁0：clientId 去重（onMessage + onMessageUpsert 会双推同一条）----
      if (item.clientId) {
        if (state.seenClientId.has(item.clientId)) {
          log('dup clientId ignored:', item.clientId, '->', text.slice(0, 30));
          return;
        }
        state.seenClientId.add(item.clientId);
      }

      // ---- 门禁0.5：内容指纹去重（SDK 换 clientId 重推同一内容时兜底，60s 窗）----
      const fp = ckey + '|' + text;
      const lastFp = state.lastBuyerFp.get(ckey);
      if (lastFp && lastFp.fp === fp && Date.now() - lastFp.at < 60000) {
        log('dup content ignored:', conv, text.slice(0, 30));
        return;
      }
      state.lastBuyerFp.set(ckey, { fp, at: Date.now() });

      // ---- 门禁1：回合制——每条消费者新消息开启新一轮，轮内最多回 maxRepliesPerConv 条 ----
      const turn = getTurn(ckey);
      if (item.clientId && state.seenTurnMsg.get(ckey) === item.clientId) {
        log('turn spent for this consumer msg (already replied), ignore echo:', conv);
        return;
      }
      state.seenTurnMsg.set(ckey, item.clientId);   // 记下这条消费者消息
      turn.sentSinceTurnReset = 0;                  // 新消费者消息 → 开启新一轮回复额度
      if (turn.sentSinceTurnReset >= (state.maxRepliesPerConv ?? DEFAULT_PER_TURN)) {
        log('safety cap reached, force stop for this consumer msg:', conv);
        return;
      }

      // ---- 门禁2：真人节奏（新买家消息的回复不丢，只延后）----
      const lastReplyAt = state.lastReplyAtByConv.get(ckey) || 0;
      const since = Date.now() - lastReplyAt;
      if (since < state.minIntervalMs && lastReplyAt > 0) {
        const wait = state.minIntervalMs - since;
        log('throttle, delay reply', wait, 'ms, conv:', conv);
        await new Promise((r) => setTimeout(r, wait));   // 间隔不够就等够再发，绝不丢回复
      }

      // 免打扰
      if (inQuietHours()) {
        const now = Date.now();
        if (now - state.lastNudge > 600000) { // 每 10 分钟一次
          state.lastNudge = now;
          const { b: bb } = deps();
          bb.emit('notice', { level: 'warn', text: `免打扰时段(${state.quietFrom}:00-${state.quietTo}:00)，已跳过自动回复（会话 ${conv}）` });
        }
        return;
      }

      // 每日上限
      if (state.dailyCount >= state.dailyLimit) {
        log('daily limit reached', state.dailyCount);
        return;
      }

      // 组装上下文（历史 + 最新买方消息）
      const history = await historyOf(conv);
      let decision;
      try {
        decision = await l.decide({
          providerName: state.provider,
          message: { conversationId: conv, content: text },
          history,
          profile: state.profile,
          kb: state.kb,
          classify: b.classifyMessage,   // 角色感知：买家/人工客服/AI自己/系统
        });
      } catch (e) {
        // 生成失败（限速/超时/网络）：记事件日志让店主可见，而不是静默丢这条消息
        log('decide fail:', e && e.message);
        const { b: bb } = deps();
        bb.emit('notice', { level: 'error', text: 'AI 生成回复失败，本条未回（买家说：' + text.slice(0, 20) + '）：' + (e && e.message) });
        return;
      }
      if (!decision || !decision.reply) return;

      // ---- 答不了 → 叫人：兜底话术命中 → 上报店主 + 本会话无限期静音等人工（你来之后从人工发消息那刻起算 15 分钟）----
      if (decision.needsHuman) {
        muteConv(conv, Infinity, 'AI 答不了，已通知你处理');
        const { b: bb0 } = deps();
        bb0.emit('needs-human', { conversationId: conv, buyerText: text, reply: decision.reply });
      }

      if (state.autoSend) {
        await new Promise((r) => setTimeout(r, decision.delay)); // 真人感延迟
        // 发送前会话存活检查：决策期间会话被关闭就不再补枪（买家已看不到）
        if (!b.isConversationLive(conv)) {
          log('conv closed before send, skip:', conv);
          return;
        }
        try {
          b.rememberSent(decision.reply);                     // 先登记再发送：SDK 同步回推这条消息时才不会被误判成人工发送
          b.sendText(conv, decision.reply);                     // 不打任何平台可见标记，回复就是普通人工消息
          state.lastReplyAtByConv.set(ckey, Date.now());
          state.dailyCount += 1;
          const remain = consumeTurn(ckey);                 // 用掉一条本轮配额
          log('[sent]', 'conv=', conv, 'reply=', decision.reply, 'replies_this_consumer_msg=', remain);
          const { b: bb } = deps();
          bb.emit('sent', { conversationId: conv, reply: decision.reply, repliesThisConsumerMsg: remain, maxPerConsumerMsg: state.maxRepliesPerConv ?? DEFAULT_PER_TURN });
        } catch (e) {
          log('send fail', e);
          const { b: bb } = deps();
          bb.emit('notice', { level: 'error', text: '发送失败: ' + e.message });
        }
      } else {
        log('[preview]', 'conv=', conv, 'reply=', decision.reply);
        const { b: bb } = deps();
        bb.emit('preview', { conversationId: conv, reply: decision.reply });
      }
    } finally {
      state.sendLock.delete(ckey);
      const q = state.pendingMsg.get(ckey);
      if (q && q.length) {
        const next = q.shift();
        if (q.length) state.pendingMsg.set(ckey, q); else state.pendingMsg.delete(ckey);
        handleMessage(next).catch((e) => log('queued handle err', e));
      }
    }
  }

  // ---- 转人工事件 → 标记接管 ----
  function markAssigned(item) {
    if (!item || !item.conversationId) return;
    const ckey = convKey(item.conversationId);
    state.assigned.set(ckey, { assigned: true });
    state.staffMuteByConv.delete(ckey);   // 新的一局：上一局残留的静音不遗传
    log('conversation assigned -> take over:', item.conversationId);
    const { b } = deps();
    b.emit('assigned', { conversationId: item.conversationId });
  }

  // ---- 会话关闭 → 清理该会话全部状态（含人工静音：关闭后重开不受上一局静音影响）----
  function markClosed(item) {
    const ckey = item && item.conversationId && convKey(item.conversationId);
    if (!ckey) return;
    state.assigned.delete(ckey);
    state.staffMuteByConv.delete(ckey);
    state.lastReplyAtByConv.delete(ckey);
    state.turnByConv.delete(ckey);
    state.seenTurnMsg.delete(ckey);
    log('conversation closed, reset conv state:', item.conversationId);
  }

  // ---- 开关 ----
  function enable(opts = {}) {
    const { b } = deps();
    if (state.unsubscribe) return state;
    applyConfig(opts);
    state.enabled = true;
    state.bootAt = Date.now();   // 只响应启动之后的新消息，历史重推不回
    state.unsubscribe = b.startListening({
      onMessage: (item) => { handleMessage(item).catch((e) => log('handleMessage err', e)); },
      onAssign: markAssigned,
      onStaff: noteStaff,   // 人工发消息 → 该会话静音防抢答
      onClose: markClosed,  // 会话关闭 → 清理状态（含静音），重开后是新的一局
    });
    log('enabled; autoSend=', state.autoSend, 'provider=', state.provider);
    return state;
  }

  function disable() {
    if (state.unsubscribe) { try { state.unsubscribe(); } catch (e) {} state.unsubscribe = null; }
    state.enabled = false;
    log('disabled');
  }

  function resetDaily() { state.dailyCount = 0; }

  const api = {
    enable, disable, handleMessage, markAssigned, markClosed, historyOf,
    applyConfig, getState: () => state, resetDaily,
    getTurn, consumeTurn, noteStaff, muteConv, isMuted,
    unmuteConv: (conv) => { state.staffMuteByConv.delete(convKey(conv)); log('conv unmuted:', conv); },
    resetConvTurn: (conv) => { state.turnByConv.delete(conv); state.seenTurnMsg.delete(conv); },
    resetAllTurns: () => { state.turnByConv.clear(); state.seenTurnMsg.clear(); },
  };
  window.__agent = api;
  log('ready');
  return api;
})();
