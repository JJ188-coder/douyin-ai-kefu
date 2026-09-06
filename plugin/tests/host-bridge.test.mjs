// host-bridge.js chatlog 落盘去重自测（node 直跑，mock chrome.storage + window 消息桥）
// 覆盖：1) 刷新 backfill 重复推送只落盘一次  2) 不同消息正常落盘  3) 真实重发同内容（不同时间）不去重
import { readFileSync } from 'fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../host-bridge.js', import.meta.url), 'utf8');

const store = {};
const posted = [];
let runtimeListener;
globalThis.chrome = {
  storage: { local: {
    get: async (k) => (Array.isArray(k) ? Object.fromEntries(k.map((x) => [x, store[x]])) : { [k]: store[k] }),
    set: async (o) => Object.assign(store, o),
  } },
  runtime: { sendMessage: () => {}, onMessage: { addListener: (fn) => { runtimeListener = fn; } }, lastError: null },
};
const listeners = [];
globalThis.window = {
  addEventListener: (t, fn) => listeners.push(fn),
  postMessage: (d) => { posted.push(d); for (const fn of listeners) fn({ data: d }); },
  location: { origin: 'https://life.douyin.com' },
};
eval(src);

const pushChat = (p) => globalThis.window.postMessage({ __aics: 'bridge-chatlog', payload: p });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 模拟刷新后 backfill 重推：同一条历史消息推 3 遍 → 只落盘 1 条
const hist = { t: '2026-08-18T10:00:00.000Z', conv: 'c1', who: 'buyer', text: '周末有位置吗' };
pushChat(hist); pushChat(hist); pushChat(hist);
await sleep(300);
assert.equal((store.chatlog || []).length, 1, '❌ backfill 重复消息应只落盘一次, 实际 ' + (store.chatlog || []).length);
console.log('✅ 1. backfill 重推去重, chatlog =', store.chatlog.length);

// 2) 不同内容的消息 → 正常落盘
pushChat({ t: '2026-08-18T10:01:00.000Z', conv: 'c1', who: 'ai', text: '有的，您几位呢～' });
await sleep(300);
assert.equal(store.chatlog.length, 2, '❌ 新消息应正常落盘, 实际 ' + store.chatlog.length);
console.log('✅ 2. 新消息正常落盘, chatlog =', store.chatlog.length);

// 3) 真实场景：买家不同时间发了两次一模一样的"在吗"（t 不同）→ 不能误去重
pushChat({ t: '2026-08-18T11:00:00.000Z', conv: 'c2', who: 'buyer', text: '在吗' });
pushChat({ t: '2026-08-18T11:05:00.000Z', conv: 'c2', who: 'buyer', text: '在吗' });
await sleep(300);
assert.equal(store.chatlog.length, 4, '❌ 不同时间的同内容消息不应去重, 实际 ' + store.chatlog.length);
console.log('✅ 3. 真实重发不误伤, chatlog =', store.chatlog.length);

window.postMessage({ __aics: 'bridge-config-applied', payload: { ok: true, cmd: 'apply-config', configRevision: 0 } });
const publicConfig = { enabled: false, autoSend: false, provider: 'deepseek', kb: ['合成知识库'] };
runtimeListener({ type: 'aics-cmd', cmd: 'apply-config', payload: {
  ...publicConfig, apiKey: 'test-only', feishuWebhook: 'https://example.invalid/hook',
  feishuAppSecret: 'test-only', feishuAppId: 'test-app', feishuChatId: 'test-chat',
} });
assert.deepEqual(posted.at(-1).payload, publicConfig, '运行配置可进入网页，模型/飞书凭据不可进入 MAIN world');
console.log('✅ 4. popup 配置中继不泄露凭据');

console.log('ALL PASS');
