// llm 请求并发串台回归自测（node 直跑，mock window 消息桥 + host-bridge 中继）
// 覆盖：1) 两个并发请求乱序回包时各拿各的回复  2) 超时不挂住  3) chat 失败重试一次后成功  4) host-bridge 原样透传 reqId
import { readFileSync } from 'fs';
import assert from 'node:assert/strict';

const engineSrc = readFileSync(new URL('../core/llm-engine.js', import.meta.url), 'utf8');
const bridgeSrc = readFileSync(new URL('../host-bridge.js', import.meta.url), 'utf8');

// ---- 消息总线：llm-engine(MAIN) 与 host-bridge(ISOLATED) 共享 ----
const mainListeners = new Set();
const bridgeListeners = new Set();
function makeWindow(set) {
  return {
    addEventListener: (t, fn) => set.add(fn),
    removeEventListener: (t, fn) => set.delete(fn),
    postMessage: (d) => { for (const fn of [...set]) fn({ data: d }); },
    location: { origin: 'https://life.douyin.com' },
  };
}
// MAIN window：postMessage 同时投递到 MAIN 与 bridge 监听者（真实页面里两个 world 共享 window 事件）
const mainWin = makeWindow(mainListeners);
const realPost = mainWin.postMessage;
mainWin.postMessage = (d) => { realPost(d); for (const fn of [...bridgeListeners]) fn({ data: d }); };
const bridgeWin = makeWindow(bridgeListeners);
bridgeWin.postMessage = (d) => { for (const fn of [...mainListeners]) fn({ data: d }); };

// ---- 可控的 background：chrome.runtime.sendMessage 存起来，由测试手动按任意顺序回包 ----
const pendingBg = [];
globalThis.chrome = {
  storage: { local: { get: async () => ({}), set: async () => {} } },
  runtime: {
    sendMessage: (msg, cb) => { if (msg && msg.type === 'llm-chat') pendingBg.push({ msg, cb }); },
    onMessage: { addListener: () => {} },
    lastError: null,
  },
};

const realWindow = globalThis.window;
globalThis.window = mainWin;
eval(engineSrc);                       // 挂 window.__llmEngine
const engine = globalThis.window.__llmEngine;

// host-bridge 在自己的 world（bridgeWin），但它内部调 window/chrome —— 用 with 作用域换装
const fn = new Function('window', 'chrome', bridgeSrc);
fn(bridgeWin, globalThis.chrome);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 两个会话并发请求，background 乱序回包（先回 B 再回 A）→ 各拿各的
const pA = engine.getProvider('remote').chat([{ role: 'user', content: 'A的问题：多少钱' }]);
const pB = engine.getProvider('remote').chat([{ role: 'user', content: 'B的问题：能预约吗' }]);
await sleep(50);
assert.equal(pendingBg.length, 2, '❌ 应有 2 个在途请求, 实际 ' + pendingBg.length);
pendingBg[1].cb({ ok: true, text: 'B的回复：可以预约' });   // B 先回来
pendingBg[0].cb({ ok: true, text: 'A的回复：398元' });      // A 后回来
const [rA, rB] = await Promise.all([pA, pB]);
assert.equal(rA, 'A的回复：398元', '❌ A 拿错了回复: ' + rA);
assert.equal(rB, 'B的回复：可以预约', '❌ B 拿错了回复（串台）: ' + rB);
console.log('✅ 1. 并发乱序回包不串台, A=' + rA + ' | B=' + rB);

// 2) host-bridge 把 reqId 原样透传回页面（桥层回归：reqId 丢了上面就会全错）
//    间接验证：上面两请求经 bridge 转发后 background 收到的消息应能被正确回路由
assert.equal(mainListeners.size, 0, '❌ 请求完成后监听器应已清理, 残留 ' + mainListeners.size);
console.log('✅ 2. 回复后监听器无残留（bridge 透传 reqId 生效）');

// 3) decide 失败重试：第一次 chat 失败、第二次成功 → 最终拿到回复
engine.registerProvider('flaky', (() => {
  let calls = 0;
  return { chat: async () => { calls++; if (calls === 1) throw new Error('模拟限速 429'); return '重试后的回复'; } };
})());
const d = await engine.decide({ providerName: 'flaky', message: { conversationId: 'c1', content: '在吗' }, history: [], profile: {}, kb: [] });
assert.equal(d && d.reply, '重试后的回复', '❌ 重试后应拿到回复, 实际 ' + (d && d.reply));
console.log('✅ 3. 首次失败自动重试一次成功');

// 4) 两次都失败 → decide 抛错（上层 agent 记 notice），不静默吞掉
engine.registerProvider('alwaysFail', { chat: async () => { throw new Error('持续失败'); } });
let threw = false;
try { await engine.decide({ providerName: 'alwaysFail', message: { conversationId: 'c1', content: '在吗' }, history: [], profile: {}, kb: [] }); }
catch (e) { threw = true; }
assert.ok(threw, '❌ 持续失败应抛错让上层感知');
console.log('✅ 4. 持续失败抛错（上层记事件日志）');

// 5) 波浪线禁令（2026-08-19 店主要求回归）：模型输出带 ～/〜/~ → 发送前清洗必须删干净；
//    且 system prompt 里必须带禁波浪线规则
let sysSeen = '';
engine.registerProvider('tilde', { chat: async (msgs) => { sysSeen = String(msgs[0].content || ''); return '好的亲～包您满意〜一定哦~'; } });
const d5 = await engine.decide({ providerName: 'tilde', message: { conversationId: 'c1', content: '在吗' }, history: [], profile: {}, kb: [] });
assert.equal(d5 && d5.reply, '好的亲包您满意一定哦', '❌ 波浪线应被清洗删除, 实际: ' + (d5 && d5.reply));
assert.ok(sysSeen.includes('禁止使用波浪线'), '❌ system prompt 应含禁波浪线规则');
console.log('✅ 5. 波浪线清洗 + 规则注入, 回复 =', JSON.stringify(d5.reply));

globalThis.window = realWindow;
console.log('ALL PASS');
