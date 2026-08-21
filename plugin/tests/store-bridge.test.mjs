// store-bridge.js staff-activity 过滤自测（node 直跑，不依赖浏览器）
// 覆盖：1) 历史重推的 isFromMe 消息不派发  2) 系统提示/自动欢迎语不派发  3) AI 自回不派发  4) 真人实时打字正常派发
import { readFileSync } from 'fs';
import assert from 'node:assert/strict';

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
assert.equal(staffEvents.length, 0, '❌ 历史重推不应派发 staff-activity');
console.log('✅ 1. 历史重推不派发, events =', staffEvents.length);

// 2) 系统提示 [用户超时未回复，系统关闭会话] → 不派发
fire({ clientId: 's1', content: '[用户超时未回复，系统关闭会话]', isFromMe: true, senderRole: '2', bizConversationId: 'C1', pigeonMsgType: 'text', createTime: NOW });
assert.equal(staffEvents.length, 0, '❌ 系统提示不应派发');
console.log('✅ 2. 系统关闭提示不派发, events =', staffEvents.length);

// 3) 平台自动欢迎语 → 不派发
fire({ clientId: 's2', content: '很高兴为您服务，请问有什么可以帮您？', isFromMe: true, senderRole: '2', bizConversationId: 'C1', pigeonMsgType: 'text', createTime: NOW });
assert.equal(staffEvents.length, 0, '❌ 自动欢迎语不应派发');
console.log('✅ 3. 自动欢迎语不派发, events =', staffEvents.length);

// 4) AI 自己发的（按会话 rememberSent 登记过）→ 不派发
bridge.rememberSent('C1', 'AI 的回复内容');
fire({ clientId: 'a1', content: 'AI 的回复内容', isFromMe: true, senderRole: '2', bizConversationId: 'C1', pigeonMsgType: 'text', createTime: NOW });
assert.equal(staffEvents.length, 0, '❌ 按会话登记的 AI 自回不应派发');
console.log('✅ 4. AI 自回不派发, events =', staffEvents.length);

// 5) 真人客服实时打字 → 正常派发（onMessage + onMessageUpsert 双推各一次，下游静音逻辑幂等无害）
fire({ clientId: 'm1', content: '亲我在的，您直接说', isFromMe: true, senderRole: '2', bizConversationId: 'C1', pigeonMsgType: 'text', createTime: NOW });
assert.equal(staffEvents.length, 2, '❌ 真人实时消息应派发（双推 2 次）, 实际 ' + staffEvents.length);
console.log('✅ 5. 真人实时打字正常派发, events =', staffEvents.length);

// 6) 会话关闭系统提示（isFromMe=true）→ 派发 conversation-closed，且不算人工活动
const staffBefore = staffEvents.length;
fire({ clientId: 'c1', content: '[客服关闭会话]', isFromMe: true, senderRole: '2', bizConversationId: 'C1', pigeonMsgType: 'text', createTime: NOW });
assert.ok(closeEvents.length >= 1, '❌ 关闭提示应派发 conversation-closed');
assert.equal(staffEvents.length, staffBefore, '❌ 关闭提示不应算人工活动');
console.log('✅ 6. 关闭提示派发 closed 且不误判人工, close =', closeEvents.length);

// 7) 平台智能客服消息（isFromMe=true, senderRole=4）→ 不算人工活动，不触发静音
const staffBefore7 = staffEvents.length;
fire({ clientId: 'p1', content: '平台机器人：这个问题答案是……', isFromMe: true, senderRole: '4', bizConversationId: 'C1', pigeonMsgType: 'text', createTime: NOW });
assert.equal(staffEvents.length, staffBefore7, '❌ 平台 AI 发言不应算人工活动');
console.log('✅ 7. 平台 AI 发言不触发人工静音, events =', staffEvents.length);

// 8) 四类角色分类：买家 / 平台AI(两种 isFromMe) / 我们的AI / 真人客服
assert.equal(bridge.classifyMessage({ isFromMe: true, senderRole: '4', content: 'x', pigeonMsgType: 'text' }), 'platformAi', '❌ isFromMe=true 的 role4 应分类 platformAi');
assert.equal(bridge.classifyMessage({ isFromMe: false, senderRole: '4', content: '欢迎语', pigeonMsgType: 'text' }), 'platformAi', '❌ isFromMe=false 的 role4 应分类 platformAi');
bridge.rememberSent('我们自己发的话术');
assert.equal(bridge.classifyMessage({ isFromMe: true, senderRole: '2', content: '我们自己发的话术', pigeonMsgType: 'text' }), 'aiSelf', '❌ 发送记录命中应分类 aiSelf');
assert.equal(bridge.classifyMessage({ isFromMe: true, senderRole: '2', content: '人工在打字', pigeonMsgType: 'text' }), 'staff', '❌ 真人打字应分类 staff');
assert.equal(bridge.classifyMessage({ isFromMe: false, senderRole: '1', content: '在吗', pigeonMsgType: 'text' }), 'buyer', '❌ 买家应分类 buyer');
console.log('✅ 8. 角色分类：买家/平台AI/我们的AI/真人客服 四类正确');

// 9) 回归（2026-08-19 生产事故）：AI 回复 30 分钟后被 SDK 重推（已读回执/重连），
//    旧代码内容指纹 30min 过期 → isSent 失配 → 误判人工发言 → 误静音会话漏回买家。
//    修复后：发送回执到达时学到 clientId，重推凭 clientId 永久免疫，不再派发人工活动。
const staffBefore9 = staffEvents.length;
bridge.rememberSent('调料都含在套餐里的哈');
fire({ clientId: 'echo-9', content: '调料都含在套餐里的哈', isFromMe: true, senderRole: '2', bizConversationId: 'C1', pigeonMsgType: 'text', createTime: NOW });
assert.equal(staffEvents.length, staffBefore9, '❌ 发送回执不应派发人工活动');
assert.ok(bridge.isSentClientId('echo-9'), '❌ 回执到达后应学到 clientId');
// 模拟"很久之后"的同一条重推：即使内容对不上（极端情况），凭 clientId 也不误判人工
fire({ clientId: 'echo-9', content: '调料都含在套餐里的哈', isFromMe: true, senderRole: '2', bizConversationId: 'C1', pigeonMsgType: 'text', createTime: NOW + 3600000 });
fire({ clientId: 'echo-9', content: '调料都含在套餐里的哈（平台改了一个字符）', isFromMe: true, senderRole: '2', bizConversationId: 'C1', pigeonMsgType: 'text', createTime: NOW + 3600001 });
assert.equal(staffEvents.length, staffBefore9, '❌ 学过 clientId 的重推不应误判人工（模拟 TTL 过期事故）');
assert.equal(bridge.classifyMessage({ isFromMe: true, senderRole: '2', content: '别的内容', clientId: 'echo-9', pigeonMsgType: 'text' }), 'aiSelf', '❌ clientId 命中应分类 aiSelf');
console.log('✅ 9. clientId 免疫重推：过期/变体重推不再误判人工, events =', staffEvents.length);

// 10) 没学过 clientId 的真人发言重推 → 仍然正常派发（不误伤人工接管检测）
const staffBefore10 = staffEvents.length;
fire({ clientId: 'human-10', content: '人工晚班接手了', isFromMe: true, senderRole: '2', bizConversationId: 'C1', pigeonMsgType: 'text', createTime: NOW });
assert.equal(staffEvents.length, staffBefore10 + 2, '❌ 真人实时发言应正常派发, 实际新增 ' + (staffEvents.length - staffBefore10));
console.log('✅ 10. 真人发言不受影响, events =', staffEvents.length);

console.log('ALL PASS');
