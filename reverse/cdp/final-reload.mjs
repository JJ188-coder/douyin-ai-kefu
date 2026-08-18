// 终版：更新知识库(+3条) + 人设(禁markdown) → 重载扩展 → 刷页 → 冒烟验证
const PORT = process.env.PORT || 9223;
const EXT_ID = 'pioohlmbendoaaoegkgfdbmdddfnnadd';
const KB = [
  '店名：【店铺名称】（示例业态：露营地/游玩项目）',
  '地址：【店铺地址】（示例：有免费停车场）',
  '联系电话：【联系电话】（顾客要电话咨询、预约、投诉都可以给这个号）',
  '营业时间：每天约 9:30-20:00',
  '儿童收费：1.2米以下儿童免费；1.2米及以上按成人收费',
  '宠物：可以带宠物，营地人宠水域分离（宠物有独立区域，不进入客人玩水的水域）',
  '预定规则：除烤全羊套餐外，其他套餐在非节假日都不需要提前预定，到店直接核销使用；节假日建议提前电话确认；烤全羊是现杀的，必须提前致电预约',
  '下雨天：正常接待，场地有遮雨棚保护，不淋雨',
  '营地设施：免费停车场、免费救生衣、免费更衣室',
  '水上项目：溯溪、懒人漂、魔毯、水上玩具',
  '自带食材：可以！选"自带食材"套餐即可，营地提供烧烤炉、炭、烧烤调料、露营椅、户外桌',
  '在售套餐1【暑假特供】野趣溯溪单人套餐 ¥29.9：溯溪+懒人漂+魔毯+水上玩具，含免费停车/救生衣/更衣室',
  '在售套餐2 双人烧烤套餐+门票 ¥198：羊肉串4、牛肉串4、五花肉2、掌中宝2、奥尔良鸡翅2、小甜肠1、热狗肠1、奶香小馒头2、奥尔良鸡皮2、娃娃菜2、花菜2、油豆腐2、香菇2、鱿鱼须1、小黄鱼1；含双人门票+烧烤炉+炭+调料',
  '在售套餐3 四人畅享套餐（含烧烤食材）¥298：羊肉串10、牛肉串10、五花肉6、奥尔良鸡翅2、小甜肠2、热狗肠4、奶香小馒头4、奥尔良鸡皮4、娃娃菜3、花菜3、油豆腐3、香菇2、鱿鱼须1、墨鱼肠2、面包排2、韭菜3、玉米2、年糕3、青椒3、金针菇3；含4人门票+炉具+炭+调料',
  '在售套餐4 四人自带食材畅享 ¥158：4人门票+露营椅4把+户外桌1张+烧烤炉+炭（食材需自带）',
  '在售套餐5 六人自带食材畅享 ¥208：6人门票+露营椅6把+户外桌1张+烧烤炉+炭（食材需自带）',
  '在售套餐6【滨水欢烤】六人烧烤套餐含门票 ¥398：羊肉串15、牛肉串15、五花肉12、奥尔良鸡翅3、牛板筋6、小甜肠2、热狗肠4、奶香小馒头3、面包排3、奥尔良鸡皮5、鱿鱼须1、墨鱼肠2、油豆腐4、香菇3、韭菜3、娃娃菜3、花菜3、水果玉米3、年糕3、青椒3、金针菇3；含6人门票+炉具+炭+调料',
  '在售套餐7 10人好友欢聚套餐（自带食材）¥388：10人门票+露营椅10把+户外桌2张+烧烤炉2个+炭2份',
  '在售套餐8 烤全羊派对团建套餐（15-20人）¥2888：现杀烤全羊1只+铜锅饭+经典烧烤（鸡翅中10、小甜肠5、奶香小馒头5、面包排5、韭菜5、娃娃菜10、花菜5、水果玉米10、年糕10、青椒2、金针菇4）+门票+舞台音响使用+溪景20位露天营位桌椅+烧烤炉2套',
  '套餐里都含门票（门票约69元/人）；顾客问价格/几个人吃，按人数推荐对应套餐',
  '其他没列在这里的信息（如发票、退款细节）不要编，回复"这个我帮您确认一下哦～"或引导致电【联系电话】',
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
const q1 = await evalJs(`window.__llmEngine.decide({ providerName: 'remote', message: { conversationId: 'X', content: '多大的小孩不用钱？' }, history: [{ content: '多大的小孩不用钱？', isFromMe: false, pigeonMsgType: 'text', senderRole: '1' }], kb: window.__agent.getState().kb }).then(d => d && d.reply).catch(e => 'ERR: ' + e.message)`);
console.log('Q1 小孩免费:', JSON.stringify(q1));
const q2 = await evalJs(`window.__llmEngine.decide({ providerName: 'remote', message: { conversationId: 'X', content: '能带狗吗' }, history: [{ content: '能带狗吗', isFromMe: false, pigeonMsgType: 'text', senderRole: '1' }], kb: window.__agent.getState().kb }).then(d => d && d.reply).catch(e => 'ERR: ' + e.message)`);
console.log('Q2 带宠物:', JSON.stringify(q2));
const q3 = await evalJs(`window.__llmEngine.decide({ providerName: 'remote', message: { conversationId: 'X', content: '套餐要提前预定吗' }, history: [{ content: '套餐要提前预定吗', isFromMe: false, pigeonMsgType: 'text', senderRole: '1' }], kb: window.__agent.getState().kb }).then(d => d && d.reply).catch(e => 'ERR: ' + e.message)`);
console.log('Q3 预定:', JSON.stringify(q3));
process.exit(0);
