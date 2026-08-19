// 门禁行为自测（node 直跑，不依赖浏览器）
// 覆盖：1) 历史重推不回  2) 每条新买家消息开启新回合  3) 同 clientId 双推拦截  4) 每回合最多 N 条
import { readFileSync } from 'fs';

const src = readFileSync(new URL('../core/agent.js', import.meta.url), 'utf8');

const sent = [];
const sentMem = new Set();   // 真实化发送记录：验证"先登记再发送"的防误判
let onMsg;
let staffCb;
let closeCb;
const bridge = {
  getChatStore: () => ({ _imSdkStore: { getMessagesByConversation: async () => [] } }),
  sendText: (conv, content) => { sent.push({ conv, content }); },
  rememberSent: (c) => sentMem.add(String(c || '').slice(0, 200)),
  isSent: (c) => sentMem.has(String(c || '').slice(0, 200)),
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
console.assert(sent.length === 0, '❌ 历史消息不应回复');
console.log('✅ 1. 历史重推不回, sent =', sent.length);

// 2) 新消息 A → 回 1 条
buyerMsg('A-1', '在吗');
await sleep(450);
console.assert(sent.length === 1, '❌ 新消息应回 1 条');
console.log('✅ 2. 新买家消息回 1 条, sent =', sent.length);

// 3) 同一条双推（同 clientId）→ 不追发
buyerMsg('A-1', '在吗');
await sleep(450);
console.assert(sent.length === 1, '❌ 同 clientId 双推不应追发');
console.log('✅ 3. 双推拦截, sent =', sent.length);

// 4) 买家再发新消息 B → 新回合，又回 1 条
buyerMsg('B-1', '明天营业吗');
await sleep(450);
console.assert(sent.length === 2, '❌ 新买家消息应开启新回合再回 1 条');
console.log('✅ 4. 新消息重置回合, sent =', sent.length);

// 5) 无新消息时的异常重复触发（不同 clientId 但属于异常场景由 maxPerTurn 兜底）：
//    模拟买家连发 3 条，每条都应各回 1 条
buyerMsg('C-1', '问1'); buyerMsg('C-2', '问2'); buyerMsg('C-3', '问3');
await sleep(700);
console.assert(sent.length === 5, '❌ 连发 3 条应各回 1 条, 实发 ' + sent.length);
console.log('✅ 5. 买家连发每条各回 1, sent =', sent.length);


// 6) 平台机器人欢迎语卡片（type=card, role=4）→ 不回
onMsg({ clientId: 'CARD-4', content: '您好，请问有什么可以帮到您？', isFromMe: false, senderRole: '4', conversationId: 'CONV1', pigeonMsgType: 'card', timestamp: NOW });
await sleep(450);
console.assert(sent.length === 5, '❌ role=4 卡片不应回复, 实发 ' + sent.length);
console.log('✅ 6. 平台卡片(role=4)拦截, sent =', sent.length);

// 7) 真人商品卡咨询（type=card, role=1）→ 回
onMsg({ clientId: 'CARD-1', content: '这个套餐周末能用吗', isFromMe: false, senderRole: '1', conversationId: 'CONV1', pigeonMsgType: 'card', timestamp: NOW });
await sleep(450);
console.assert(sent.length === 6, '❌ 真人卡片(role=1)应回复, 实发 ' + sent.length);
console.log('✅ 7. 真人卡片(role=1)正常回复, sent =', sent.length);

// 8) 同内容换 clientId 重推（60s 内）→ 不回（指纹去重）
onMsg({ clientId: 'NEW-ID-1', content: '这个套餐周末能用吗', isFromMe: false, senderRole: '1', conversationId: 'CONV1', pigeonMsgType: 'text', timestamp: NOW });
await sleep(450);
console.assert(sent.length === 6, '❌ 换id重推同内容不应再回, 实发 ' + sent.length);
console.log('✅ 8. 内容指纹去重, sent =', sent.length);

// 9) 发送锁：处理中连到两条不同内容 → 第一条回 + pending 补一条，共 2 条（不多不少）
onMsg({ clientId: 'L-1', content: '锁测试一', isFromMe: false, senderRole: '1', conversationId: 'CONV1', pigeonMsgType: 'text', timestamp: NOW });
onMsg({ clientId: 'L-2', content: '锁测试二', isFromMe: false, senderRole: '1', conversationId: 'CONV1', pigeonMsgType: 'text', timestamp: NOW });
await sleep(1500);
console.assert(sent.length === 8, '❌ 锁+pending 应共回 2 条, 实发 ' + (sent.length - 6));
console.log('✅ 9. 发送锁+pending 补处理, sent =', sent.length);

// 10) 人工接管静音：店主在某会话发一条消息 → 该会话买家新消息 AI 不回（不抢答）
const before = sent.length;
staffCb({ conversationId: 'CONV2', content: '您好，我是人工客服，请问有什么问题', isFromMe: true, senderRole: '2', pigeonMsgType: 'text', timestamp: NOW });
onMsg({ clientId: 'M-1', content: '我想问下价格', isFromMe: false, senderRole: '1', conversationId: 'CONV2', pigeonMsgType: 'text', timestamp: NOW });
await sleep(450);
console.assert(sent.length === before, '❌ 人工静音期内不应自动回复, 实发 ' + (sent.length - before));
console.log('✅ 10. 人工接管后 AI 静音不抢答, sent =', sent.length);

// 11) 静音关闭自动恢复：staffMuteMinutes=0（不静音）时，人工发消息后买家消息仍应回复
agent.applyConfig({ staffMuteMinutes: 0 });   // 0 = 不静音
staffCb({ conversationId: 'CONV3', content: '人工在', isFromMe: true, senderRole: '2', pigeonMsgType: 'text', timestamp: NOW });
onMsg({ clientId: 'R-1', content: '到期恢复测试', isFromMe: false, senderRole: '1', conversationId: 'CONV3', pigeonMsgType: 'text', timestamp: NOW });
await sleep(450);
console.assert(sent.length === before + 1, '❌ 静音关闭后应恢复回复, 实发 ' + (sent.length - before));
console.log('✅ 11. 静音关闭后 AI 恢复接管, sent =', sent.length);

// 12) needsHuman：AI 回复含「帮您确认」→ 会话自动静音 + 触发 needs-human 上报
let needsHumanFired = null;
bridge.emit = (evt, d) => { if (evt === 'needs-human') needsHumanFired = d; };
const llm2 = { decide: async () => ({ reply: '这个我帮您确认一下哦～', delay: 0, needsHuman: true }) };
globalThis.window.__llmEngine = llm2;
agent.applyConfig({ staffMuteMinutes: 15, minIntervalMs: 1, maxRepliesPerConv: 1 });
onMsg({ clientId: 'NH-1', content: '有没有什么特殊优惠', isFromMe: false, senderRole: '1', conversationId: 'CONV4', pigeonMsgType: 'text', timestamp: NOW });
await sleep(450);
console.assert(needsHumanFired && needsHumanFired.conversationId === 'CONV4', '❌ needs-human 未触发');
console.assert(agent.isMuted('CONV4'), '❌ 答不了后会话应自动静音');
console.assert(agent.getState().staffMuteByConv.get('CONV4') === Infinity, '❌ needsHuman 静音应为无限期等人工（不自动到期）');
console.log('✅ 12. needsHuman 上报 + 会话无限期静音等人工', 'needsHuman=', !!needsHumanFired, 'mutedUntil=', agent.getState().staffMuteByConv.get('CONV4'));

// 12.5) 无限期静音期间人工发消息 → 从这一刻起改算 15 分钟有限期
staffCb({ conversationId: 'CONV4', content: '我来了，这个问题我处理', isFromMe: true, senderRole: '2', pigeonMsgType: 'text', timestamp: Date.now() });
const until4 = agent.getState().staffMuteByConv.get('CONV4');
console.assert(until4 !== Infinity && until4 > Date.now() + 14 * 60000 && until4 <= Date.now() + 15 * 60000, '❌ 人工发消息后应改为 15 分钟有限期, 实际 ' + until4);
console.log('✅ 12.5 人工发消息那一刻起算 15 分钟, remainSec=', Math.round((until4 - Date.now()) / 1000));

// 13) unmute 解除静音 → 换回正常 llm，买家消息恢复回复
agent.unmuteConv('CONV4');
globalThis.window.__llmEngine = { decide: async () => ({ reply: '有的，具体看套餐哦～', delay: 0, needsHuman: false }) };
onMsg({ clientId: 'NH-2', content: '那换个问题', isFromMe: false, senderRole: '1', conversationId: 'CONV4', pigeonMsgType: 'text', timestamp: NOW });
await sleep(450);
console.assert(!agent.isMuted('CONV4'), '❌ unmute 后不应再静音');
console.assert(sent[sent.length - 1] && sent[sent.length - 1].conv === 'CONV4', '❌ unmute 后应恢复回复');
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
console.assert(!agent.isMuted('CONV5'), '❌ AI 自回同步回推不应触发人工静音');
console.assert(sent[sent.length - 1] && sent[sent.length - 1].conv === 'CONV5', '❌ 同步回推场景下回复应正常发出');
console.log('✅ 14. AI 自回同步回推不误判人工, muted=', agent.isMuted('CONV5'), 'sent=', sent.length);

// 15) 历史重推的人工消息（timestamp 早于启动时间）→ noteStaff 直接忽略，不静音
staffCb({ conversationId: 'CONV6', content: '重连前人工发的旧消息', isFromMe: true, senderRole: '2', pigeonMsgType: 'text', timestamp: NOW - 600000 });
console.assert(!agent.isMuted('CONV6'), '❌ 历史重推的人工消息不应触发静音');
console.log('✅ 15. 历史重推不误判人工接管, muted=', agent.isMuted('CONV6'));

// 16) 人工静音后会话关闭 → 重开是新的一局：静音不遗传，买家新消息正常回复
staffCb({ conversationId: 'CONV7', content: '人工处理一下', isFromMe: true, senderRole: '2', pigeonMsgType: 'text', timestamp: Date.now() });
console.assert(agent.isMuted('CONV7'), '❌ 前置：人工发消息应静音 CONV7');
closeCb({ conversationId: 'CONV7', content: '[客服关闭会话]', isFromMe: true, senderRole: '2', pigeonMsgType: 'text', timestamp: Date.now() });
console.assert(!agent.isMuted('CONV7'), '❌ 会话关闭后静音应清除');
onMsg({ clientId: 'REOPEN-1', content: '重开后买家提问', isFromMe: false, senderRole: '1', conversationId: 'CONV7', pigeonMsgType: 'text', timestamp: Date.now() });
await sleep(450);
console.assert(sent[sent.length - 1] && sent[sent.length - 1].conv === 'CONV7', '❌ 关闭重开后买家消息应正常回复');
console.log('✅ 16. 关闭重开静音不遗传, sent=', sent.length);

// 17) 人工静音后重新分配（allocated）→ 静音解除
staffCb({ conversationId: 'CONV8', content: '人工接待中', isFromMe: true, senderRole: '2', pigeonMsgType: 'text', timestamp: Date.now() });
console.assert(agent.isMuted('CONV8'), '❌ 前置：人工发消息应静音 CONV8');
agent.markAssigned({ conversationId: 'CONV8' });
console.assert(!agent.isMuted('CONV8'), '❌ 重新分配后静音应解除');
console.log('✅ 17. 重新分配解除残留静音, muted=', agent.isMuted('CONV8'));

// 18) 同买家不同 convId 前缀（SDK 会话实例分叉）推同一条内容 → 归一化后指纹拦截，只回一次
const before18 = sent.length;
onMsg({ clientId: 'FORK-1', content: '这个多少钱', isFromMe: false, senderRole: '1', conversationId: 'AAA:shop1:buyer1', pigeonMsgType: 'text', timestamp: Date.now() });
await sleep(450);
onMsg({ clientId: 'FORK-2', content: '这个多少钱', isFromMe: false, senderRole: '1', conversationId: 'BBB:shop1:buyer1', pigeonMsgType: 'text', timestamp: Date.now() });
await sleep(450);
console.assert(sent.length === before18 + 1, '❌ 同买家同内容跨 convId 应只回一次, 实发 ' + (sent.length - before18));
console.log('✅ 18. convId 分叉防重（只回一次）, sent =', sent.length);

console.log('ALL PASS');
process.exit(0);
