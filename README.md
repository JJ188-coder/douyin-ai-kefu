# 抖音来客 AI 人工接管助手 — 使用与维护

> 版本：0.3.1（2026-08-19）。买家会话**转人工（allocated_service）后**由 AI 接管自动回复。
> 直接调用页面 IM SDK 收发消息，**不模拟点击、不抓接口、不碰签名**。
> v0.3.1 新增：**人工接管自动静音防抢答** + **AI 答不了的问题通过角标/桌面通知/飞书推送通知店主（popup「待人工处理」列表，可点已处理恢复）**。

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

## 安装 / 启用

1. 打开 `chrome://extensions` → 开发者模式 →「加载已解压的扩展程序」→ 选 `plugin/` 目录。
2. 打开抖音来客客服页 `https://life.douyin.com/cs/web?...`（保持已登录）。
3. 点插件图标打开弹层：
   - 选供应商（DeepSeek 推荐）→ 填模型名 + API Key（Key 只存插件本地，只在后台用，不进页面）
   - 顶部开关打开「自动接管」
   - 默认「自动发送=否（仅预览）」，确认回复自然后再切「是」

## 核心判定（勿随意改）

- **转人工**：消息 `pigeonMsgType === 'allocated_service'`（`originExt.is_allocated_event === '1'`）。这是接管闸门。
- **该回谁**：`isFromMe === false` 的文本消息；`senderRole` 1/3 多为买家（以 `isFromMe` 为主判断）。
- **停止接管**：消息 `type === 'close_conversation'` 或会话 `rawConversation.closed`；收到即 `assigned.delete(convId)`。
- **防回环**：`store-bridge.rememberSent/isSent` 记录本插件发送内容。

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
| 只回真人买家 | ✓ | 平台欢迎语/系统卡片（`role=4`）不回；真人商品卡咨询（`type=card&role=1/3`）正常回 |
| 发送锁+队列 | ✓ | 同一会话同时只跑一个处理流程；锁期间到的消息排队，逐条串行处理，从结构上杜绝并发连发 |
| 输出清洗 | ✓ | 剥掉开头【…】角色标签；`**重点**` 转 “引号”，残余 markdown 符号清除，买家只见纯文本 |
| 灵活推理 | ✓ | 知识库无直接答案时，允许基于多条知识关联+基本商业逻辑做有依据推断（如套餐含某项目→问是否收费答"已包含不另收"）；无依据绝不编造 |
| 答不了→通知店主 | ✓ | AI 兜底话术（帮您确认/核实等）命中 → 该会话自动静音 + 图标红角标 + 桌面通知 + 飞书群推送 + popup「待人工处理」列表；点「已处理」AI 恢复该会话 |
| 对话记录 | ✓ | 买家/AI/人工客服 往来消息（含时间/会话/角色）自动存本地（最多 3000 条）；popup「导出 JSON」下载到下载目录供复盘 |
| 配置持久化 | ✓ | 配置存 `chrome.storage.local`，由 ISOLATED world 的 `host-bridge.js` 在启动时下发（MAIN world 无法访问 chrome.* API）；刷新/重载扩展后自动生效 |

## 上下文与角色区分

- `llm-engine.buildContext(history, classify)`：只取最近 30 条，**丢弃系统/事件消息**（allocated_service、close、user_enter_time）。
- `store-bridge.classifyMessage(msg)` 区分角色：`buyer`（消费者）→ `user`；`staff`（人工客服）/ `aiSelf`（本插件 AI 回的，靠发送记录内容匹配识别）→ `assistant`；`system`（事件型）→ 不喂给模型。
- **不给文本加任何角色前缀**（早期版本加过【消费者】【AI客服(我)】，模型会照抄进回复发给买家，已修）；发送侧也不往 bizExt 打任何标记（平台会据此显示"AI"标识）。
- 模型输出过一道 `stripTag` 清洗：剥掉开头的【…】标签，双保险。

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
node agent-gate.test.mjs        # 门禁 17 项（历史/双推/角色/指纹/锁/人工静音/needsHuman/unmute/关闭重开）
node --test background-chat.test.mjs   # 后台 chat 4 项
node --test host-bridge.test.mjs       # chatlog 落盘去重 3 项
node --test store-bridge.test.mjs      # 人工活动过滤 4 项
```
逆向/联调辅助工具在 `reverse/cdp/`（capture / eval / probe / shot / inject-code），只读参考，不宜改动。

## 安全

- API Key 只存 `chrome.storage.local`，仅在 background service worker 中使用，不注入页面、不写进代码。
- 不做任何对抗性做法：不绕过登录/验证码、不爬接口签名、不外发用户数据。
- 本插件仅在你已登录、已打开的客服页里，代表你本人合法进行自动客服操作。
