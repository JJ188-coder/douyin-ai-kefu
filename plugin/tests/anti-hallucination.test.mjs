// 反幻觉门禁回归自测（node 直跑，mock window）
// 背景：2026-08-19 买家吐槽蚊子，AI 回"给您拿点药膏""送到10号桌"——虚构线下承诺，买家真在等。
// 门禁 = prompt 软约束（反编造铁律）+ 程序硬闸（行动承诺闸 + 事实核对闸，证据排除 AI 自己）。
import { readFileSync } from 'fs';

const engineSrc = readFileSync(new URL('../core/llm-engine.js', import.meta.url), 'utf8');
const realWindow = globalThis.window;
globalThis.window = { location: { origin: 'https://life.douyin.com' } };
eval(engineSrc);
const engine = globalThis.window.__llmEngine;

const KB = [
  '店名：南江·肆意滨水度假营地（露营地/游玩项目）',
  '联系电话：13395895579（顾客要电话咨询、预约、投诉都可以给这个号）',
  '营业时间：每天约 9:30-20:00',
  '烧烤套餐：398元含4人位',
];
const classify = (m) => m.role;
const buyer = (t) => ({ role: 'buyer', content: t, isFromMe: false });
const aiSelf = (t) => ({ role: 'aiSelf', content: t, isFromMe: true });

//  stub 供应商：直接返回指定文本（模拟模型原话）
function stubSays(text, capture) {
  const name = 'stub' + Math.random().toString(36).slice(2, 7);
  engine.registerProvider(name, { chat: async (msgs) => { if (capture) capture.sys = String(msgs[0].content || ''); return text; } });
  return name;
}
async function run(replyText, msg, history = [], kb = KB) {
  const providerName = stubSays(replyText, run._cap || (run._cap = {}));
  return engine.decide({ providerName, message: { conversationId: 'c1', content: msg }, history, profile: {}, kb, classify });
}

let n = 0;
function check(cond, label, extra) {
  n++;
  console.assert(cond, '❌ ' + label + (extra ? ' | ' + extra : ''));
  if (cond) console.log('✅ ' + n + '. ' + label + (extra ? ' | ' + extra : ''));
  else { console.log('❌ FAILED: ' + label, extra || ''); process.exit(1); }
}

// 1) 幻觉事故原样复现：买家吐槽蚊子，模型回"我给您拿点药膏先涂上" → 拦截 + 安抚兜底 + needsHuman
let d = await run('实在抱歉，我给您拿点药膏先涂上，您看方便吗？', '你们这厕所里怎么有这么多蚊子？我被咬了痒死了。', [buyer('你们这厕所里怎么有这么多蚊子？我被咬了痒死了。')]);
check(d.reply === '实在抱歉，您反馈的情况我都记下了，马上反馈给店里负责人核实处理。' && d.needsHuman === true && !!d.blockedBy,
  '幻觉送药膏被拦 + 安抚兜底 + needsHuman', 'reply=' + d.reply);

// 2) "药膏马上给您送到10号桌" → 拦截（10号是买家说的也没用，行动承诺本身就拦）
d = await run('好的，药膏马上给您送到10号桌，您稍等。', '我就坐在这个10号位置等', [buyer('我就坐在这个10号位置等')]);
check(!!d.blockedBy && d.needsHuman === true, '"送到10号桌"被拦', d.blockedBy);

// 3) 有出处的营业时间照答（KB 有 9:30-20:00）→ 放行
d = await run('营业的，每天大概9:30到20:00，您直接来就行。', '现在还营业吗', [buyer('现在还营业吗')]);
check(!d.blockedBy && d.reply.includes('9:30'), '知识库有的时间正常放行', d.reply);

// 4) 知识库没有的价格（烧烤68元一位）→ 拦截
d = await run('烧烤68元一位哦。', '只去烧烤多少钱', [buyer('只去烧烤多少钱')]);
check(!!d.blockedBy && d.needsHuman === true, '编造价格被拦', d.blockedBy);

// 5) 买家自己说的数字（8个人），回复沿用"8位" → 放行（回声不算编造）
d = await run('8位可以直接过来，到了我给您安排。', '那我8个人如何买？', [buyer('那我8个人如何买？')]);
check(!d.blockedBy, '买家回声数字放行', d.reply);

// 6) 金钱让步承诺 → 拦截
d = await run('这样，退您一半钱，您别生气了。', '我要投诉你们', [buyer('我要投诉你们')]);
check(!!d.blockedBy, '退款承诺被拦', d.blockedBy);

// 7) 吐槽安抚的模糊承诺（反馈核实类）→ 放行，不触发行动闸
d = await run('实在抱歉，您反馈的我都记下了，马上反馈给店里核实处理。', '蚊子太多了', [buyer('蚊子太多了')]);
check(!d.blockedBy, '安抚+反馈核实话术放行', d.reply);

// 8) 电话：知识库里的放行；现编的拦截
d = await run('可以打这个电话咨询：13395895579。', '有电话吗', [buyer('有电话吗')]);
check(!d.blockedBy, '知识库电话放行', d.reply);
d = await run('可以打这个电话咨询：13800000000。', '有电话吗', [buyer('有电话吗')]);
check(!!d.blockedBy, '编造电话被拦', d.blockedBy);

// 9) "晚上8点" 与知识库 "20:00" 等价 → 放行（12/24 小时制归一化）
d = await run('晚上8点前过来都可以。', '几点关门', [buyer('几点关门')]);
check(!d.blockedBy, '晚上8点 == 20:00 放行', d.reply);

// 10) 虚构已完成的线下动作 → 拦截
d = await run('已经帮您预留好营位了，直接来就行。', '还有位置吗', [buyer('还有位置吗')]);
check(!!d.blockedBy, '"已帮您预留好"被拦', d.blockedBy);

// 11) AI 自己之前说过的话不算证据（防幻觉自我循环）：历史里 aiSelf 说过 98元，KB 没有、买家没说 → 仍拦截
d = await run('是的，98元一位。', '多少钱一位', [buyer('多少钱一位'), aiSelf('98元一位')]);
check(!!d.blockedBy, 'AI 自说自话不作数，仍拦', d.blockedBy);

// 12) 真人客服说过的话算证据：staff 说过 98元 → 放行
d = await run('98元一位。', '多少钱一位', [buyer('多少钱一位'), { role: 'staff', content: '98元一位', isFromMe: true }]);
check(!d.blockedBy, '真人客服说过的数字可作证据', d.reply);

// 13) 正常寒暄放行且不触发 needsHuman
d = await run('在的，请问有什么可以帮您？', '在吗', [buyer('在吗')]);
check(!d.blockedBy && d.needsHuman === false, '正常寒暄放行', d.reply);

// 14) 反编造铁律已注入 system prompt
const cap = run._cap;
check(!!cap.sys && cap.sys.includes('反编造铁律'), 'system prompt 含反编造铁律');

// ==================== 0.3.9 误杀回归（2026-08-19 晚生产事故）====================
// 15) 全角冒号误杀回归：KB "¥158：4人门票" 里的 158 不能被时间正则啃掉 → 套餐价格放行
const KB2 = [...KB,
  '在售套餐1【暑假特供】野趣溯溪单人套餐 ¥29.9：溯溪+懒人漂+魔毯+水上玩具',
  '在售套餐4 四人自带食材畅享 ¥158：4人门票+露营椅4把+户外桌1张+烧烤炉+炭（食材需自带）',
  '在售套餐7 10人好友欢聚套餐（自带食材）¥388：10人门票'];
d = await run('四位的话推荐四人自带食材畅享套餐，158元，食材您自己带就行。', '我四个人来怎么买票？', [buyer('我四个人来怎么买票？')], KB2);
check(!d.blockedBy, '全角冒号后的价格 158 不被误杀', d.blockedBy || d.reply.slice(0, 30));

// 16) 计算合计放行：388 套餐 + 5×29.9 单人票 = 537.5（"5 张"由 15-10 推出；"537.5"由金额求和推出）
d = await run('10人套餐388元加5张单人票，一共537.5元。', '一共多少', [buyer('15个人来怎么买票'), buyer('大概多少钱'), buyer('一共多少')], KB2);
check(!d.blockedBy, '计算出的合计 537.5 + 补票数 5 放行', d.blockedBy || d.reply.slice(0, 30));

// 17) 但知识库没有也算不出来的现编金额 → 仍拦（37 拼不出；66666 超 2000 元推导上限）
d = await run('一共37元。', '一共多少', [buyer('一共多少')], KB2);
check(!!d.blockedBy, '现编金额 37 仍拦截', d.blockedBy);
d = await run('一共66666元。', '一共多少', [buyer('一共多少')], KB2);
check(!!d.blockedBy, '超大金额 66666 仍拦截', d.blockedBy);

// 18) "一下/一会儿/一起" 等口语词里的"一"不是数字，不能误杀
const KB3 = ['营业时间：每天约 9:30-20:00', '游玩项目时长约2小时'];
d = await run('这个我帮您确认一下，马上回复您。', '水深吗', [buyer('水深吗')], KB3);
check(!d.blockedBy, '"确认一下"不被误杀', d.blockedBy);
d = await run('好的，您一会儿直接过来就行。', '我们现在过去', [buyer('我们现在过去')], KB3);
check(!d.blockedBy, '"一会儿"不被误杀', d.blockedBy);

// 19) 中文数字+单位："两小时" 应匹配知识库 "2小时"
d = await run('全程大概两小时，慢慢玩不着急。', '玩一圈要多久', [buyer('玩一圈要多久')], KB3);
check(!d.blockedBy, '两小时 == 2小时 放行', d.blockedBy || d.reply.slice(0, 30));

// ==================== 转办承诺检测（detectFollowup，2026-08-20）====================
// 命中 = AI 承诺了要人办的事 → 回复照发 + 推店主落实（不静音）
const F = engine.detectFollowup;
check(F('好的，这是您的号码对吧？我记下了，稍后让同事加您VX联系您哦') === true, '识别"让同事加您VX"');
check(F('您这边人数多，我让专员跟您对接，方便加下他的VX吗？号码13395895579') === true, '识别 KB31 团建私域话术');
check(F('好的，我稍后给您回电') === true, '识别"给您回电"');
check(F('实在抱歉，我马上反馈给店里核实处理') === true, '识别"反馈给店里"');
check(F('在的，请问有什么可以帮您？') === false, '寒暄不误报');
check(F('可以打这个电话咨询：13395895579。') === false, '给电话号码不等于承诺回电，不误报');
check(F('营业的，每天9:30到20:00。') === false, '纯事实答复不误报');
// 方向区分（2026-08-20）：店家主动加买家/回电 = 要人落实，报；引导买家自己加 = 无需转办，不报
check(F('建议您加我们VX，就是手机号13395895579，留言我们看到就回') === false, '引导买家自己加 VX 不转办（不刷屏）');
check(F('下午3-5点高峰期电话打不通，您加我们VX更方便') === false, '高峰引导话术不转办');
check(F('我让同事加您VX，您通过一下') === true, '同事去加买家 = 要人落实，照报');

globalThis.window = realWindow;
console.log('ALL PASS');
process.exit(0);
