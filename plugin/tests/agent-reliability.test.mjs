// agent 发送可靠性回归：发送失败回滚 / disable 取消在途 / 静音与日限持久化恢复 / 过期 allocated 不清静音
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../core/agent.js', import.meta.url), 'utf8');

function loadAgent({ bridge, llm }) {
  globalThis.window = { __storeBridge: bridge, __llmEngine: llm };
  eval(src);
  return globalThis.window.__agent;
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
  const today = new Date().toISOString().slice(0, 10);
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
