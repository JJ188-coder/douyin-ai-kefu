// store-bridge.js staff-activity 过滤自测（node 直跑，不依赖浏览器）
// 覆盖：1) 历史重推的 isFromMe 消息不派发  2) 系统提示/自动欢迎语不派发  3) AI 自回不派发  4) 真人实时打字正常派发
import { readFileSync } from 'fs';

const src = readFileSync(new URL('../core/store-bridge.js', import.meta.url), 'utf8');

const cbs = [];   // sdk 注册的消息回调
const fakeSdk = {
  onMessage: (cb) => { cbs.push(cb); return () => {}; },
  onMessageUpsert: (cb) => { cbs.push(cb); return () => {}; },
};
const fakeStore = { _imSdkStore: fakeSdk, _config: { pigeonBizType: '7' } };
globalThis.window = { Garfish: { apps: { cs_web: { global: { _chatStore: fakeStore } } } } };
eval(src);
const bridge = globalThis.window.__storeBridge;

const staffEvents = [];
const closeEvents = [];
bridge.startListening({ onStaff: (item) => staffEvents.push(item), onMessage: () => {}, onAssign: () => {}, onClose: (item) => closeEvents.push(item) });
const fire = (msg) => cbs.forEach((cb) => cb(msg));

const NOW = Date.now();

// 1) 历史重推的人工消息（5 分钟前，重载/重连后 SDK 重放）→ 不派发
fire({ clientId: 'h1', content: '重连前人工发的旧消息', isFromMe: true, senderRole: '2', bizConversationId: 'C1', pigeonMsgType: 'text', createTime: NOW - 300000 });
console.assert(staffEvents.length === 0, '❌ 历史重推不应派发 staff-activity');
console.log('✅ 1. 历史重推不派发, events =', staffEvents.length);

// 2) 系统提示 [用户超时未回复，系统关闭会话] → 不派发
fire({ clientId: 's1', content: '[用户超时未回复，系统关闭会话]', isFromMe: true, senderRole: '2', bizConversationId: 'C1', pigeonMsgType: 'text', createTime: NOW });
console.assert(staffEvents.length === 0, '❌ 系统提示不应派发');
console.log('✅ 2. 系统关闭提示不派发, events =', staffEvents.length);

// 3) 平台自动欢迎语 → 不派发
fire({ clientId: 's2', content: '很高兴为您服务，请问有什么可以帮您？', isFromMe: true, senderRole: '2', bizConversationId: 'C1', pigeonMsgType: 'text', createTime: NOW });
console.assert(staffEvents.length === 0, '❌ 自动欢迎语不应派发');
console.log('✅ 3. 自动欢迎语不派发, events =', staffEvents.length);

// 4) AI 自己发的（rememberSent 登记过）→ 不派发
bridge.rememberSent('AI 的回复内容');
fire({ clientId: 'a1', content: 'AI 的回复内容', isFromMe: true, senderRole: '2', bizConversationId: 'C1', pigeonMsgType: 'text', createTime: NOW });
console.assert(staffEvents.length === 0, '❌ AI 自回不应派发');
console.log('✅ 4. AI 自回不派发, events =', staffEvents.length);

// 5) 真人客服实时打字 → 正常派发（onMessage + onMessageUpsert 双推各一次，下游静音逻辑幂等无害）
fire({ clientId: 'm1', content: '亲我在的，您直接说', isFromMe: true, senderRole: '2', bizConversationId: 'C1', pigeonMsgType: 'text', createTime: NOW });
console.assert(staffEvents.length === 2, '❌ 真人实时消息应派发（双推 2 次）, 实际 ' + staffEvents.length);
console.log('✅ 5. 真人实时打字正常派发, events =', staffEvents.length);

// 6) 会话关闭系统提示（isFromMe=true）→ 派发 conversation-closed，且不算人工活动
const staffBefore = staffEvents.length;
fire({ clientId: 'c1', content: '[客服关闭会话]', isFromMe: true, senderRole: '2', bizConversationId: 'C1', pigeonMsgType: 'text', createTime: NOW });
console.assert(closeEvents.length >= 1, '❌ 关闭提示应派发 conversation-closed');
console.assert(staffEvents.length === staffBefore, '❌ 关闭提示不应算人工活动');
console.log('✅ 6. 关闭提示派发 closed 且不误判人工, close =', closeEvents.length);

console.log('ALL PASS');
process.exit(0);
