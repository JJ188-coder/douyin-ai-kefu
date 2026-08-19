# 抖音来客 AI 人工接管助手 — 使用与维护

> 版本：0.3.5（2026-08-19）。买家会话**转人工（allocated_service）后**由 AI 接管自动回复。
> 直接调用页面 IM SDK 收发消息，**不模拟点击、不抓接口、不碰签名**。
> 近期变更：修复 AI 回复 30 分钟后被 SDK 重推（已读回执/重连）误判成人工发言导致误静音漏回买家的问题——发送记录取消 30 分钟过期改为容量上限，回执到达时学习 clientId 永久免疫重推（v0.3.5）；平台智能客服（senderRole=4）独立识别，不再误判人工接管（v0.3.4）；会话门禁按买家 ID 归一化，多人同时咨询各回各的、互不排队（v0.3.3）；LLM 请求带编号防并发串台 + 45s 超时自动重试一次，失败记事件日志不静默丢消息（v0.3.2）；人工接管自动静音防抢答 + AI 答不了通知店主（v0.3.1）。

## 目录结构

```
plugin/
  manifest.json           MV3：MAIN world(6 js) + ISOLATED world(host-bridge) + background + popup
  background.js           后台 service worker：OpenAI 兼容多供应商 LLM fetch + 配置中转
  host-bridge.js          ISOLATED：MAIN ⇄ background/popup 桥
  content.js              MAIN world 启动入口（应用持久化配置）
  popup/popup.html/.js    弹层：开关/模型/Key/人设/知识库/真人化策略/事件日志
  core/
    store-bridge.js       页面 IM SDK 桥（sendText/onMessage/转人工判定/防回环/事件总线）
    llm-engine.js         AI 引擎：远程(走 background) 或占位
    knowledge.js          内置知识库话术模板
    agent.js              大脑：接管/免打扰/每日上限/最小间隔/上下文/关闭会话
    host.js               MAIN 内桥：收 ISOLATED 命令 + 回推状态事件
  tests/                  background chat 单测
```

## 为什么不模拟点击（与传统 RPA 方案对比）

传统方案是"装作人"去操作界面：找会话列表 → 点进会话 → 聚焦输入框 → 打字 → 点发送。本插件不碰界面，直接调用客服台页面自己的 IM SDK（`sendText(bizType, convId, content)`），收发都走页面内部通道。

| | 本插件（调页面 SDK） | 传统模拟点击（RPA） |
|---|---|---|
| **多会话并发** | 可以。每条消息带 convId 定向收发，纯异步函数调用，几十个会话同页并行互不干扰；瓶颈只在大模型 API | 基本不行。一个界面只有一套鼠标/焦点/输入框，操作天然串行；想并行只能多开浏览器，同一客服账号多开会话互踢，不可靠 |
| **回错人风险** | 结构上免疫：回复按 convId 定向发送，不存在"输入框内容发错会话" | 高发：打字打到一半新消息进来、界面自动跳会话，输入框里的内容就发给了别人 |
| **窗口状态** | 后台标签页/最小化/锁屏都能跑（实测 Mac 锁屏过夜照常接客） | 多数要求窗口可见可聚焦，锁屏/切窗口就废 |
| **资源占用** | 可忽略（几个 Map + 异步调用） | 每个实例一个完整渲染中的浏览器，CPU/内存成倍 |
| **维护成本** | 不依赖 DOM 选择器，平台改 UI 不伤筋骨（只依赖页面内部 store/SDK 接口） | 平台一改版，选择器全废 |
| **回复节奏** | 真人感延迟是可调的参数（1.2–4.5s 随机），想快能快 | 快不了，打字/点击动画是硬约束 |

模拟点击唯一的优点是"什么页面都能点、不依赖内部接口"。但客服是高频多会话场景，接口方案在并发、准确性、稳定性上全面占优。

## 安装 / 启用

1. 打开 `chrome://extensions` → 开发者模式 →「加载已解压的扩展程序」→ 选 `plugin/` 目录。
2. 打开抖音来客客服页 `https://life.douyin.com/cs/web?...`（保持已登录）。
3. 点插件图标打开弹层：
   - 选供应商（DeepSeek 推荐）→ 填模型名 + API Key（Key 只存插件本地，只在后台用，不进页面）
   - 顶部开关打开「自动接管」
   - 默认「自动发送=否（仅预览）」，确认回复自然后再切「是」

## 核心判定（勿随意改）

- **转人工**：消息 `pigeonMsgType === 'allocated_service'`（`originExt.is_allocated_event === '1'`）。这是接管闸门。
- **五类角色（store-bridge.classifyMessage）**：`buyer`=买家（isFromMe=false 且 role 1/3）；`staff`=真人客服（isFromMe=true、role≠4、内容不在本插件发送记录）；`aiSelf`=本插件 AI（内容命中发送记录）；`platformAi`=平台智能客服/系统通知（senderRole=4，**不触发人工静音**）；`system`=事件型（allocated/close/user_enter_time）。只回 buyer。
- **会话归一化 convKey**：convId 实测结构 `买家ID:店铺ID:接待组ID`（买家消息的 sender_id 与第一段一致；店铺/接待组是全店共用常量），另有四段格式 `0:1:接待组ID:买家ID`。锁/指纹/回合/静音等门禁全部按买家 ID 归一化；发送和拉历史用原始 convId。
- **停止接管**：消息 `type === 'close_conversation'` 或会话 `rawConversation.closed`；收到即清理该买家全部会话状态（含静音，重开不遗传）。
- **防回环**：`store-bridge.rememberSent/isSent` 记录本插件发送内容（先登记再发送，SDK 同步回推不误判人工）。

## 真人化策略（agent.js state）

| 项 | 缺省 | 说明 |
|---|---|---|
| `minIntervalMs` | 15000 | 同一会话两次 AI 回复的最小间隔（不足则延后发送，不丢回复） |
| `dailyLimit` | 200 | 每日自动回复条数上限 |
| `maxRepliesPerConv` | 1 | **回合制门禁：每条消费者新消息开启一个回合，回合内最多连回 N 条；消费者再发新消息即开启新回合（额度重置）** |
| `staffMuteMinutes` | 15 | **人工接管静音：店主在某会话发消息 → AI 对该会话静音 N 分钟（每发一条刷新计时）；0=不静音** |
| `quietEnabled/From/To` | 关 | 免打扰时段（跨天支持） |
| 延迟 | 1.2–4.5s 随机 | `llm-engine.humanDelay`，营造真人节奏 |
| 等消费者回复才回 | ✓ | 仅对「消费者新消息」消耗下一条预算；自己回复后不追发 |
| clientId 去重 | ✓ | `onMessage`/`onMessageUpsert` 同一条消息不会重复回复 |
| 历史重推防护 | ✓ | 插件启动前的旧消息（刷新/重连后 SDK 会重推）一律不回，防连发 |
| 只回真人买家 | ✓ | 平台欢迎语/系统卡片/平台智能客服（`role=4`）不回；真人商品卡咨询（`type=card&role=1/3`）正常回 |
| 发送锁+队列 | ✓ | 同一买家同时只跑一个处理流程；锁期间到的消息排队，逐条串行处理，从结构上杜绝并发连发 |
| 跨买家隔离 | ✓ | 锁/指纹/回合/静音全部按买家 ID 隔离：多人同时咨询各回各的，不互相排队、同内容不互相误杀 |
| 并发防串台 | ✓ | LLM 请求带 reqId，并发会话各认各的回复（不会把答 A 的内容发给 B）；45s 超时 + 自动重试一次；重试仍失败记事件日志（popup 可见），不静默丢消息 |
| 输出清洗 | ✓ | 剥掉开头【…】角色标签；`**重点**` 转 “引号”，残余 markdown 符号清除，买家只见纯文本 |
| 灵活推理 | ✓ | 知识库无直接答案时，允许基于多条知识关联+基本商业逻辑做有依据推断（如套餐含某项目→问是否收费答"已包含不另收"）；无依据绝不编造 |
| 答不了→通知店主 | ✓ | AI 兜底话术（帮您确认/核实等）命中 → 该会话自动静音 + 图标红角标 + 桌面通知 + 飞书群推送 + popup「待人工处理」列表；点「已处理」AI 恢复该会话 |
| 对话记录 | ✓ | 买家/AI/人工客服 往来消息（含时间/会话/角色）自动存本地（最多 3000 条）；popup「导出 JSON」下载到下载目录供复盘 |
| 配置持久化 | ✓ | 配置存 `chrome.storage.local`，由 ISOLATED world 的 `host-bridge.js` 在启动时下发（MAIN world 无法访问 chrome.* API）；刷新/重载扩展后自动生效 |

## 上下文与角色区分

- `llm-engine.buildContext(history, classify)`：只取最近 30 条，**丢弃系统/事件消息**（allocated_service、close、user_enter_time）。
- 五类角色进模型的方式：`buyer` → `user`；`staff`（真人客服）/ `aiSelf`（本插件 AI）/ `platformAi`（平台智能客服）→ `assistant`（平台 AI 的回答买家确实看过，保留为店家侧上下文，但它不触发人工接管静音）；`system` → 不喂给模型。
- **不给文本加任何角色前缀**（早期版本加过【消费者】【AI客服(我)】，模型会照抄进回复发给买家，已修）；发送侧也不往 bizExt 打任何标记（平台会据此显示"AI"标识）。
- 模型输出过一道 `stripTag` 清洗：剥掉开头的【…】标签，双保险。
- popup 保存的人设是纯文本，`applyConfig` 会包装成 `{tone}` 再进 prompt（v0.3.2 修复：直接进 state 会被 Object.assign 打散成字符、人设静默丢失）。

## 供应商接入（background.js PROVIDER_BASE）

已内置：openai / deepseek / moonshot(Kimi) / zhipu / qwen(通义) / volc(火山方舟) / siliconflow / openrouter 的 OpenAI 兼容 base。填 Key + 模型名即用；自定义另立 provider 在 `background.js` 里的 `PROVIDER_BASE` 加一行即可。

## 飞书通知（可选）

AI 答不了买家问题时，可推送提醒到飞书群。插件支持两种方式（任选其一，填到插件弹层「飞书通知」后点「发测试」验证）：

**方式一：群自定义机器人 webhook（推荐，最简单）**
在**飞书客户端**（手机/桌面，网页版不支持）打开目标群 → 群设置 → 群机器人 → 添加机器人 → 自定义机器人，创建后复制 `https://open.feishu.cn/open-apis/bot/v2/hook/…` 填入插件。安全设置建议选「自定义关键词」，填：`抖音客服`。

**方式二：开放平台自建应用 API（网页端拿不到 webhook 时的备用）**
- 需要一个已发布、已开通 `im:message` 权限、且**已被添加进目标群**的自建应用（如「您的自建应用」）。
- 在插件「飞书通知 → 开放平台应用 API」填：App ID、App Secret、群 Chat ID（`oc_xxx`）。

未配置飞书时不影响其他通知（图标角标 / 桌面通知 / popup 待处理列表仍生效）。

## 测试

```
cd plugin/tests
node agent-gate.test.mjs               # 门禁 21 项（历史/双推/角色/指纹/锁/人工静音/needsHuman/关闭重开/跨买家隔离/两种 convId 格式分叉/人设包装）
node --test background-chat.test.mjs   # 后台 chat 4 项
node host-bridge.test.mjs              # chatlog 落盘去重 3 项
node store-bridge.test.mjs             # 人工活动过滤 + 角色分类 8 项
node llm-correlation.test.mjs          # LLM 并发防串台 + 失败重试 4 项
```
逆向/联调辅助工具在 `reverse/cdp/`（capture / eval / probe / shot / inject-code），只读参考，不宜改动。

## 运行与运维

- **专用 Chrome 实例**：插件跑在独立 Chrome（`--remote-debugging-port=9223 --user-data-dir=reverse/chrome-profile-plug`）里，和日常浏览器互不影响。
- **开机自启**：`~/Library/LaunchAgents/com.douyin.aics-chrome.plist`（RunAtLoad + 异常退出自动拉起）；需系统设置开「自动登录」才能重启后无人值守。卸载：`launchctl bootout gui/$(id -u) com.douyin.aics-chrome` 后删该 plist。
- **改代码后上线**：`cd plugin && PORT=9223 node reload-ext.mjs`（重载扩展 + 刷客服台页 + 打印状态；只读配置，不覆盖线上）。
- **客服台提示音**：插件本身不发声；客服台自己的提示音用 Chrome 右键标签页「将此网站静音」关掉。需要人工介入的问题走飞书手机推送。
- **日志/对话记录**：事件与 chatlog 存 `chrome.storage.local`（chatlog 最多 3000 条，角色分 buyer/ai/staff/platform）；popup 可导出 JSON 复盘。

## 安全

- API Key 只存 `chrome.storage.local`，仅在 background service worker 中使用，不注入页面、不写进代码。
- 不做任何对抗性做法：不绕过登录/验证码、不爬接口签名、不外发用户数据。
- 本插件仅在你已登录、已打开的客服页里，代表你本人合法进行自动客服操作。
