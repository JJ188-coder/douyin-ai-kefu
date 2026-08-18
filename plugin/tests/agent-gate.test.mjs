// 门禁行为自测（node 直跑，不依赖浏览器）
// 覆盖：1) 历史重推不回  2) 每条新买家消息开启新回合  3) 同 clientId 双推拦截  4) 每回合最多 N 条
import { readFileSync } from 'fs';

const src = readFileSync(new URL('../core/agent.js', import.meta.url), 'utf8');

const sent = [];
const bridge = {
  getChatStore: () => ({ _imSdkStore: { getMessagesByConversation: async () => [] } }),
  sendText: (conv, content) => { sent.push({ conv, content }); },
  rememberSent: () => {}, isSent: () => false,
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
// enable() 里调用 b.startListening({ onMessage, onAssign }) —— 我们的 fake 没捕获回调，重来：
let onMsg;
bridge.startListening = (opts) => { onMsg = opts.onMessage; return () => {}; };
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

console.log('ALL PASS');
