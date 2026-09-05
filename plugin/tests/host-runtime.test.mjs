import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sources = ['core/store-bridge.js', 'core/agent.js', 'core/host.js', 'host-bridge.js']
  .map((file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const settle = () => new Promise(setImmediate);

function boot({ config = {}, ready = true, configGate } = {}) {
  const storage = clone(config), listeners = [], timers = [], sdkListeners = new Set();
  let command;
  const sdk = {
    onMessage(fn) { sdkListeners.add(fn); return () => sdkListeners.delete(fn); },
    getMessagesByConversation: async () => [],
    sendText: async () => { throw new Error('测试禁止发送真实消息'); },
  };
  const window = {
    location: { origin: 'https://life.douyin.com' },
    addEventListener: (_, fn) => listeners.push(fn),
    postMessage(data) {
      queueMicrotask(() => { for (const fn of [...listeners]) fn({ data: clone(data), source: window, origin: window.location.origin }); });
    },
    __llmEngine: { decide: async () => ({ reply: '合成预览', delay: 0 }) },
  };
  const makeReady = () => {
    window.Garfish = { apps: { cs_web: { global: { _chatStore: {
      _imSdkStore: sdk, _conversationStore: { totalContacts: new Map() },
    } } } } };
  };
  if (ready) makeReady();
  const chrome = {
    storage: { local: {
      async get(keys, cb) {
        const list = Array.isArray(keys) ? keys : [keys];
        const result = clone(Object.fromEntries(list.filter((k) => Object.hasOwn(storage, k)).map((k) => [k, storage[k]])));
        if (list.includes('enabled') && configGate) await configGate;
        cb?.(result);
        return result;
      },
      async set(data, cb) { Object.assign(storage, clone(data)); cb?.(); },
    } },
    runtime: { onMessage: { addListener: (fn) => { command = fn; } }, sendMessage() {}, lastError: null },
  };
  const timer = (fn, ms) => { if (ms === 0) queueMicrotask(fn); else timers.push({ fn, ms }); return timers.length; };
  for (const src of sources) new Function('window', 'chrome', 'setTimeout', src)(window, chrome, timer);
  return {
    agent: window.__agent, bridge: window.__storeBridge, storage, sdkListeners, makeReady,
    send: (cmd, payload = {}) => command({ type: 'aics-cmd', cmd, payload }),
    async runTimer(ms) {
      for (const task of timers.filter((t) => t.ms === ms)) {
        timers.splice(timers.indexOf(task), 1);
        task.fn();
      }
      await settle();
    },
  };
}

test('首次安装显式应用默认配置，而不是依赖6秒自动启用', async () => {
  const app = boot();
  await settle();
  assert.equal(app.agent.getState().enabled, true);
  assert.equal(app.agent.getState().autoSend, false);
  assert.equal(app.sdkListeners.size, 1);
});

test('持久化禁用状态在启动及延迟重试之后仍保持禁用', async () => {
  const app = boot({ config: { enabled: false, autoSend: true } });
  await settle();
  for (const ms of [1500, 4000, 6000]) await app.runTimer(ms);
  assert.equal(app.agent.getState().enabled, false);
  assert.equal(app.sdkListeners.size, 0);
});

test('配置先到、SDK后到时只在真正就绪后订阅一次', async () => {
  const app = boot({ ready: false, config: { enabled: true, autoSend: true } });
  await settle();
  assert.equal(app.agent.getState().unsubscribe, null);
  assert.equal(app.sdkListeners.size, 0);
  app.makeReady();
  await app.runTimer(800);
  assert.equal(app.sdkListeners.size, 1);
  for (const ms of [1500, 4000]) await app.runTimer(ms);
  assert.equal(app.sdkListeners.size, 1);
});

test('真实 agent→host→ISOLATED 链路保存、恢复并解除无限静音与每日计数', async () => {
  const app = boot({ config: { enabled: true, daily: { date: '2000-01-01', count: 99 } } });
  await settle();
  app.agent.muteConv('synthetic-buyer', Infinity);
  app.agent.resetDaily();
  await settle();
  assert.equal(app.storage.staffMutes['synthetic-buyer'], 'Infinity');
  assert.equal(app.storage.daily.count, 0);
  const restored = boot({ config: app.storage });
  await settle();
  assert.equal(restored.agent.isMuted('synthetic-buyer'), true);
  restored.send('unmute-conv', { conversationId: 'synthetic-buyer' });
  await settle();
  assert.deepEqual(restored.storage.staffMutes, {});
  for (const ms of [1500, 4000]) await restored.runTimer(ms);
  assert.equal(restored.agent.isMuted('synthetic-buyer'), false);
  assert.equal(restored.agent.getState().dailyCount, 0);
});

test('启动配置读取迟到时，不能撤销用户刚下发的禁用命令', async () => {
  let release;
  const configGate = new Promise((resolve) => { release = resolve; });
  const app = boot({ config: { enabled: true, autoSend: true }, configGate });
  app.send('disable');
  await settle();
  release();
  await settle();
  for (const ms of [1500, 4000, 6000]) await app.runTimer(ms);
  assert.equal(app.agent.getState().enabled, false);
  assert.equal(app.sdkListeners.size, 0);
});

test('启动期间点击启用，必须等完整配置恢复后才订阅消息', async () => {
  let release;
  const configGate = new Promise((resolve) => { release = resolve; });
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const app = boot({ configGate, config: {
    enabled: false, provider: 'placeholder', profile: '合成门店口吻', kb: ['合成知识'],
    staffMutes: { C1: 'Infinity' }, daily: { date, count: 7 }, dailyLimit: 9,
  } });
  app.send('enable', { autoSend: true });
  await settle();
  assert.equal(app.sdkListeners.size, 0);
  release();
  await settle();
  assert.equal(app.sdkListeners.size, 1);
  assert.equal(app.agent.getState().enabled, true);
  assert.equal(app.agent.getState().autoSend, true);
  assert.equal(app.agent.getState().provider, 'placeholder');
  assert.deepEqual(app.agent.getState().profile, { tone: '合成门店口吻' });
  assert.deepEqual(app.agent.getState().kb, ['合成知识']);
  assert.equal(app.agent.isMuted('C1'), true);
  assert.equal(app.agent.getState().dailyCount, 7);
  assert.equal(app.agent.getState().dailyLimit, 9);
});

test('启动前解除单个静音和重置计数，不丢其他会话的已存静音', async () => {
  let release;
  const configGate = new Promise((resolve) => { release = resolve; });
  const app = boot({ configGate, config: {
    enabled: true, staffMutes: { C1: 'Infinity', C2: 'Infinity' },
    daily: { date: '2000-01-01', count: 7 },
  } });
  app.send('unmute-conv', { conversationId: 'C1' });
  app.send('reset-daily');
  await settle();
  assert.equal(app.sdkListeners.size, 0);
  release();
  await settle();
  assert.equal(app.agent.isMuted('C1'), false);
  assert.equal(app.agent.isMuted('C2'), true);
  assert.equal(app.agent.getState().dailyCount, 0);
  assert.deepEqual(app.storage.staffMutes, { C2: 'Infinity' });
  assert.equal(app.storage.daily.count, 0);
  assert.equal(app.sdkListeners.size, 1);
});

test('启动读取期间多次保存和开关，最终配置以最新用户操作为准', async () => {
  let release;
  const configGate = new Promise((resolve) => { release = resolve; });
  const app = boot({ configGate, config: { enabled: true, autoSend: true, profile: '旧口吻', staffMutes: { C1: 'Infinity' } } });
  app.send('apply-config', { profile: '新口吻', dailyLimit: 12 });
  app.send('enable', { autoSend: true });
  app.send('disable');
  release();
  await settle();
  assert.equal(app.agent.getState().enabled, false);
  assert.deepEqual(app.agent.getState().profile, { tone: '新口吻' });
  assert.equal(app.agent.getState().dailyLimit, 12);
  assert.equal(app.agent.isMuted('C1'), true);
  assert.equal(app.sdkListeners.size, 0);
});

test('SDK 尚未就绪时的解除静音和重置也必须落盘', async () => {
  const app = boot({ ready: false, config: {
    enabled: true, staffMutes: { C1: 'Infinity', C2: 'Infinity' },
    daily: { date: '2000-01-01', count: 7 },
  } });
  app.send('unmute-conv', { conversationId: 'C1' });
  app.send('reset-daily');
  await settle();
  assert.deepEqual(app.storage.staffMutes, { C2: 'Infinity' });
  assert.equal(app.storage.daily.count, 0);
  assert.equal(app.sdkListeners.size, 0);
  app.makeReady();
  await app.runTimer(800);
  assert.equal(app.sdkListeners.size, 1);
});
