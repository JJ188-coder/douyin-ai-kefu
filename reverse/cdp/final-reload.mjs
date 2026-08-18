// 冒烟验证：写入人设 + 内置兜底知识库 → 重载扩展 → 刷页 → 验证输出无 markdown
// 店铺专属知识库不入仓库（在 popup/本地 chrome.storage 维护），此处用插件内置通用话术。
const PORT = process.env.PORT || 9223;
const EXT_ID = 'pioohlmbendoaaoegkgfdbmdddfnnadd';
// 与 plugin/core/knowledge.js 的 BUILTIN 保持一致（内置兜底话术）
const KB = [
  '问：在线吗/能回复吗？答：您好，我在的，有什么可以帮您～',
  '问：什么时候发货？答：亲，下单后 48 小时内安排发货，发货后会第一时间同步物流单号给您。',
  '问：多久能收到？答：一般发出后 1-3 天送达，具体以物流信息为准哈。',
  '问：怎么退款/想退货？答：亲，您可以在订单页面申请售后/退款，或把订单号发我，我帮您查一下处理。',
  '问：还没收到货。答：我帮您查一下物流，如果是运输异常会尽快帮您联系处理，请稍等哈。',
  '问：能优惠吗/能不能便宜点？答：亲，现在这款正好有活动价呢，这个价格已经是很实在的了～',
  '问：有质量问题/bad评论。答：非常抱歉给您带来不好的体验，质量问题我们一定负责到底，您把照片/订单号发我，我尽快帮您处理。',
  '问：可以开发票吗？答：可以开的，下单后把开票信息发我即可。',
];
const PROFILE = '你是这家店的真人客服，在抖音来客上和顾客聊天。铁律：1) 完全像真人打字，一两句话解决，口语化，可以带"～""呀""哦"；2) 禁止编造任何具体信息——数字、政策、价格、时间、地址、电话、优惠，知识库里没有的就老实回答"稍等，我帮您确认一下～"；3) 不提 AI/机器人/自动回复；4) 直接回应对方说的内容，不用客服腔开场白；5) 对方要求转人工时，你就是人工，自然回应"我这边就是人工客服呀，您直接说～"；6) 回复用纯文本：绝对不要用 markdown，不要用 **加粗**、#标题、- 列表这些符号，需要强调就用中文引号“”；7) 回复开头不要带任何【】标签。';
const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const bws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise(r => { bws.onopen = r; });
let mid = 0; const pending = new Map();
bws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const bsend = (m,p={},sid) => new Promise(res=>{const id=++mid;pending.set(id,res);bws.send(JSON.stringify(sid?{id,method:m,params:p,sessionId:sid}:{id,method:m,params:p}));});
const { result: { targetId } } = await bsend('Target.createTarget', { url: `chrome-extension://${EXT_ID}/popup/popup.html`, background: true });
await new Promise(r => setTimeout(r, 1500));
const { result: { sessionId: swSid } } = await bsend('Target.attachToTarget', { targetId, flatten: true });
await bsend('Runtime.evaluate', { expression: `chrome.storage.local.set({ kb: ${JSON.stringify(KB)}, profile: ${JSON.stringify(PROFILE)} })`, awaitPromise: true, returnByValue: true }, swSid);
console.log('kb+profile stored');
await bsend('Runtime.evaluate', { expression: 'chrome.runtime.reload()' }, swSid);
console.log('extension reloaded');
await new Promise(r => setTimeout(r, 2500));
await bsend('Target.closeTarget', { targetId }).catch(()=>{});
bws.close();

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes('life.douyin.com/cs'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
mid = 0; pending.clear();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m,p={}) => new Promise(res=>{const id=++mid;pending.set(id,res);ws.send(JSON.stringify({id,method:m,params:p}));});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});
  return r.result?.exceptionDetails ? { EXC: (r.result.exceptionDetails.exception?.description||r.result.exceptionDetails.text||'').slice(0,400) } : r.result?.result?.value;
};
await new Promise(r => { ws.onopen = r; });
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
let ok = false;
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 2000));
  if (await evalJs('!!(window.__agent && window.__llmEngine && window.__storeBridge && window.__storeBridge.getChatStore())') === true) { ok = true; break; }
}
if (!ok) { console.log('PAGE_NOT_READY'); process.exit(1); }
await new Promise(r => setTimeout(r, 7000));
const st = await evalJs(`(() => { const s = window.__agent.getState(); return { enabled: s.enabled, autoSend: s.autoSend, provider: s.provider, listening: !!s.unsubscribe, kbLines: (s.kb||[]).length, hasProfile: !!s.profile }; })()`);
console.log('state:', JSON.stringify(st));
// 冒烟1：带 markdown 倾向的问题 → 验证输出无 **
const q1 = await evalJs(`window.__llmEngine.decide({ providerName: 'remote', message: { conversationId: 'X', content: '什么时候发货？' }, history: [{ content: '什么时候发货？', isFromMe: false, pigeonMsgType: 'text', senderRole: '1' }], kb: window.__agent.getState().kb }).then(d => d && d.reply).catch(e => 'ERR: ' + e.message)`);
console.log('Q1 发货:', JSON.stringify(q1));
const q2 = await evalJs(`window.__llmEngine.decide({ providerName: 'remote', message: { conversationId: 'X', content: '能开发票吗' }, history: [{ content: '能开发票吗', isFromMe: false, pigeonMsgType: 'text', senderRole: '1' }], kb: window.__agent.getState().kb }).then(d => d && d.reply).catch(e => 'ERR: ' + e.message)`);
console.log('Q2 发票:', JSON.stringify(q2));
const q3 = await evalJs(`window.__llmEngine.decide({ providerName: 'remote', message: { conversationId: 'X', content: '怎么退款' }, history: [{ content: '怎么退款', isFromMe: false, pigeonMsgType: 'text', senderRole: '1' }], kb: window.__agent.getState().kb }).then(d => d && d.reply).catch(e => 'ERR: ' + e.message)`);
console.log('Q3 退款:', JSON.stringify(q3));
process.exit(0);
