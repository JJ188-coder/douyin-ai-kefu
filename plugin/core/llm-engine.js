// llm-engine.js — AI 回复引擎（MAIN world）
// 统一抽象 + 真实供应商走「postMessage → background」桥（避免 CORS / key 暴露）。
// 仍然保留本地占位供应商，便于无 key 时联调。
(() => {
  'use strict';

  const log = (...a) => console.log('[llm-engine]', ...a);

  const providers = new Map();
  const registerProvider = (name, client) => providers.set(name, client);
  const getProvider = (name) => providers.get(name);

  // ---- 占位（无 key 兜底）----
  registerProvider('placeholder', {
    chat: async (messages) => {
      // 占位供应商：未配置真实模型时兜底。输出一句干净、自然的客服话术，
      // 绝不把买家消息内容回显在回复里。
      const last = (messages || []).filter((m) => m.role === 'user').pop() || {};
      const content = String(last.content || '').trim();
      if (!content) return '您好，我在的，请问有什么可以帮您？';
      if (/在吗|在不在|有人吗|你好|hi|hello/i.test(content)) return '在的～请问有什么可以帮您？';
      return '您好，我在的，稍等马上为您确认～';
    },
  });

  // ---- 真实供应商：走 background 的 OpenAI 兼容 chat ----
  // 消息从 MAIN world postMessage 给 ISOLATED host-bridge，再由其转 chrome.runtime → background。
  registerProvider('remote', {
    chat: async (messages) => {
      return await new Promise((resolve, reject) => {
        // 请求编号：并发会话各自只认自己的回复，否则先回来的回复会被所有等待者同时拿走（内容串台）
        const reqId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const onReply = (ev) => {
          if (ev && ev.data && ev.data.__aics === 'llm-reply' && ev.data.reqId === reqId) {
            window.removeEventListener('message', onReply);
            clearTimeout(t);
            const { ok, text, error } = ev.data;
            if (!ok) reject(new Error(error || 'LLM 调用失败'));
            else resolve(text);
          }
        };
        const t = setTimeout(() => {
          window.removeEventListener('message', onReply);
          reject(new Error('LLM 请求超时'));
        }, 45000);   // 正常回复 5-20s；45s 不响应判定挂死，交给上层重试，别让买家干等
        window.addEventListener('message', onReply);
        window.postMessage(
          { __aics: 'llm-req', reqId, payload: { messages } },
          window.location.origin
        );
      });
    },
  });

  // ---- 推理规则：灵活但不乱来 ----
  // 知识库没有直接答案时，允许基于条目之间的关联 + 基本商业逻辑做有依据的推断，
  // 但禁止无中生有编造具体数字/政策/价格/时间；实在推不出就诚实说"帮您确认"。
  const REASONING_RULE =
    '推理规则：回答前先查知识库。1) 有直接答案就照答；' +
    '2) 没有直接答案，但能从知识库多条信息之间的关联以及基本商业逻辑推出合理结论时，可自然作答——' +
    '例如知识库写明某套餐包含某项目，顾客问该项目是否额外收费，应推断"已包含在套餐价内、不另收费"；' +
    '3) 只做有依据的推断，绝不编造任何具体数字、价格、政策、时间、地址；' +
    '4) 确实推不出来的，诚实回应"这个我帮您确认一下哦～"，可引导致电。';

  // ---- 默认人设 ----
  const DEFAULT_PROFILE = {
    name: '',
    tone: '你是一位亲切、口语化的商家客服。回复要像真人在网购聊天，简短自然、带一点人情味；不要用“作为AI”“如果您有任何问题随时联系”这类 AI 腔；能用一两句说清就别啰嗦。',
    maxLength: 120,
    maxTokens: 300,
    minDelayMs: 1200,
    maxDelayMs: 4500,
    rules: [],
  };

  // ---- 历史 → 上下文（角色感知 + 压缩）----
  // 用 store-bridge.classifyMessage 区分 buyer/aiSelf/staff/system
  // - system/事件（allocated_service、close、user_enter_time）→ 不喂给模型（噪音）
  // - buyer 消息 → role 'user'；aiSelf / staff → role 'assistant'
  // - 铁律：不在文本前加任何【角色】前缀——模型会照抄进回复发出去
  function stripTag(text) {
    return String(text || '').replace(/^(\s*【[^】]{1,15}】)+/, '').trim();
  }
  // 输出清洗：去掉 markdown 符号（**加粗** → “引号”，孤立星号直接删），买家看到的是纯文本
  function cleanReply(text) {
    return String(text || '')
      .replace(/\*\*([^*]+)\*\*/g, '“$1”')   // **重点** → “重点”
      .replace(/\*([^*]+)\*/g, '$1')          // *斜体* → 斜体
      .replace(/\*\*/g, '')                   // 残余孤立 **
      .replace(/^#+\s*/gm, '')                // 标题井号
      .trim();
  }
  function buildContext(history, classify) {
    const out = [];
    const list = (history || []).slice(-30);
    for (const m of list) {
      const text = stripTag(m && m.content);   // 顺带洗掉历史里已被污染的消息
      if (!text) continue;
      const role = classify ? classify(m) : (m.isFromMe ? 'staff' : 'buyer');
      if (role === 'system') continue; // 丢弃事件型/系统消息
      out.push({ role: role === 'buyer' ? 'user' : 'assistant', content: text });
    }
    return out;
  }

  // ---- 真人感延迟 ----
  function humanDelay(profile) {
    const p = Object.assign({}, DEFAULT_PROFILE, profile || {});
    const lo = p.minDelayMs || 1200;
    const hi = p.maxDelayMs || 4500;
    return Math.round(lo + Math.random() * (hi - lo));
  }

  // ---- 兜底话术检测：命中 = AI 其实答不了，需要人工介入 ----
  // REASONING_RULE 规定推不出时回"帮您确认"，这里据此识别并把信号抛给上层（agent 静音+通知店主）。
  const NEEDS_HUMAN_RE = /帮您确认|帮您核实|为您确认|帮您问下|帮您问问/;
  function detectNeedsHuman(reply) {
    return NEEDS_HUMAN_RE.test(String(reply || ''));
  }

  // ---- 决策：system + history + 最新用户消息 ----
  async function decide({ providerName = 'remote', message, history, profile, kb, classify }) {
    const p = Object.assign({}, DEFAULT_PROFILE, profile || {});
    const client = getProvider(providerName);
    if (!client) throw new Error('unknown provider: ' + providerName);

    const sysParts = [p.tone];
    if (kb && kb.length) sysParts.push('以下是商家知识库/常见问题，回答时优先参考：\n' + kb.join('\n'));
    if (p.rules && p.rules.length) sysParts.push('附加话术规则：\n' + p.rules.join('\n'));
    sysParts.push(REASONING_RULE);   // 固定推理守则，始终生效

    const messages = [
      { role: 'system', content: sysParts.join('\n\n') },
      ...buildContext(history || [], classify),
    ];
    // 确保最后一条是用户消息（拿不到的兜底）
    const lastUser = String((message && message.content) || '');
    if (messages.length === 0 || (messages[messages.length-1].role !== 'user')) {
      messages.push({ role: 'user', content: lastUser });
    }

    // 供应商限速/网络抖动时隔 2 秒重试一次；再失败才抛给上层记事件日志
    let reply;
    try {
      reply = await client.chat(messages, { maxTokens: p.maxTokens });
    } catch (e) {
      log('chat fail, retry once in 2s:', e && e.message);
      await new Promise((r) => setTimeout(r, 2000));
      reply = await client.chat(messages, { maxTokens: p.maxTokens });
    }
    const trimmed = cleanReply(stripTag(reply));   // 防模型照抄角色标签 + 去 markdown 符号
    if (!trimmed) return null;
    return { reply: trimmed, delay: humanDelay(p), conversationId: message && message.conversationId, needsHuman: detectNeedsHuman(trimmed) };
  }

  const api = { registerProvider, getProvider, decide, buildContext, humanDelay, detectNeedsHuman, DEFAULT_PROFILE };
  window.__llmEngine = api;
  log('ready; providers:', [...providers.keys()]);
  return api;
})();
