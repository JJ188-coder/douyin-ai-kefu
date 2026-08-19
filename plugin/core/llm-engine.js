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

  // ---- 简短硬规则：始终生效，不随人设覆盖 ----
  // 生产反馈：买家问一句它答三段、连发几句它逐句分答，显得啰嗦机械。
  const BREVITY_RULE =
    '回复长度硬规则：买家问什么就只答什么，能一句话说完绝不写两句；' +
    '不要主动补充买家没问的套餐细节、价格、注意事项；总字数控制在 60 字以内；' +
    '买家连发多句时（最新一条消息里有多行），拢在一起用一段话统一回应，不逐句分答。';

  // ---- 顺序规则：连发合并后的多行消息，行序即提问先后，先问先答 ----
  const ORDER_RULE =
    '回答顺序规则：买家最新消息如果有多行，每行是按提问先后排列的（上面是先问的）；' +
    '回应时按从上到下的顺序依次覆盖，先问的先答，不要颠倒。';

  // ---- 防重复规则：说过的不再复述，买家反馈过的事实要尊重 ----
  // 生产反馈：SDK 重推导致同一问题被答两遍、买家明说"电话打不通"还叫人打电话。
  const NO_REPEAT_RULE =
    '防重复规则：回答前先看上面聊天记录里已经说过什么。' +
    '1) 已经告知过的信息（电话、位置情况、价格、营业时间等）不要原样复述；' +
    '2) 买家明确反馈过的事实要尊重——比如买家说"电话打不通"，就不要再建议他打电话，改为表示帮忙确认或给替代方案。';

  // ---- 转人工集中回复规则：接管后第一条消息的合集格式 ----
  // 买家在平台机器人阶段积压的问题，接管时集中一段答完；之后恢复对话式逐条回复。
  const HANDOVER_RULE =
    '转人工接管规则：买家最新一条消息若以"（转人工前买家问过）"开头，那是买家在转人工之前问过、平台机器人没答好的问题合集——' +
    '先理解这些问题的整体意思，用一段话把它们集中答完（合并同类、不逐句分答、不遗漏）；' +
    '若后面还有"（转人工后买家新说）"部分，顺带回应它；回复里不要出现"转人工前""转人工后"这些标记字样。' +
    '这条之后买家再发的新消息没有合集标记，当普通对话正常回复即可。';

  // ---- 口吻铁律：你是商家客服，永远用商家口吻对买家说话 ----
  // 生产事故（2026-08-19）：买家发两个表情，模型回"看着就吸引人～想来玩随时找我哈！"——
  // 变成了游客口吻还把买家当朋友招揽，买家正在吐槽时这种回复等于找差评。
  const VOICE_RULE =
    '口吻铁律：你是这家营地的客服，永远用商家对顾客的口吻说话。' +
    '1) 禁止用游客/顾客/朋友口吻（如"看着就吸引人""想来玩""随时找我"这类把对方当朋友招揽或自己想来的说法）；' +
    '2) 买家只发表情、图片或没有实际内容的消息时，不要发挥想象，用一句简短礼貌的中性话术即可，如"嘿嘿，有问题随时喊我"。';

  // ---- 吐槽应对规则：买家抱怨时先诚恳道歉，绝不轻描淡写 ----
  // 注意：只承诺"反馈核实"（插件确实会推送给店主），绝不承诺具体线下动作——
  // "让人跟进"这种写法曾诱导模型说出"给您拿点药膏送过去"（2026-08-19 幻觉事故）。
  const COMPLAINT_RULE =
    '吐槽应对规则：买家在抱怨或表达不满（设施问题、蚊虫、卫生、服务、扬言投诉/差评等）时——' +
    '先真诚道歉并表示重视（"实在抱歉""您反馈的我都记下了"），安抚口径只说"马上反馈给店里核实处理"；' +
    '语气要诚恳收敛，绝不轻描淡写，禁止"难免的""哈哈""正常现象"这类敷衍说法。';

  // ---- 反编造铁律：最高优先级，违反即事故（2026-08-19 幻觉事故后设立）----
  // 事故：买家吐槽蚊子，模型回"我给您拿点药膏先涂上""药膏马上给您送到10号桌"——
  // 虚构线下服务承诺，买家真坐在桌边等一支不存在的药膏。以下三条任何 prompt 都不得违反：
  const ANTI_FAB_RULE =
    '反编造铁律（最高优先级，违反任何一条都是严重事故）：' +
    '1) 绝不承诺任何线下具体动作：禁止"给您送/拿/端/带/递""送到您桌上/位置上""我马上让人去处理/叫人过去"' +
    '“已经帮您订好/预约好/预留/留好/登记/备注好”；安抚只能说“我记下了，马上反馈给店里核实处理”；' +
    '2) 绝不主动承诺钱相关让步：退款、赔偿、免单、赠送、折扣一律不许说，买家要求时回"我帮您向店里申请确认一下"；' +
    '3) 知识库里明写的或买家自己说过的事实（价格、时间、电话、数字），直接自信照答，不要犹豫、不要过度谦逊——' +
    '这些不算编造；由知识库数字简单算出的合计/差价也可以答（如套餐价加单人票的总价）；' +
    '只有两边都没有、也算不出来的，才回"帮您确认一下"，绝不现编。';

  // ---- 情绪判断规则：先看买家脸色再开口 ----
  // 生产事故（2026-08-19）：买家明显带着气来（吐槽蚊子、设施），模型还在开玩笑式接话。
  const EMOTION_RULE =
    '情绪判断规则：回复前先判断买家此刻的情绪。' +
    '1) 只要买家的话里带任何不满、讽刺、抱怨、不耐烦的信号（哪怕混在玩笑或表情里），你的语气必须立刻收敛：不用语气词玩笑、不用"哈哈""哦～"这类轻佻尾巴，先安抚或正面回应问题；' +
    '2) 买家情绪正常、轻松闲聊时才可以用活泼一点的口吻；' +
    '3) 拿不准买家情绪时，一律按"买家不太高兴"处理，宁可稳重也不要俏皮。';

  // ---- 标点规则：禁止波浪线（店主明确要求，2026-08-19）----
  const NO_TILDE_RULE = '标点规则：回复里禁止使用波浪线（～、~），语气亲切靠措辞，不靠符号。';

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
  // 输出清洗：去掉 markdown 符号（**加粗** → “引号”，孤立星号直接删），买家看到的是纯文本；
  // 波浪线一律删除（～、〜、~）——模型不听话也发不出去
  function cleanReply(text) {
    return String(text || '')
      .replace(/\*\*([^*]+)\*\*/g, '“$1”')   // **重点** → “重点”
      .replace(/\*([^*]+)\*/g, '$1')          // *斜体* → 斜体
      .replace(/\*\*/g, '')                   // 残余孤立 **
      .replace(/^#+\s*/gm, '')                // 标题井号
      .replace(/[～〜~]/g, '')                // 波浪线全删（店主要求）
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

  // ---- 转办承诺检测：AI 回复里承诺了"要人办的事"（加VX/专员对接/回电/反馈核实）----
  // 2026-08-20 事故：AI 回"稍后让同事加您VX联系您哦"，回复发出去了但店主不知道要去加——承诺空转。
  // 命中语义：回复照发不误，同时推飞书+红角标提醒店主真的去办（不静音，AI 继续接待）。
  // 与 needsHuman 的区别：needsHuman = AI 答不了要人接；转办 = AI 答了但承诺了线下动作要人落实。
  const FOLLOWUP_RE = /加(您|你|下|您的|你的)?.{0,6}(VX|vx|微信)|专员.{0,8}(对接|联系)|(让|叫|安排).{0,6}(同事|专员|负责人|店里).{0,8}(加|联系|对接|回电)|给(您|你)回(电|电话)|回(电|电话)给(您|你)|稍后.{0,8}(联系|加)(您|你)|反馈给(店里|负责人)/;
  function detectFollowup(reply) {
    return FOLLOWUP_RE.test(String(reply || ''));
  }

  // ==================== 反幻觉门禁（发送前的程序闸）====================
  // 背景（2026-08-19 幻觉事故）：prompt 写得再狠，模型仍会"顺着买家说"——
  // 虚构"给您拿药膏送到10号桌"这种线下服务承诺。prompt 是软约束，这里是硬闸门：
  // 生成后、发送前，对回复做确定性校验，不合格直接替换为安全兜底 + needsHuman 通知店主。
  //
  // 两道检查：
  //   A. 行动承诺闸：线下具体动作（送/拿/端东西、让人去现场、已订好/预留好）与
  //      金钱让步（退款/赔偿/免单/赠送）一律拦截——这类承诺知识库不可能授权；
  //   B. 事实核对闸：回复里的电话号码、价格、时间、具体数字，必须能在
  //      「知识库 + 买家/真人客服说过的话」里找到出处，找不到即编造，拦截。
  //      证据刻意排除 AI 自己说过的（防止幻觉自我循环加强）。

  // 中文数字 → 阿拉伯数字：只在「数字+量词/单位」语境转换（八点→8点、两位→2位）。
  // 绝不能全局替换——"一下/一会儿/一起"里的"一"不是数字，全局转会把正常话术误杀（0.3.9 教训）。
  const CN_NUM_BEFORE_UNIT = /[零〇一二两三四五六七八九十]{1,3}(?=[点元块位个人名张间条份只支天号岁折米里分两钟小半])/g;
  function cn2num(s) {
    const map = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    return String(s || '').replace(CN_NUM_BEFORE_UNIT, (w) => {
      if (w === '十') return '10';
      const t = w.indexOf('十');
      if (t === 0) return '1' + (map[w[1]] != null ? map[w[1]] : '');        // 十X → 1X
      if (t > 0) {                                                            // X十 / X十Y
        const hi = map[w[0]] != null ? map[w[0]] : '';
        const lo = w.length > t + 1 && map[w[t + 1]] != null ? map[w[t + 1]] : '0';
        return String(hi) + String(lo);
      }
      return w.split('').map((c) => (map[c] != null ? map[c] : c)).join('');
    });
  }

  // 冒号时间必须「像时间」：左侧不能紧跟数字/¥（否则全角冒号"¥158：4人"会被啃成 58:4 —— 0.3.9 误杀事故），
  // 分钟固定两位（"9:30"是时间，"158：4"不是）。
  const COLON_TIME_RE = /(?<![\d¥$.])(\d{1,2})[:：](\d{2})(?!\d)/g;
  const DIAN_TIME_RE = /(凌晨|早上|上午|中午|下午|晚上|晚间|夜里|晚|傍晚)?(\d{1,2})点(半|\d{1,2}分)?/g;

  // 时间表达式归一化为 H:MM（"晚上8点"→"20:00"，"9点半"→"9:30"），供跨写法比对
  function extractTimes(text) {
    const s = cn2num(text);
    const out = new Set();
    for (const m of s.matchAll(new RegExp(COLON_TIME_RE.source, 'g'))) out.add(Number(m[1]) + ':' + m[2]);
    for (const m of s.matchAll(new RegExp(DIAN_TIME_RE.source, 'g'))) {
      let h = Number(m[2]);
      let mm = '00';
      if (m[3] === '半') mm = '30';
      else if (m[3]) mm = String(parseInt(m[3], 10)).padStart(2, '0');
      if (/(下午|晚上|晚间|夜里|晚|傍晚)/.test(m[1] || '') && h < 12) h += 12;
      out.add(h + ':' + mm);
    }
    return out;
  }

  // 抽取事实：电话 / 金额（带 元/块/¥ 或小数的数，核对最严） / 裸数字（数量类） / 时间
  function extractFacts(text) {
    const s = cn2num(text);
    const phones = new Set(s.match(/1\d{10}/g) || []);
    const times = extractTimes(s);
    const money = new Set();
    for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(?:元|块)/g)) money.add(m[1].replace(/\.0+$/, ''));
    for (const m of s.matchAll(/[¥￥]\s*(\d+(?:\.\d+)?)/g)) money.add(m[1].replace(/\.0+$/, ''));
    for (const m of s.matchAll(/\d+\.\d+/g)) money.add(m[0].replace(/\.0+$/, ''));   // 小数几乎都是价格
    // 裸数字核对前先把时间表达式和电话剥掉——它们已由各自专项核对负责，
    // 否则"晚上8点"里的 8、"9:30"里的 9/30 会被当成独立数字误伤
    const stripped = s
      .replace(/1\d{10}/g, ' ')
      .replace(new RegExp(COLON_TIME_RE.source, 'g'), ' ')
      .replace(new RegExp(DIAN_TIME_RE.source, 'g'), ' ');
    const nums = new Set((stripped.match(/\d+(?:\.\d+)?/g) || []).map((n) => n.replace(/\.0+$/, '')));
    return { phones, nums, money, times };
  }

  // 合计推导：目标数是否等于 ≤8 个证据金额的求和（可重复取用，即含倍数）——按分做背包 DP。
  // 如买家问"一共多少"：388 套餐 + 5×29.9 单人票 = 537.5，是知识库算出来的，不是编造。
  // 只放行 2000 元以内；超出的多半是大额团建，按存疑转人工反而合适。
  function isDerivedNumber(n, coinNums) {
    const target = Math.round(Number(n) * 100);
    if (!Number.isFinite(target) || target <= 0 || target > 200000) return false;
    const coins = [...coinNums].map((x) => Math.round(Number(x) * 100)).filter((c) => Number.isFinite(c) && c > 0 && c <= target);
    if (!coins.length) return false;
    const dp = new Uint8Array(target + 1).fill(255);
    dp[0] = 0;
    for (let i = 1; i <= target; i++) {
      let best = 255;
      for (const c of coins) if (i >= c && dp[i - c] < best) best = dp[i - c] + 1;
      dp[i] = best;
    }
    return dp[target] <= 8;
  }

  // 证据裸数字的「差值表」：数量类小数字常由对话推出（15 人 - 10 人套餐 = 补 5 张票）
  function buildDiffSet(evNums) {
    const arr = [...evNums].map(Number).filter((x) => Number.isFinite(x));
    const out = new Set();
    for (const a of arr) for (const b of arr) {
      const d = Math.abs(a - b);
      if (d > 0 && Number.isInteger(d)) out.add(String(d));
    }
    return out;
  }

  // 证据语料：知识库 + 最近买家/真人客服消息（排除 AI 自己，防止幻觉自我加强）
  function buildEvidence(history, kb, classify) {
    const parts = (kb || []).map(String);
    for (const m of (history || []).slice(-30)) {
      const role = classify ? classify(m) : (m.isFromMe ? 'staff' : 'buyer');
      if (role === 'buyer' || role === 'staff') parts.push(String(m && m.content || ''));
    }
    return parts.join('\n');
  }

  // A 闸：线下行动承诺 + 金钱让步（此类承诺知识库不可能授权，一律拦）
  const ACTION_FORBID = [
    { re: /(送|拿|端|带|递)(给|到|上|去)(您|你)/, why: '线下送物承诺' },
    { re: /(给|为)(您|你)(送|拿|端|带|递|准备)/, why: '线下送物承诺' },
    { re: /(送到|拿到|端到|带到|递到|送至|送去)/, why: '线下送物承诺' },
    { re: /(让|叫|安排)(人|师傅|小哥|同事|工作人员|阿姨|服务员).{0,4}去/, why: '派人去现场承诺' },
    { re: /(已经|已|这就|马上|立刻|现在).{0,6}(帮您|给您|给你|为你|为您)?(订好|订了|预约好|预约了|预留|留好|登记好|备注好|安排好了)/, why: '虚构已完成的线下动作' },
    { re: /退款|退钱|退您|退你|免单|赔偿|赔付|赔您|赔你/, why: '金钱让步承诺' },
    { re: /(免费|白送|赠送).{0,4}(送|赠)/, why: '免费赠送承诺' },
  ];

  // 反幻觉主闸：返回 { ok, reason }  reason 仅供日志/事件定位
  function antiHallucinationGate(reply, evidenceText) {
    const text = String(reply || '');
    if (!text) return { ok: true };
    for (const { re, why } of ACTION_FORBID) {
      if (re.test(text)) return { ok: false, reason: why };
    }
    const ev = String(evidenceText || '');
    const evFacts = extractFacts(ev);
    const rpFacts = extractFacts(text);
    for (const p of rpFacts.phones) if (!evFacts.phones.has(p)) return { ok: false, reason: '编造电话:' + p };
    for (const t of rpFacts.times) if (!evFacts.times.has(t)) return { ok: false, reason: '编造时间:' + t };
    // 金额（元/块/¥/小数）：必须知识库/对话里有，或能由证据金额求和推出（合计场景）
    for (const n of rpFacts.money) {
      if (!evFacts.money.has(n) && !isDerivedNumber(n, evFacts.money)) return { ok: false, reason: '编造金额:' + n };
    }
    // 裸数字（数量类）：出处可以是证据原文、证据两数之差（15人-10人套餐=补5张）、或求和推导
    const diffSet = buildDiffSet(evFacts.nums);
    for (const n of rpFacts.nums) {
      if (rpFacts.money.has(n)) continue;   // 已按金额严检过
      if (!evFacts.nums.has(n) && !diffSet.has(n) && !isDerivedNumber(n, evFacts.nums)) return { ok: false, reason: '编造数字:' + n };
    }
    return { ok: true };
  }

  // 拦截后的安全兜底：抱怨场景用安抚版（"反馈给店里"是事实——needsHuman 会真实推送店主），
  // 普通场景用核实版。两者都不含任何具体承诺/数字，且都命中 needsHuman 语义。
  const COMPLAINT_FALLBACK = '实在抱歉，您反馈的情况我都记下了，马上反馈给店里负责人核实处理。';
  const GENERIC_FALLBACK = '这个我得帮您跟店里确认一下，确认好了马上回复您。';
  const COMPLAINT_HINT = /投诉|差评|蚊子|虫|脏|乱|差|垃圾|气死|无语|失望|离谱|再也不|踩雷|难吃|太慢/;

  // ---- 决策：system + history + 最新用户消息 ----
  async function decide({ providerName = 'remote', message, history, profile, kb, classify }) {
    const p = Object.assign({}, DEFAULT_PROFILE, profile || {});
    const client = getProvider(providerName);
    if (!client) throw new Error('unknown provider: ' + providerName);

    const sysParts = [p.tone];
    if (kb && kb.length) sysParts.push('以下是商家知识库/常见问题，回答时优先参考：\n' + kb.join('\n'));
    if (p.rules && p.rules.length) sysParts.push('附加话术规则：\n' + p.rules.join('\n'));
    sysParts.push(REASONING_RULE);   // 固定推理守则，始终生效
    sysParts.push(BREVITY_RULE);     // 固定简短守则，始终生效
    sysParts.push(ORDER_RULE);       // 固定顺序守则，始终生效
    sysParts.push(NO_REPEAT_RULE);   // 固定防重复守则，始终生效
    sysParts.push(HANDOVER_RULE);    // 固定转人工集中回复守则，始终生效
    sysParts.push(VOICE_RULE);       // 固定口吻守则，始终生效
    sysParts.push(EMOTION_RULE);     // 固定情绪判断守则，始终生效
    sysParts.push(COMPLAINT_RULE);   // 固定吐槽应对守则，始终生效
    sysParts.push(NO_TILDE_RULE);    // 固定标点守则（禁波浪线），始终生效
    sysParts.push(ANTI_FAB_RULE);    // 固定反编造铁律，始终生效（最高优先级）

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
    // 反幻觉硬闸：发送前最后校验。被拦 = 回复里有知识库/对话支撑不了的承诺或事实，
    // 替换为安全兜底 + needsHuman（该会话静音等人工 + 店主收红角标/飞书提醒）
    const gate = antiHallucinationGate(trimmed, buildEvidence(history, kb, classify));
    if (!gate.ok) {
      log('ANTI-HALLUCINATION BLOCKED [' + gate.reason + '] orig:', trimmed);
      const lastBuyer = String((message && message.content) || '');
      const fallback = COMPLAINT_HINT.test(lastBuyer) ? COMPLAINT_FALLBACK : GENERIC_FALLBACK;
      return { reply: fallback, delay: humanDelay(p), conversationId: message && message.conversationId, needsHuman: true, blockedBy: 'anti-hallucination:' + gate.reason };
    }
    return { reply: trimmed, delay: humanDelay(p), conversationId: message && message.conversationId, needsHuman: detectNeedsHuman(trimmed) };
  }

  const api = { registerProvider, getProvider, decide, buildContext, humanDelay, detectNeedsHuman, detectFollowup, antiHallucinationGate, buildEvidence, DEFAULT_PROFILE };
  window.__llmEngine = api;
  log('ready; providers:', [...providers.keys()]);
  return api;
})();
