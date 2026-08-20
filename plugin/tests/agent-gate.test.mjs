// 门禁行为自测（node 直跑，不依赖浏览器）
// 覆盖：1) 历史重推不回  2) 每条新买家消息开启新回合  3) 同 clientId 双推拦截  4) 每回合最多 N 条
import { readFileSync } from 'fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../core/agent.js', import.meta.url), 'utf8');

const sent = [];
const sentMem = new Set();   // 真实化发送记录：验证"先登记再发送"的防误判
let onMsg;
let staffCb;
let closeCb;
const bridge = {
  getChatStore: () => ({ _imSdkStore: { getMessagesByConversation: async () => [] } }),
  sendText: (conv, content) => { sent.push({ conv, content }); },
  rememberSent: (conv, content) => { if (content === undefined) { content = conv; conv = ''; } sentMem.add(String(content || '').slice(0, 200)); },
  forgetSent: (conv, content) => { if (content === undefined) { content = conv; conv = ''; } sentMem.delete(String(content || '').slice(0, 200)); },
  isSent: (content, conv) => sentMem.has(String(content || '').slice(0, 200)),
  isConversationLive: () => true,
  classifyMessage: (m) => (m.isFromMe ? 'staff' : 'buyer'),
  startListening: () => () => {},
  emit: () => {}, on: () => {}, off: () => {},
};
const llm = { decide: async () => { await new Promise(r => setTimeout(r, 200)); return { reply: '在的～请问有什么可以帮您？', delay: 0 }; } };

globalThis.window = { __storeBridge: bridge, __llmEngine: llm };
eval(src);
const agent = globalThis.window.__agent;

agent.applyConfig({ autoSend: true, enabled: true, maxRepliesPerConv: 1, minIntervalMs: 1 });
agent.enable();

// 用内部监听入口：直接调 handleMessage 不可达（闭包内），改为通过 startListening 回调注入
bridge.startListening = (opts) => { onMsg = opts.onMessage; staffCb = opts.onStaff; closeCb = opts.onClose; return () => {}; };
agent.disable ? agent.disable() : null;
agent.enable();

const NOW = Date.now();
const buyerMsg = (clientId, content, ts) => onMsg({
  clientId, content, isFromMe: false, senderRole: '1',
  conversationId: 'CONV1', pigeonMsgType: 'text', timestamp: ts ?? NOW,
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 1) 历史重推：启动前 10 分钟的旧消息 → 不回
buyerMsg('HIST-1', '周末有位置吗', NOW - 600000);
await sleep(450);
assert.ok(sent.length === 0, '❌ 历史消息不应回复');
console.log('✅ 1. 历史重推不回, sent =', sent.length);

// 2) 新消息 A → 回 1 条
buyerMsg('A-1', '在吗');
await sleep(450);
assert.ok(sent.length === 1, '❌ 新消息应回 1 条');
console.log('✅ 2. 新买家消息回 1 条, sent =', sent.length);

// 3) 同一条双推（同 clientId）→ 不追发
buyerMsg('A-1', '在吗');
await sleep(450);
assert.ok(sent.length === 1, '❌ 同 clientId 双推不应追发');
console.log('✅ 3. 双推拦截, sent =', sent.length);

// 4) 买家再发新消息 B → 新回合，又回 1 条
buyerMsg('B-1', '明天营业吗');
await sleep(450);
assert.ok(sent.length === 2, '❌ 新买家消息应开启新回合再回 1 条');
console.log('✅ 4. 新消息重置回合, sent =', sent.length);

// 5) 买家连发 3 条：第 1 条即时回；后 2 条在处理间隙到达 → 合并成一条再回，共 +2（v0.3.6 起连发合并，不再一句一答）
buyerMsg('C-1', '问1'); buyerMsg('C-2', '问2'); buyerMsg('C-3', '问3');
await sleep(700);
assert.ok(sent.length === 4, '❌ 连发 3 条应回 2 条（1 即时 + 1 合并）, 实发 ' + sent.length);
console.log('✅ 5. 买家连发合并回复, sent =', sent.length);


// 6) 平台机器人欢迎语卡片（type=card, role=4）→ 不回
onMsg({ clientId: 'CARD-4', content: '您好，请问有什么可以帮到您？', isFromMe: false, senderRole: '4', conversationId: 'CONV1', pigeonMsgType: 'card', timestamp: NOW });
await sleep(450);
assert.ok(sent.length === 4, '❌ role=4 卡片不应回复, 实发 ' + sent.length);
console.log('✅ 6. 平台卡片(role=4)拦截, sent =', sent.length);

// 7) 真人商品卡咨询（type=card, role=1）→ 回
onMsg({ clientId: 'CARD-1', content: '这个套餐周末能用吗', isFromMe: false, senderRole: '1', conversationId: 'CONV1', pigeonMsgType: 'card', timestamp: NOW });
await sleep(450);
assert.ok(sent.length === 5, '❌ 真人卡片(role=1)应回复, 实发 ' + sent.length);
console.log('✅ 7. 真人卡片(role=1)正常回复, sent =', sent.length);

// 8) 同内容换 clientId 重推（60s 内）→ 不回（指纹去重）
onMsg({ clientId: 'NEW-ID-1', content: '这个套餐周末能用吗', isFromMe: false, senderRole: '1', conversationId: 'CONV1', pigeonMsgType: 'text', timestamp: NOW });
await sleep(450);
assert.ok(sent.length === 5, '❌ 换id重推同内容不应再回, 实发 ' + sent.length);
console.log('✅ 8. 内容指纹去重, sent =', sent.length);

// 9) 发送锁：处理中连到两条不同内容 → 第一条回 + pending 补一条，共 2 条（不多不少）
onMsg({ clientId: 'L-1', content: '锁测试一', isFromMe: false, senderRole: '1', conversationId: 'CONV1', pigeonMsgType: 'text', timestamp: NOW });
onMsg({ clientId: 'L-2', content: '锁测试二', isFromMe: false, senderRole: '1', conversationId: 'CONV1', pigeonMsgType: 'text', timestamp: NOW });
await sleep(1500);
assert.ok(sent.length === 7, '❌ 锁+pending 应共回 2 条, 实发 ' + (sent.length - 5));
console.log('✅ 9. 发送锁+pending 补处理, sent =', sent.length);

// 10) 人工接管静音：店主在某会话发一条消息 → 该会话买家新消息 AI 不回（不抢答）
const before = sent.length;
staffCb({ conversationId: 'CONV2', content: '您好，我是人工客服，请问有什么问题', isFromMe: true, senderRole: '2', pigeonMsgType: 'text', timestamp: NOW });
onMsg({ clientId: 'M-1', content: '我想问下价格', isFromMe: false, senderRole: '1', conversationId: 'CONV2', pigeonMsgType: 'text', timestamp: NOW });
await sleep(450);
assert.ok(sent.length === before, '❌ 人工静音期内不应自动回复, 实发 ' + (sent.length - before));
console.log('✅ 10. 人工接管后 AI 静音不抢答, sent =', sent.length);

// 11) 静音关闭自动恢复：staffMuteMinutes=0（不静音）时，人工发消息后买家消息仍应回复
agent.applyConfig({ staffMuteMinutes: 0 });   // 0 = 不静音
staffCb({ conversationId: 'CONV3', content: '人工在', isFromMe: true, senderRole: '2', pigeonMsgType: 'text', timestamp: NOW });
onMsg({ clientId: 'R-1', content: '到期恢复测试', isFromMe: false, senderRole: '1', conversationId: 'CONV3', pigeonMsgType: 'text', timestamp: NOW });
await sleep(450);
assert.ok(sent.length === before + 1, '❌ 静音关闭后应恢复回复, 实发 ' + (sent.length - before));
console.log('✅ 11. 静音关闭后 AI 恢复接管, sent =', sent.length);

// 12) needsHuman：AI 回复含「帮您确认」→ 会话自动静音 + 触发 needs-human 上报
let needsHumanFired = null;
bridge.emit = (evt, d) => { if (evt === 'needs-human') needsHumanFired = d; };
const llm2 = { decide: async () => ({ reply: '这个我帮您确认一下哦～', delay: 0, needsHuman: true }) };
globalThis.window.__llmEngine = llm2;
agent.applyConfig({ staffMuteMinutes: 15, minIntervalMs: 1, maxRepliesPerConv: 1 });
onMsg({ clientId: 'NH-1', content: '有没有什么特殊优惠', isFromMe: false, senderRole: '1', conversationId: 'CONV4', pigeonMsgType: 'text', timestamp: NOW });
await sleep(450);
assert.ok(needsHumanFired && needsHumanFired.conversationId === 'CONV4', '❌ needs-human 未触发');
assert.ok(agent.isMuted('CONV4'), '❌ 答不了后会话应自动静音');
assert.ok(agent.getState().staffMuteByConv.get('CONV4') === Infinity, '❌ needsHuman 静音应为无限期等人工（不自动到期）');
console.log('✅ 12. needsHuman 上报 + 会话无限期静音等人工', 'needsHuman=', !!needsHumanFired, 'mutedUntil=', agent.getState().staffMuteByConv.get('CONV4'));

// 12.5) 无限期静音期间人工发消息 → 从这一刻起改算 15 分钟有限期
staffCb({ conversationId: 'CONV4', content: '我来了，这个问题我处理', isFromMe: true, senderRole: '2', pigeonMsgType: 'text', timestamp: Date.now() });
const until4 = agent.getState().staffMuteByConv.get('CONV4');
assert.ok(until4 !== Infinity && until4 > Date.now() + 14 * 60000 && until4 <= Date.now() + 15 * 60000, '❌ 人工发消息后应改为 15 分钟有限期, 实际 ' + until4);
console.log('✅ 12.5 人工发消息那一刻起算 15 分钟, remainSec=', Math.round((until4 - Date.now()) / 1000));

// 13) unmute 解除静音 → 换回正常 llm，买家消息恢复回复
agent.unmuteConv('CONV4');
globalThis.window.__llmEngine = { decide: async () => ({ reply: '有的，具体看套餐哦～', delay: 0, needsHuman: false }) };
onMsg({ clientId: 'NH-2', content: '那换个问题', isFromMe: false, senderRole: '1', conversationId: 'CONV4', pigeonMsgType: 'text', timestamp: NOW });
await sleep(450);
assert.ok(!agent.isMuted('CONV4'), '❌ unmute 后不应再静音');
assert.ok(sent[sent.length - 1] && sent[sent.length - 1].conv === 'CONV4', '❌ unmute 后应恢复回复');
console.log('✅ 13. unmute 解除静音后 AI 恢复', 'muted=', agent.isMuted('CONV4'));

// 14) AI 发送瞬间 SDK 同步回推自己这条消息（乐观更新）→ 因先登记发送记录，不得误判人工而静音
const realSend = bridge.sendText;
bridge.sendText = (conv, content) => {
  sent.push({ conv, content });
  // 模拟飞鸽 SDK：sendText 内部同步触发本地消息 upsert，同一内容 isFromMe=true 回推
  staffCb({ conversationId: conv, content, isFromMe: true, senderRole: '2', pigeonMsgType: 'text', timestamp: Date.now() });
};
onMsg({ clientId: 'SYNC-1', content: '同步回推测试问题', isFromMe: false, senderRole: '1', conversationId: 'CONV5', pigeonMsgType: 'text', timestamp: Date.now() });
await sleep(450);
bridge.sendText = realSend;
assert.ok(!agent.isMuted('CONV5'), '❌ AI 自回同步回推不应触发人工静音');
assert.ok(sent[sent.length - 1] && sent[sent.length - 1].conv === 'CONV5', '❌ 同步回推场景下回复应正常发出');
console.log('✅ 14. AI 自回同步回推不误判人工, muted=', agent.isMuted('CONV5'), 'sent=', sent.length);

// 15) 历史重推的人工消息（timestamp 早于启动时间）→ noteStaff 直接忽略，不静音
staffCb({ conversationId: 'CONV6', content: '重连前人工发的旧消息', isFromMe: true, senderRole: '2', pigeonMsgType: 'text', timestamp: NOW - 600000 });
assert.ok(!agent.isMuted('CONV6'), '❌ 历史重推的人工消息不应触发静音');
console.log('✅ 15. 历史重推不误判人工接管, muted=', agent.isMuted('CONV6'));

// 16) 人工静音后会话关闭 → 重开是新的一局：静音不遗传，买家新消息正常回复
staffCb({ conversationId: 'CONV7', content: '人工处理一下', isFromMe: true, senderRole: '2', pigeonMsgType: 'text', timestamp: Date.now() });
assert.ok(agent.isMuted('CONV7'), '❌ 前置：人工发消息应静音 CONV7');
closeCb({ conversationId: 'CONV7', content: '[客服关闭会话]', isFromMe: true, senderRole: '2', pigeonMsgType: 'text', timestamp: Date.now() });
assert.ok(!agent.isMuted('CONV7'), '❌ 会话关闭后静音应清除');
onMsg({ clientId: 'REOPEN-1', content: '重开后买家提问', isFromMe: false, senderRole: '1', conversationId: 'CONV7', pigeonMsgType: 'text', timestamp: Date.now() });
await sleep(450);
assert.ok(sent[sent.length - 1] && sent[sent.length - 1].conv === 'CONV7', '❌ 关闭重开后买家消息应正常回复');
console.log('✅ 16. 关闭重开静音不遗传, sent=', sent.length);

// 17) 人工静音后重新分配（allocated）→ 静音解除
staffCb({ conversationId: 'CONV8', content: '人工接待中', isFromMe: true, senderRole: '2', pigeonMsgType: 'text', timestamp: Date.now() });
assert.ok(agent.isMuted('CONV8'), '❌ 前置：人工发消息应静音 CONV8');
agent.markAssigned({ conversationId: 'CONV8' });
assert.ok(!agent.isMuted('CONV8'), '❌ 重新分配后静音应解除');
console.log('✅ 17. 重新分配解除残留静音, muted=', agent.isMuted('CONV8'));

// 18) 同买家 convId 尾段漂移（实测 convId=买家ID:店铺ID:接待组ID，买家唯一标识是第一段）→ 按买家归一化后指纹拦截，只回一次
const before18 = sent.length;
onMsg({ clientId: 'FORK-1', content: '这个多少钱', isFromMe: false, senderRole: '1', conversationId: 'buyer9:shop1:g1', pigeonMsgType: 'text', timestamp: Date.now() });
await sleep(450);
onMsg({ clientId: 'FORK-2', content: '这个多少钱', isFromMe: false, senderRole: '1', conversationId: 'buyer9:shop1:g2', pigeonMsgType: 'text', timestamp: Date.now() });
await sleep(450);
assert.ok(sent.length === before18 + 1, '❌ 同买家同内容跨 convId 应只回一次, 实发 ' + (sent.length - before18));
console.log('✅ 18. convId 尾段分叉防重（只回一次）, sent =', sent.length);

// 19) popup 存的纯文本人设 → applyConfig 包装成 {tone}，不静默丢失（回归：字符串直接进 state 会被 Object.assign 打散成字符）
agent.applyConfig({ profile: '你是真人客服，绝不提AI' });
const profNow = agent.getState().profile;
assert.ok(profNow && profNow.tone === '你是真人客服，绝不提AI', '❌ 纯文本人设应包装为 {tone}, 实际 ' + JSON.stringify(profNow).slice(0, 60));
console.log('✅ 19. 纯文本人设正确包装为 {tone}');

// 20) 跨买家隔离：两个不同买家 60s 内发同样内容 → 指纹/锁按买家 ID 隔离，各回各的（不互相误杀、不互相排队）
const before20 = sent.length;
onMsg({ clientId: 'XB-1', content: '在吗', isFromMe: false, senderRole: '1', conversationId: 'buyerA:shop1:g1', pigeonMsgType: 'text', timestamp: Date.now() });
onMsg({ clientId: 'XB-2', content: '在吗', isFromMe: false, senderRole: '1', conversationId: 'buyerB:shop1:g1', pigeonMsgType: 'text', timestamp: Date.now() });
await sleep(900);
assert.ok(sent.length === before20 + 2, '❌ 不同买家同内容应各自回复, 实发 ' + (sent.length - before20));
console.log('✅ 20. 跨买家同内容不互杀（各回各的）, sent =', sent.length);

// 21) convId 四段格式分叉（实测存在 0:1:接待组:买家 与 买家:店铺:接待组 两种格式，同一买家）→ 归一化后只回一次
const before21 = sent.length;
onMsg({ clientId: 'F4-1', content: '可以带宠物吗', isFromMe: false, senderRole: '1', conversationId: 'buyer7:shop1:g1', pigeonMsgType: 'text', timestamp: Date.now() });
await sleep(450);
onMsg({ clientId: 'F4-2', content: '可以带宠物吗', isFromMe: false, senderRole: '1', conversationId: '0:1:g1:buyer7', pigeonMsgType: 'text', timestamp: Date.now() });
await sleep(450);
assert.ok(sent.length === before21 + 1, '❌ 四段格式分叉应只回一次, 实发 ' + (sent.length - before21));
console.log('✅ 21. 四段格式 convId 分叉防重（只回一次）, sent =', sent.length);

// 22) 发送前静音闸（2026-08-19 抢话事故回归）：买家消息进门后开始走流水线（这里用大模型 200ms 慢决策模拟），
//     期间店主打字接手 → 流水线走完到出口时再查一次静音，这条回复必须丢弃不发
globalThis.window.__llmEngine = { decide: async () => { await sleep(200); return { reply: '有的，具体看套餐哦～', delay: 0, needsHuman: false }; } };
const before22 = sent.length;
onMsg({ clientId: 'TK-1', content: '现在还有位置吗', isFromMe: false, senderRole: '1', conversationId: 'CONV9', pigeonMsgType: 'text', timestamp: Date.now() });
await sleep(60);   // 流水线走到一半（大模型还在想）
staffCb({ conversationId: 'CONV9', content: '你好，我来接', isFromMe: true, senderRole: '2', pigeonMsgType: 'text', timestamp: Date.now() });
assert.ok(agent.isMuted('CONV9'), '❌ 前置：店主打字应静音 CONV9');
await sleep(600);  // 等流水线走完（decide 200ms + 余量）
assert.ok(sent.length === before22, '❌ 流水线期间店主接手，回复应被丢弃不发, 实发 ' + (sent.length - before22));
console.log('✅ 22. 发送前静音闸拦截抢话, sent =', sent.length);

// 23) 连发合并：买家趁第一条还在处理时连发两句 → 队列里合并成一条，只再回一条，且两句内容都送达大模型
let lastAsk = '';
globalThis.window.__llmEngine = { decide: async (params) => { await sleep(150); lastAsk = String((params && params.message && params.message.content) || ''); return { reply: '有的，具体看套餐哦～', delay: 0, needsHuman: false }; } };
const before23 = sent.length;
onMsg({ clientId: 'BM-1', content: '合并第一句', isFromMe: false, senderRole: '1', conversationId: 'CONV10', pigeonMsgType: 'text', timestamp: Date.now() });
onMsg({ clientId: 'BM-2', content: '合并第二句', isFromMe: false, senderRole: '1', conversationId: 'CONV10', pigeonMsgType: 'text', timestamp: Date.now() });
onMsg({ clientId: 'BM-3', content: '合并第三句', isFromMe: false, senderRole: '1', conversationId: 'CONV10', pigeonMsgType: 'text', timestamp: Date.now() });
await sleep(1200);
assert.ok(sent.length === before23 + 2, '❌ 连发 3 句应共回 2 条（第 1 句一条 + 合并一条）, 实发 ' + (sent.length - before23));
assert.ok(lastAsk.includes('合并第二句') && lastAsk.includes('合并第三句'), '❌ 合并后两句内容应一起送达大模型, 实际: ' + lastAsk);
console.log('✅ 23. 连发合并只回一条且内容完整, sent =', sent.length, ', 大模型收到 =', JSON.stringify(lastAsk));

// 24) 过期重推闸（2026-08-19 迟到 19 分钟回复事故回归）：SDK 把 6 分钟前的买家消息换个 clientId 重推，
//     bootAt 防重放拦不住（消息晚于启动）、内容指纹窗也过期 → 过期闸必须拦下，一条都不回
agent.getState().bootAt = Date.now() - 15 * 60 * 1000;   // 模拟 agent 已持续运行 15 分钟
const before24 = sent.length;
onMsg({ clientId: 'STALE-1', content: '六分钟前问的旧问题', isFromMe: false, senderRole: '1', conversationId: 'CONV11', pigeonMsgType: 'text', timestamp: Date.now() - 6 * 60 * 1000 });
await sleep(600);
assert.ok(sent.length === before24, '❌ 迟到 6 分钟的重推不应回复, 实发 ' + (sent.length - before24));
console.log('✅ 24. 过期重推拦截（>5 分钟旧消息不回）, sent =', sent.length);

// 25) 乱序合并升序（2026-08-19 回答顺序颠倒反馈回归）：SDK 批量同步可能新消息先入队，
//     队列合并必须按平台时间从旧到新排序——先问的先答
let lastAsk25 = '';
globalThis.window.__llmEngine = { decide: async (params) => { await sleep(150); lastAsk25 = String((params && params.message && params.message.content) || ''); return { reply: '好', delay: 0, needsHuman: false }; } };
const before25 = sent.length;
const t25 = Date.now();
onMsg({ clientId: 'OO-1', content: '先问的第一句', isFromMe: false, senderRole: '1', conversationId: 'CONV12', pigeonMsgType: 'text', timestamp: t25 });
onMsg({ clientId: 'OO-3', content: '后问的第三句', isFromMe: false, senderRole: '1', conversationId: 'CONV12', pigeonMsgType: 'text', timestamp: t25 + 2000 });   // 乱序：晚的先入队
onMsg({ clientId: 'OO-2', content: '中间第二句', isFromMe: false, senderRole: '1', conversationId: 'CONV12', pigeonMsgType: 'text', timestamp: t25 + 1000 });
await sleep(1200);
assert.ok(sent.length === before25 + 2, '❌ 连发 3 句应共回 2 条（第 1 句一条 + 合并一条）, 实发 ' + (sent.length - before25));
assert.ok(lastAsk25 === '中间第二句\n后问的第三句', '❌ 合并后应按提问时间从旧到新排列, 实际: ' + JSON.stringify(lastAsk25));
console.log('✅ 25. 乱序连发合并后按从旧到新排序, 大模型收到 =', JSON.stringify(lastAsk25));

// 26) 转人工集中回复（2026-08-19 店主反馈：接管后别把之前每条都单独回一遍）：
//     接管后第一条买家消息应带上"转人工前积压问题合集"一次答完；第二条起恢复对话式逐条回复
const hist26 = [
  { content: '周末有位置吗', isFromMe: false, senderRole: '1', createTime: Date.now() - 60000 },
  { content: '能带狗吗', isFromMe: false, senderRole: '1', createTime: Date.now() - 50000 },
  { content: '您好，请问有什么可以帮到您？', isFromMe: false, senderRole: '4', createTime: Date.now() - 55000 },   // 平台机器人，应排除
  { content: '周末有位置吗', isFromMe: false, senderRole: '1', createTime: Date.now() - 40000 },                  // 重复问题，应去重
];
bridge.getChatStore = () => ({ _imSdkStore: { getMessagesByConversation: async () => hist26 } });
let lastAsk26 = '';
globalThis.window.__llmEngine = { decide: async (params) => { lastAsk26 = String((params && params.message && params.message.content) || ''); return { reply: '好', delay: 0, needsHuman: false }; } };
agent.markAssigned({ conversationId: 'CONV13' });
const before26 = sent.length;
onMsg({ clientId: 'HO-1', content: '人工', isFromMe: false, senderRole: '1', conversationId: 'CONV13', pigeonMsgType: 'text', timestamp: Date.now() });
await sleep(600);
assert.ok(sent.length === before26 + 1, '❌ 接管后第一条应回 1 条, 实发 ' + (sent.length - before26));
assert.ok(lastAsk26.indexOf('周末有位置吗') === lastAsk26.lastIndexOf('周末有位置吗'), '❌ 重复问题应去重, 实际: ' + JSON.stringify(lastAsk26));
assert.ok(lastAsk26.includes('周末有位置吗') && lastAsk26.includes('能带狗吗'), '❌ 集中回复应包含转人工前全部问题, 实际: ' + JSON.stringify(lastAsk26));
assert.ok(!lastAsk26.includes('帮到您'), '❌ 平台机器人发言不应混入问题合集');
onMsg({ clientId: 'HO-2', content: '那烧烤呢', isFromMe: false, senderRole: '1', conversationId: 'CONV13', pigeonMsgType: 'text', timestamp: Date.now() });
await sleep(600);
assert.ok(lastAsk26 === '那烧烤呢', '❌ 第二条起应恢复对话式逐条回复（不带合集标记）, 实际: ' + JSON.stringify(lastAsk26));
console.log('✅ 26. 转人工集中回复一次 + 之后恢复对话式, 首条 =', JSON.stringify(lastAsk26 === '那烧烤呢' ? '(已验证)' : lastAsk26));

// 27) 买家不满预警（2026-08-19 差评风险事故回归）：买家话里带吐槽信号 → 立刻给店主发 needs-human
//     提醒（红角标+飞书），但 AI 回复照走、会话不静音（买家还等着回话）
const events27 = [];
const origEmit = bridge.emit;
bridge.emit = (ch) => { events27.push(ch); };
onMsg({ clientId: 'CP-1', content: '厕所都没灯，蚊子也多', isFromMe: false, senderRole: '1', conversationId: 'CONV14', pigeonMsgType: 'text', timestamp: Date.now() });
await sleep(600);
bridge.emit = origEmit;
assert.ok(events27.includes('needs-human'), '❌ 吐槽信号应触发 needs-human 提醒, 实际事件: ' + events27.join(','));
assert.ok(!agent.isMuted('CONV14'), '❌ 吐槽提醒不应静音会话');
console.log('✅ 27. 买家不满即时通知店主且不静音');

// 28) 转办承诺上报（2026-08-20 事故回归："稍后让同事加您VX"说出去没人落实）：
//     AI 回复含转办承诺 → 回复照发 + needs-human(kind=followup) + 不静音；30 分钟内同会话不重复提醒
const llmSrc28 = readFileSync(new URL('../core/llm-engine.js', import.meta.url), 'utf8');
const tmpWin28 = { location: { origin: 'https://life.douyin.com' } };
new Function('window', llmSrc28)(tmpWin28);   // 只取真实 detectFollowup（decide 仍用桩，不走网络）
const engineBefore28 = globalThis.window.__llmEngine;
globalThis.window.__llmEngine = {
  decide: async () => ({ reply: '好的，这是您的号码对吧？我记下了，稍后让同事加您VX联系您哦', delay: 0, needsHuman: false }),
  detectFollowup: tmpWin28.__llmEngine.detectFollowup,
};
const events28 = [];
const sentBefore28 = sent.length;
const origEmit28 = bridge.emit;
bridge.emit = (ch, d) => { events28.push({ ch, d }); };
onMsg({ clientId: 'FU-1', content: '我的电话是13812345678，让你们人联系我', isFromMe: false, senderRole: '1', conversationId: 'CONV15', pigeonMsgType: 'text', timestamp: Date.now() });
await sleep(600);
assert.ok(sent.length === sentBefore28 + 1 && sent[sent.length - 1].content.includes('加您VX'), '❌ 转办承诺回复应照发, sent=' + JSON.stringify(sent[sent.length - 1]));
const fuEvt = events28.find(e => e.ch === 'needs-human');
assert.ok(fuEvt && fuEvt.d && fuEvt.d.kind === 'followup', '❌ 转办承诺应触发 needs-human(kind=followup), 实际: ' + JSON.stringify(events28));
assert.ok(!agent.isMuted('CONV15'), '❌ 转办承诺不应静音会话（AI 继续接待）');
// 冷却：同会话 30 分钟内第二条承诺不再重复提醒
events28.length = 0;
onMsg({ clientId: 'FU-2', content: '好，那你们加我', isFromMe: false, senderRole: '1', conversationId: 'CONV15', pigeonMsgType: 'text', timestamp: Date.now() });
await sleep(600);
assert.ok(!events28.some(e => e.ch === 'needs-human'), '❌ 30 分钟冷却期内不应重复提醒');
bridge.emit = origEmit28;
globalThis.window.__llmEngine = engineBefore28;
if (!fuEvt || events28.some(e => e.ch === 'needs-human')) { console.log('❌ FAILED: 28 转办承诺'); process.exit(1); }
console.log('✅ 28. 转办承诺照发 + kind=followup 上报 + 不静音 + 冷却');

console.log('ALL PASS');
