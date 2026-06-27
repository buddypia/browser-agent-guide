# Browser Agent Guide 🧭 — 确定性页面智能体（Chrome 扩展）

> 让操作浏览器的 AI 不偏离轨道的护栏与指南。

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · **中文**

---

**Browser Agent Guide** 是一款 Chrome（Manifest V3）扩展，让**非工程师**也能**仅通过点击**，
在任意网页上添加备注，以及**绘制（用圆/方框/箭头/自由笔围住某个元素）**——
从而让操作浏览器的 AI（本扩展的聊天，或外部 AI 聊天界面）理解页面上下文并确定性地运行。
（标记与提示按钮仍然存在，但由 AI 通过动词注册表添加，而非点击表单。）

标注会**按页面（origin + path）持久化**，并在**每次访问时复原到相同位置**（可复现性）；
每个目标元素都通过**多信号的稳健锚点**（稳定 ID 路径、`data-testid`、`name`、`aria-label`、文本匹配）
重新解析，因此*每次都能找到同一个元素*（确定性）。**复制上下文**按钮可导出确定性的页面描述，
粘贴到外部 AI 聊天中。

你也可以在侧边栏聊天里直接指挥 AI（Structured Outputs），但 AI 只能使用一个
**封闭、确定的动词注册表**（`clickAffordance`、`fillAffordance`、`markElement`、`addNote` …）。
结合**稳定的元素 ID**与 **Structured Outputs**，*相同的提示词会产生相同的操作*。

> 术语：“添加备注”的操作在内部以**标注（annotation）**的形式保存。
> 点击添加的是 **💬备注（给 AI 的指示）** 与 **🖍绘制（用圆/方框/箭头/笔围住元素）**。
> **📌标记（为元素赋予确定性名称）** / **🔘提示按钮** 是由 AI 添加的种类。

## 演示 / Demo

浏览器操作 AI 在亚马逊（Amazon）上搜索特定商品并将其加入购物车的演示视频：

<p align="center">
  <video src="docs/media/browser-automation1_compressed.mp4" width="100%" controls></video>
  <br>
  <a href="docs/media/browser-automation1_compressed.mp4">🎥 直接观看演示视频 (docs/media/browser-automation1_compressed.mp4)</a>
</p>

## 为什么需要护栏

| 目标 | Browser Agent Guide 的实现 |
| --- | --- |
| AI 集成 + Structured Outputs | service worker 以严格的 JSON Schema（`reply` + `actions`）调用 AI |
| 保存 API 密钥 | 仅保存在 `chrome.storage.local`，在选项页设置 |
| 按需记忆页面 | 在保存标注或聊天驱动的页面更改后自动添加规则；注入记忆可针对当前 URL、当前域名或所有站点，规则仍可手动编辑 |
| 从侧边栏植入辅助 UI | AI 可使用安全的动词注册表操作；显式请求的 HTML / CSS / JS 注入可保存为可重放配方 |
| 确定且一致的操作 | AI 只能使用已注册的动词；元素获得稳定的 `aiId`；配方在每次加载时重放 |

AI 绝不会即兴发起原始 DOM 调用，而是从**动词注册表**中选择，因此行为可预测：
*相同指令 → 相同动词 → 相同结果*。
页面文本与 HTML 属性被视为不可信数据。`setStyle`、`removeElement`、`defineMarker` 等高风险 DOM
变更动词对聊天 AI 隐藏，并在聊天 / 自动配方执行路径中被拒绝。`injectHtml`、`injectCss`、
`injectScript` 仅用于用户显式请求的页面添加，成功后保存为可重放配方。`injectScript` 通过 Chrome
的 User Scripts API 运行，因此不依赖页面的内联脚本 CSP。

## 安装（加载已解压扩展）

1. 打开 `chrome://extensions`
2. 打开**开发者模式**
3. **加载已解压的扩展程序** → 选择本文件夹
4. 点击工具栏图标打开侧边栏

> 需要 Chrome 135+（Side Panel API + User Scripts API）。
> 在 Chrome 138+ 上使用 `injectScript` 前，请在扩展详情页启用 **Allow User Scripts**。

## 初始设置

1. 右键点击图标 → **选项**（或侧边栏的**设置**按钮）
2. **① AI 连接** — 选择提供方（OpenAI / Anthropic / Gemini / OpenAI 兼容的自定义），粘贴 API 密钥与模型并保存
   - OpenAI 兼容：使用 `response_format: json_schema` 且 `strict: true`
   - Anthropic：通过 `tool_choice` 强制结构化输出
   - Gemini：使用 `generationConfig.responseMimeType: "application/json"` 与 `responseJsonSchema`
3. 在 **② AI 注入自动保存** 中决定注入的 HTML / CSS / JS 保存到当前 URL、当前域名还是所有站点
4. 保存标注或让聊天更改页面后，Browser Agent Guide 会自动记住该范围
5. 可按需编辑 **③ 已记忆的 URL / 激活规则** 与 **④ 记忆规则**（每次页面加载时重放的动词）

## 用法

打开任意页面，在侧边栏聊天中输入自然语言指令：

- “找到登录按钮并高亮它”
- “在右下角植入一个*摘要*按钮；它的用途是请 AI 总结本页”
- “在搜索框输入 *Chrome 扩展* 并提交”
- “在本页注入一条固定提示，并在下次继续显示”
- “为该域名注入 CSS，让标题更易于扫读”

AI 会返回结构化的 `reply`（说明）与 `actions`（动词），并按顺序执行。每个动词的结果会在聊天中
内联显示。当标注保存或聊天驱动的页面更改成功时，所选的 URL / 域名 / 所有站点范围以及任何持久的
重放规则都会被自动记住。`outlineElement` 等已保存的视觉更改会在刷新后重放。要撤销它们，请在设置中
删除对应的已记忆 URL 或记忆规则，然后刷新页面。

工具栏：
- **留下线索**：**添加批注**（点击元素以附加 1 条面向 AI 的备注；目标会被红框框住）和 **绘制**（用圆/方框/箭头/笔标注目标并附上评论）。
- **教给AI**：**复制给AI** 会把 URL、标题、已保存线索和可操作元素整理成可粘贴到其他 AI 聊天中的文本。有绘制时，**以图片发给AI** 可以把视觉线索也传过去。
- **查看页面**：**查看元素** 会列出当前可操作元素。
- **历史** 可复用已发送的提示词，也可在输入框边缘用 ↑/↓。**设置** 可打开 AI 连接、已记忆 URL 和重访规则。

侧边栏还会显示当前操作目标 Chrome 标签页（`tabId` / `windowId` / 标签页位置）。视觉反馈截图会把同一份标签页信息保存到 `annotation.json` / `memo.md`，并通过 daemon MCP context 暴露出来；如果同一个 URL 在多个标签页中打开，可在 MCP 工具中传入 `tabId`（或 `windowId`）来区分。

### 绘制（用圆/方框/箭头/笔围住元素）

按 **🖍 お描き/绘制** 进入绘制模式，在页面上勾画（◯圆 / ▭方框 / ↗箭头 / ✎笔 + 颜色），
然后按**完成**附上 1 条面向 AI 的指示。每个绘制都**锚定到它所围住的元素**；坐标以**元素框的比例**
保存，因此绘制会跟随元素，并在**重新访问、滚动和重排时复原到相同位置**。AI 收到的是平实的文字描述
（例如*“用红色圆圈住。评论：…”*），因此“看这里 / 修复这个圈住的部分”等指令能精确落位。已保存的
绘制可在“此页面的线索”列表中编辑或删除。

## 动词注册表（节选）

在 `content/content-script.js` 中以 `AI_VERBS` 实现。每个函数名都是一个动词。

| 动词 | 用途 |
| --- | --- |
| `annotatePage` / `listAffordances` | 分配稳定 ID / 列出可交互元素 |
| `clickAffordance` / `clickElement` | 点击 |
| `fillAffordance` / `fillInput` / `selectOption` | 填写 / 选择 |
| `submitForm` / `focusElement` / `scrollToElement` | 提交 / 聚焦 / 滚动 |
| `highlightElement` / `outlineElement` | 临时高亮 / 持久边框 |
| `injectHtml` / `injectCss` / `injectScript` | 注入显式的 HTML / CSS / JS 并在重访时重放 |
| `injectButton` / `injectPanel` | 植入提示按钮与净化后的面板 |
| `waitForElement` | 等待元素 |
| `navigateTo` / `goBack` / `notify` | 跳转 / 提示气泡 |
| `readText` / `extractData` / `readSignals` | 读取 / 抽取 / 读取用户信号 |
| `startAnnotating` / `startDrawing` | 启动点击标注 / 绘制（圆·方框·箭头·笔）模式 |

### 可供性与人机协作

`annotatePage` 按文档顺序分配**确定性的 `aiId`**（`button#1`、`input-text#2`、…）。
AI 通过 `clickAffordance({aiId})` 引用这些 ID，因此不会因猜测选择器而漂移。

用 `injectButton` 植入的按钮带有中性的 DOM 属性（如 `data-bag-intent`），点击后会记录一个可由
`readSignals` 读取的**信号**。这就闭合了循环：*人点击植入的按钮 → AI 读取意图并继续任务*。

## 架构

```
sidepanel（聊天 UI）
   │  CHAT {text, history, tabId}
   ▼
background（service worker）
   │  ① COLLECT_CONTEXT → content（收集动词目录 + 可供性）
   │  ② callAI（Structured Outputs → reply + actions）
   │  ③ RUN_ACTIONS → content（按顺序执行动词）
   ▼
content-script（页面内 / 动词注册表 + 执行器）
```

- `lib/ai-client.js` — 与提供方无关的 Structured Outputs 调用
- `lib/prompt.js` — 携带动词目录 + 可供性的系统提示
- `lib/site-matcher.js` — URL / 域名 / 正则匹配
- `lib/storage.js` — 设置持久化

`tabId` 是当前 Chrome 会话中的实时操作目标。视觉反馈还会保存 `{tabId, windowId, index, active}`。它不是持久的浏览器历史 ID，但适合用来区分当前打开的同 URL 多标签页。

## 安全 / 隐私

- API 密钥仅保存在 `chrome.storage.local`，且只发送给你选择的 AI API。
- 提示词历史与按页面划分的聊天历史也保存在 `chrome.storage.local`。
- 破坏性 / 不可逆的操作（提交、购买、删除）会在执行前于 `reply` 中说明。
- 已记录工作流的自动执行默认会保留看似最终确认/购买/删除的点击；可在 Options 中明确选择信任已记录步骤并允许执行。
- 动词注册表是封闭集合，因此 AI 无法执行预期之外的 DOM 操作。

## 扩展

在 `content/content-script.js` 的 `AI_VERBS` 中追加一个 `{ description, args, run }` 条目即可新增动词。
其 `description` 与 `args` 会自动流入系统提示与 Structured Outputs 模式（`verb` 枚举）。

## 技术

无构建步骤的原生 JavaScript。Manifest V3、Side Panel API、`chrome.scripting`、`chrome.storage`。

## 质量关卡

打包前运行 `npm run check`。它会运行 JavaScript 语法检查、确定性锚点测试，以及针对侧边栏和选项页的
Playwright + axe UI 检查。

所采用的 anti-slop 工作流记录在 [docs/ui-quality-workflow.md](docs/ui-quality-workflow.md)。

## 许可证

[MIT](LICENSE)
