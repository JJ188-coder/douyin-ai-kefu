// agent 发送可靠性回归：发送失败回滚 / disable 取消在途 / 静音与日限持久化恢复 / 过期 allocated 不清静音
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../core/agent.js', import.meta.url), 'utf8');

function loadAgent({ bridge, llm, clock = Date, timer = setTimeout }) {
  const window = { __storeBridge: bridge, __llmEngine: llm };
  new Function('window', 'Date', 'setTimeout', src)(window, clock, timer);
  return window.__agent;
}

function makeBridge(overrides = {}) {
  const sentMem = new Set();
  const events = [];
  return Object.assign({
    getChatStore: () => ({ _imSdkStore: { getMessagesByConversation: async () => [] } }),
    sendText: async () => {},
    rememberSent: (conv, content) => { if (content === undefined) { content = conv; conv = ''; } sentMem.add(String(content || '').slice(0, 200)); },
    forgetSent: (conv, content) => { if (content === undefined) { content = conv; conv = ''; } sentMem.delete(String(content || '').slice(0, 200)); },
    isSent: (content) => sentMem.has(String(content || '').slice(0, 200)),
    isConversationLive: () => true,
    classifyMessage: (m) => (m.isFromMe ? 'staff' : 'buyer'),
    startListening: () => () => {},
    emit: (evt, d) => events.push({ evt, d }),
    on: () => {}, off: () => {},
    __events: events,
    __sentMem: sentMem,
  }, overrides);
}

const NOW = Date.now();
const msg = (overrides = {}) => Object.assign({
  clientId: 'T-' + Math.random().toString(36).slice(2, 8),
  content: '在吗', isFromMe: false, senderRole: '1',
  conversationId: 'C1', pigeonMsgType: 'text', timestamp: NOW,
}, overrides);

test('发送失败：rememberSent 回滚、dailyCount 不增加、报 notice', async () => {
  const bridge = makeBridge({
    sendText: async () => { throw new Error('模拟网络失败'); },
  });
  const agent = loadAgent({ bridge, llm: { decide: async () => ({ reply: '在的', delay: 0, needsHuman: false }) } });
  agent.applyConfig({ autoSend: true, enabled: true, minIntervalMs: 1 });
  agent.enable();
  await agent.handleMessage(msg({ clientId: 'F1' }));
  assert.equal(bridge.__sentMem.has('在的'), false);
  assert.equal(agent.getState().dailyCount, 0);
  assert.equal(bridge.__events.some(e => e.evt === 'notice' && /发送失败/.test(e.d.text)), true);
});

test('disable 后：在途流水线到发送前被纪元取消，不再发出', async () => {
  let resolveDecide;
  const decidePromise = new Promise((r) => { resolveDecide = r; });
  const bridge = makeBridge();
  const agent = loadAgent({ bridge, llm: { decide: () => decidePromise } });
  agent.applyConfig({ autoSend: true, enabled: true, minIntervalMs: 1 });
  agent.enable();
  const p = agent.handleMessage(msg({ clientId: 'D1' }));
  await new Promise(r => setTimeout(r, 50));
  agent.disable();
  resolveDecide({ reply: '迟到回复', delay: 0, needsHuman: false });
  await p;
  assert.equal(bridge.__sentMem.has('迟到回复'), false);
});

test('静音与日限持久化恢复：applyConfig 恢复 staffMutes/daily', async () => {
  const bridge = makeBridge();
  const agent = loadAgent({ bridge, llm: { decide: async () => ({ reply: '在的', delay: 0 }) } });
  const today = localDay();
  agent.applyConfig({
    enabled: true, autoSend: true, minIntervalMs: 1,
    staffMutes: { C9: Date.now() + 60000, Cold: Date.now() - 60000 },
    daily: { date: today, count: 7 },
  });
  assert.equal(agent.isMuted('C9'), true);
  assert.equal(agent.isMuted('Cold'), false);
  assert.equal(agent.getState().dailyCount, 7);
});

test('过期 allocated 重放不清静音也不接管', async () => {
  const bridge = makeBridge();
  const agent = loadAgent({ bridge, llm: { decide: async () => ({ reply: '在的', delay: 0 }) } });
  agent.applyConfig({ enabled: true, autoSend: false, minIntervalMs: 1 });
  agent.enable();
  agent.muteConv('C5', 15, '人工接待');
  const before = agent.isMuted('C5');
  agent.markAssigned({ conversationId: 'C5', timestamp: Date.now() - 10 * 60 * 1000 });
  assert.equal(agent.isMuted('C5'), before);
  assert.equal(agent.getState().assigned.has('C5'), false);
});

function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const tick = () => new Promise(setImmediate);
const answer = (reply = '在的', needsHuman = false) => ({ reply, delay: 0, needsHuman });

test('配置禁用/切到预览也取消已进入流水线的发送', async () => {
  for (const patch of [{ enabled: false }, { autoSend: false }]) {
    const decision = deferred();
    const sent = [];
    const bridge = makeBridge({ sendText: async (_, text) => sent.push(text) });
    const agent = loadAgent({ bridge, llm: { decide: () => decision.promise } });
    agent.enable({ autoSend: true });
    const running = agent.handleMessage(msg());
    await tick();
    agent.applyConfig(patch);
    decision.resolve(answer('过期回复', true));
    await running;
    assert.deepEqual(sent, []);
    assert.equal(agent.isMuted('C1'), false);
    assert.equal(bridge.__events.some((e) => e.evt === 'needs-human'), false);
  }
});

test('关闭重开后旧流水线不得发送、释放新锁或拿走新队列', async () => {
  const old = deferred(), fresh = deferred();
  let calls = 0;
  const sent = [];
  const bridge = makeBridge({ sendText: async (_, text) => sent.push(text) });
  const agent = loadAgent({ bridge, llm: { decide: () => ++calls === 1 ? old.promise : calls === 2 ? fresh.promise : Promise.resolve(answer('第三条回复')) } });
  agent.enable({ autoSend: true });
  agent.getState().minIntervalMs = 0;
  const oldRun = agent.handleMessage(msg({ content: '旧问题' }));
  await tick();
  agent.markClosed({ conversationId: 'C1' });
  const newRun = agent.handleMessage(msg({ content: '新问题' }));
  await tick();
  const newLock = agent.getState().sendLock.get('C1');
  await agent.handleMessage(msg({ content: '补充问题' }));
  old.resolve(answer('旧回复'));
  await oldRun;
  assert.deepEqual(sent, []);
  assert.equal(agent.getState().sendLock.get('C1'), newLock);
  assert.equal(agent.getState().pendingMsg.get('C1').length, 1);
  fresh.resolve(answer('新回复'));
  await newRun;
  for (let i = 0; i < 50 && sent.length < 2; i++) await new Promise((r) => setTimeout(r, 2));
  assert.deepEqual(sent, ['新回复', '第三条回复']);
});

test('仅预览或发送失败不产生已承诺转办和无限静音', async () => {
  for (const autoSend of [false, true]) for (const needsHuman of [false, true]) {
    const bridge = makeBridge({ sendText: async () => { throw new Error('合成发送失败'); } });
    const agent = loadAgent({ bridge, llm: { decide: async () => answer('稍后帮您确认', needsHuman), detectFollowup: () => true } });
    agent.enable({ autoSend });
    await agent.handleMessage(msg());
    assert.equal(agent.isMuted('C1'), false);
    assert.equal(agent.getState().dailyCount, 0);
    assert.equal(bridge.__events.some((e) => e.evt === 'needs-human'), false);
  }
});

test('新鲜但重复的 allocated 不清人工静音、不重置集中回复', () => {
  const bridge = makeBridge();
  const agent = loadAgent({ bridge, llm: {} });
  const allocated = { conversationId: 'C1', timestamp: Date.now() };
  agent.markAssigned(allocated);
  agent.getState().handoverByConv.get('C1').consolidated = true;
  agent.muteConv('C1', 15);
  agent.markAssigned(allocated);
  assert.equal(agent.isMuted('C1'), true);
  assert.equal(agent.getState().handoverByConv.get('C1').consolidated, true);
});

test('无限静音经过 JSON 落盘刷新仍有效，解除后不被迟到配置恢复', () => {
  const bridge = makeBridge();
  const agent = loadAgent({ bridge, llm: {} });
  agent.muteConv('C9', Infinity);
  const saved = JSON.parse(JSON.stringify(bridge.__events.findLast((e) => e.evt === 'mute-state').d.mutes));
  const reloadedBridge = makeBridge();
  const reloaded = loadAgent({ bridge: reloadedBridge, llm: {} });
  reloaded.applyConfig({ staffMutes: saved });
  assert.equal(reloaded.isMuted('C9'), true);
  reloaded.unmuteConv('C9');
  assert.deepEqual(reloadedBridge.__events.findLast((e) => e.evt === 'mute-state').d.mutes, {});
  reloaded.applyConfig({ staffMutes: saved });
  assert.equal(reloaded.isMuted('C9'), false);
});

test('每日计数按本地日期跨日清零，迟到配置不覆盖新计数', async () => {
  let now = new Date(2026, 8, 5, 23, 59, 59).getTime();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const bridge = makeBridge();
  const agent = loadAgent({ bridge, clock: Clock, llm: { decide: async () => answer() } });
  agent.applyConfig({ daily: { date: localDay(new Clock()), count: 1 }, dailyLimit: 1 });
  agent.enable({ autoSend: true });
  now += 2000;
  await agent.handleMessage(msg({ timestamp: now }));
  assert.equal(agent.getState().dailyDate, localDay(new Clock()));
  assert.equal(agent.getState().dailyCount, 1);
  assert.equal(bridge.__events.filter((e) => e.evt === 'sent').length, 1);
  agent.applyConfig({ daily: { date: localDay(new Clock()), count: 0 } });
  assert.equal(agent.getState().dailyCount, 1);
  agent.resetDaily();
  assert.equal(bridge.__events.findLast((e) => e.evt === 'daily-state').d.count, 0);
});

test('不同会话并发发送不能共同越过每日上限', async () => {
  const sdk = deferred();
  let attempts = 0;
  const bridge = makeBridge({ sendText: async () => { attempts++; return sdk.promise; } });
  const agent = loadAgent({ bridge, llm: { decide: async () => answer() } });
  agent.enable({ autoSend: true, dailyLimit: 1 });
  const first = agent.handleMessage(msg({ conversationId: 'C1' }));
  const second = agent.handleMessage(msg({ conversationId: 'C2' }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(attempts, 1);
  sdk.resolve();
  await Promise.all([first, second]);
  assert.equal(agent.getState().dailyCount, 1);
  assert.equal(agent.getState().dailyPending, 0);
});

test('节流期间收到后续问题，不丢掉仍未回答的首条问题', async () => {
  const throttle = deferred();
  const asks = [];
  const bridge = makeBridge();
  const timer = (fn, ms) => ms > 0 ? throttle.promise.then(fn) : setTimeout(fn, 0);
  const agent = loadAgent({ bridge, timer, llm: { decide: async ({ message }) => { asks.push(message.content); return answer(); } } });
  agent.enable({ autoSend: true, minIntervalMs: 1000 });
  agent.getState().lastReplyAtByConv.set('C1', Date.now());
  const running = agent.handleMessage(msg({ content: '停车场在哪里' }));
  await agent.handleMessage(msg({ content: '可以带宠物吗' }));
  throttle.resolve();
  await running;
  for (let i = 0; i < 50 && asks.length < 2; i++) await new Promise((r) => setTimeout(r, 2));
  assert.deepEqual(asks, ['停车场在哪里', '可以带宠物吗']);
});

test('上限的最后一个名额发送失败后，等待中的其他会话仍能回复', async () => {
  const gate = deferred();
  const attempts = [];
  const bridge = makeBridge({ sendText: async (conv) => {
    attempts.push(conv);
    if (conv === 'C1') { await gate.promise; throw new Error('首条发送失败'); }
  } });
  const agent = loadAgent({ bridge, llm: { decide: async () => answer() } });
  agent.enable({ autoSend: true, dailyLimit: 1 });
  const first = agent.handleMessage(msg({ conversationId: 'C1' }));
  await new Promise((r) => setTimeout(r, 10));
  const second = agent.handleMessage(msg({ conversationId: 'C2' }));
  await new Promise((r) => setTimeout(r, 10));
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(attempts, ['C1', 'C2']);
  assert.equal(agent.getState().dailyCount, 1);
  assert.equal(agent.getState().dailyPending, 0);
});

test('等待每日名额时禁用或切换预览，等待者退出且不得补发', async () => {
  for (const patch of [{ enabled: false }, { autoSend: false }]) {
    const sdk = deferred();
    const attempts = [];
    const bridge = makeBridge({ sendText: async (conv) => { attempts.push(conv); await sdk.promise; } });
    const agent = loadAgent({ bridge, llm: { decide: async () => answer() } });
    agent.enable({ autoSend: true, dailyLimit: 1 });
    const first = agent.handleMessage(msg({ conversationId: 'C1' }));
    const second = agent.handleMessage(msg({ conversationId: 'C2' }));
    try {
      for (let i = 0; i < 50 && agent.getState().dailyWaiters.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
      assert.equal(agent.getState().dailyWaiters.length, 1);
      agent.applyConfig(patch);
      await second;
      assert.equal(agent.getState().dailyWaiters.length, 0);
      assert.equal(agent.getState().sendLock.has('C2'), false);
    } finally {
      sdk.resolve();
      await Promise.all([first, second]);
    }
    assert.deepEqual(attempts, ['C1']);
    assert.equal(agent.getState().dailyCount, 1);
    assert.equal(agent.getState().dailyPending, 0);
  }
});

test('等待每日名额的会话关闭时立即退出，不依赖其他会话发送结束', async () => {
  const sdk = deferred();
  const bridge = makeBridge({ sendText: () => sdk.promise });
  const agent = loadAgent({ bridge, llm: { decide: async () => answer() } });
  agent.enable({ autoSend: true, dailyLimit: 1 });
  const first = agent.handleMessage(msg({ conversationId: 'C1' }));
  const second = agent.handleMessage(msg({ conversationId: 'C2' }));
  let settled = false;
  second.then(() => { settled = true; });
  try {
    for (let i = 0; i < 50 && agent.getState().dailyWaiters.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    assert.equal(agent.getState().dailyWaiters.length, 1);
    agent.markClosed({ conversationId: 'C2' });
    await tick();
    assert.equal(settled, true);
    assert.equal(agent.getState().dailyWaiters.length, 0);
  } finally {
    sdk.resolve();
    await Promise.all([first, second]);
  }
});

test('关闭重开后旧发送失败，不能清掉新回复的 AI 回显指纹', async () => {
  const oldSend = deferred();
  let attempts = 0;
  const sdk = {
    onMessage: () => () => {},
    getMessagesByConversation: async () => [],
    async sendText() {
      if (++attempts === 1) { await oldSend.promise; throw new Error('旧会话发送失败'); }
    },
  };
  const page = { Garfish: { apps: { cs_web: { global: { _chatStore: {
    _imSdkStore: sdk,
    _conversationStore: { totalContacts: new Map([['C1', { type: 'current' }]]) },
  } } } } } };
  new Function('window', readFileSync(new URL('../core/store-bridge.js', import.meta.url), 'utf8'))(page);
  const bridge = page.__storeBridge;
  const agent = loadAgent({ bridge, llm: { decide: async () => answer('相同回复') } });
  agent.enable({ autoSend: true });
  const first = agent.handleMessage(msg({ content: '旧问题' }));
  try {
    for (let i = 0; i < 50 && attempts === 0; i++) await new Promise((r) => setTimeout(r, 2));
    assert.equal(attempts, 1);
    agent.markClosed({ conversationId: 'C1' });
    await agent.handleMessage(msg({ content: '新问题' }));
    assert.equal(attempts, 2);
  } finally {
    oldSend.resolve();
    await first;
  }
  assert.equal(bridge.classifyMessage({ isFromMe: true, senderRole: '2', content: '相同回复', bizConversationId: 'C1' }), 'aiSelf');
  assert.equal(agent.getState().dailyCount, 1);
});
