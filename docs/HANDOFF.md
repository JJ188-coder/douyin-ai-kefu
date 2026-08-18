# 交接记录：已完成（v0.3.1）

> 2026-08-18 更新：**核心 + 全部打磨均已完成并在真实账号验证**。
> 当前插件在 9223 Chrome（`--user-data-dir=reverse/chrome-profile-plug --load-extension=plugin`）持续运行中。
> 新会话/便宜模型如需改动，直接看「可扩展方向」；别改稳定接口签名（见各文件顶部注释）。

## 当前运行状态（真机验证 ✅）

- 引擎：DeepSeek `deepseek-v4-flash`（key 存 chrome.storage，仅 background 使用），autoSend=on
- 门禁：每条消费者新消息开启一轮，轮内最多回 1 条（popup 可调 1-3），下条新消息重置额度
- 防重复三层：只回真人（平台卡片/机器人 role=4 过滤）＋ 内容指纹去重(60s) ＋ 发送锁+队列（同一会话串行处理）
- **人工接管静音 15 分钟**：店主在某会话发消息 → AI 对该会话静音（每发一条刷新计时；popup 可调 0/15/30/60 分钟，0=不静音）；超时无人工活动 AI 自动回来兜底
- **答不了 → 通知店主**：AI 兜底话术（帮您确认/核实等）命中 → 该会话自动静音 + 扩展图标红角标 + 桌面通知 + 飞书群机器人推送 + popup「待人工处理」列表
- 输出清洗：剥【…】角色标签、`**`→“”、清 markdown 符号
- 灵活推理：知识库无直接答案时，按多条知识关联＋商业逻辑做有依据推断；无依据不编造
- 对话保存：买家/AI/人工客服 往来自动存 chrome.storage（chatlog，限 3000 条）；popup「导出 JSON」下载到下载目录
- 事件日志：background 持久化最近 100 条，popup 打开回显历史
- popup 状态显示：读真实 storage + tabs 探测，显示「自动回复已开启 · 自动发送 / 页面已连接」与实际一致
- 知识库：内置通用兜底话术（`core/knowledge.js` 7 条）；店铺专属问答在 popup「知识库」文本框维护（不入仓库），当前 31 条

## 已完成能力（全部真机验证 ✅）

- 转人工（`allocated_service`）判定 → 接管；未关闭会话自动接管
- 收买家消息 → 上下文(角色区分 buyer/aiSelf/staff/system，丢弃事件) → LLM → 真人延迟 → `sendText` 发送
- 免打扰 / 每日上限 / 同会话最小间隔(不足延后不丢) / 会话关闭退出 / 防回环
- 历史重推防护：启动前旧消息不回（防刷新连发）
- **人工接管静音**：`store-bridge` 把店主发的消息作为 `staff-activity` 派发 → `agent.noteStaff` 刷新该会话静音；`isMuted` 门禁在发送前拦截，不抢答
- **needsHuman 上报**：`llm-engine.detectNeedsHuman` 识别兜底话术 → `agent` 自动静音该会话并 emit `needs-human` → `host` 转发 → `background.handleNeedsHuman` 写待处理列表 + 红角标(`action.setBadgeText`) + `notifications.create` 桌面通知 + `feishuSend` webhook 推送
- **待处理列表**：popup 显示 买家原话/AI 回复/时间；「已处理」→ 移除角标并 `unmute-conv` 解除该会话静音（AI 恢复）
- **popup 保存真正下发**：配置经 `background aics-cmd` → `host-bridge` → `host apply-config` 下发到客服台页面（修复原 `window.postMessage` 到不了页面的问题，配置即改即生效）
- popup 面板：总开关/供应商+Key+模型+温度/自动发送/人设/知识库/真人化策略(间隔+每轮条数+静音时长+每日上限+免打扰)/飞书通知/待人工处理/事件日志/对话记录导出/测试接管
- 后台 LLM fetch：OpenAI 兼容，内置 deepseek/openai/moonshot/zhipu/qwen/volc/siliconflow/openrouter，Key 仅存后台
- 配置持久化：ISOLATED host-bridge 读 chrome.storage → 下发 MAIN（MAIN 无法访问 chrome.*）

## 可扩展方向（未做，按需）

- 图片消息识别（当前只回文本；`messageType/image` 需 `sendImageMessage` + 上传）
- 自动定时导出 chatlog（当前手动「导出 JSON」）
- 多账号/多页面 store 连接（当前单页足够）
- 敏感词/风险话术发送前告警（popup 已留 `acceptPreview` 位）
- 打包成正式 .crx 脱离调试端口长期运行（当前依赖 9223 开发者模式）
- 飞书推送支持富文本/卡片（当前为纯文本 text 消息）

## 运维要点（用户需知）

- 保持 9223 Chrome + 客服台页面开着才工作；别登出、别关开发者模式、别移除扩展
- 电脑别长时间深度睡眠（睡眠期间消息不即时回）
- 更新插件代码后必须重载扩展本体（chrome.runtime.reload 或扩展管理页刷新），仅刷页面不够
- **飞书通知**：插件支持两种方式——① 群自定义机器人 webhook（需在**飞书客户端**创建，网页版不支持，填入 popup「飞书通知」）；② 开放平台自建应用 API（App ID/Secret/群 Chat ID，需应用已开通 `im:message` 权限且已在目标群）。未配置时角标+桌面通知仍生效。
- Key / App Secret 只放 chrome.storage；不要提交任何真实密钥到仓库

## 测试

```
cd plugin/tests
node agent-gate.test.mjs        # 门禁 17 项（历史/双推/角色/指纹/锁/人工静音/needsHuman/unmute/关闭重开）
node --test background-chat.test.mjs   # 后台 chat 4 项
node --test host-bridge.test.mjs       # chatlog 落盘去重 3 项
node --test store-bridge.test.mjs      # 人工活动过滤 4 项
```
