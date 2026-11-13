# 在 workbuddy（以及任意 MCP 客户端）里使用 dsh-novel-writer

本文记录把本插件以 **stdio MCP 服务器**形态接入 MCP 客户端（示例为 workbuddy，Claude Desktop / Cursor 同理）的完整流程，以及在非 DSH 宿主下**哪些能力仍然成立、哪些会失效**。

两种形态可以并存：它们读写同一套文件（`<书库根>/novels/*.md` 与 `<书库根>/.novel-writer/`），不存在数据迁移问题。

---

## 1. 先明确能力边界

插件全部业务逻辑在 Node 侧（`lib/*.js`），与宿主只有 6 个接触面，其中**只有 `ctx.tools.register` 是必需的**：

| 宿主接触面 | 位置 | 必需 | 非 DSH 宿主（MCP）下的表现 |
|---|---|---|---|
| `ctx.tools.register` | `lib/index.js` | **是** | `mcp/server.mjs` 的 stub 已实现，22 个工具全部可用 |
| `ctx.systemPrompt.section` | `lib/index.js` ×3 | 否 | **不注入**工作流提示词 → 需用客户端技能文件补（见 §4） |
| `ctx.inject(["webServer"])` | `lib/index.js` | 否 | 5 个 `/api/dsh-novel-writer/*` 面板路由无人消费，**工具本身不受影响** |
| `ctx.inject(["skills"])` | `lib/index.js` | 否 | 内置技能不自动注册 → 需手工安装（见 §4） |
| `ctx.on("llm/stream")` | `lib/index.js` | 否 | **「非净化模式」的软化重试兜底失效**（见 §6） |
| `ctx.slots.inject` + `sidebar.panellist` / `main` | `lib/client.js` | 否 | **面板 UI 不出现**（`client.js` 根本不会被加载） |

因此：

| 能力 | MCP 客户端 | DSH 插件 |
|---|---|---|
| 22 个 `novel_*` 工具 | ✅ | ✅ |
| 本地语义检索 / 情感分析（0 token，正文不出本机） | ✅ | ✅ |
| 开写包、改稿台、结构视图、伏笔表、设定表、用词审计 | ✅ | ✅ |
| 右侧栏面板、开关页、诊断页、草稿镜像预览 | ❌ | ✅ |
| 工作流提示词自动注入 | ❌（用技能文件补） | ✅ |
| 非净化模式的流层兜底重试 | ❌ | ✅ |

工具返回的是**纯文本**（`mcp/server.mjs` 的 `renderToolText`），用 `<path>` / `<type>` / `<content>` 包裹，客户端里看到的是文本报告，不是图形面板。

> Node 侧没有任何 `@deepseek-ai/*` 依赖；唯一的宿主包引用在 `lib/client.js:89`，且在 `try/catch` 内、取不到即自绘回退。

---

## 2. 前置条件

- **Node ≥ 22.3**（`package.json` 的 `engines`）。本文实测环境 Node 24.19.0，可正常跑本地 ONNX 推理。
- 磁盘：仓库 + `node_modules` 约 100 MB（含 24 MB 的中文向量模型，随包分发）。
- 网络：仅首次 `npm ci` 需要；运行期除 `lib/update-check.js` 的版本检查外不联网（可用开关关闭）。

---

## 3. 安装

### 3.1 取代码并装依赖

```bash
git clone https://github.com/<你的 fork>/dsh-novel-writer.git
cd dsh-novel-writer
npm ci
```

**`npm ci` 不能跳过。** 跳过时工具能加载、22 个工具也能列出，但语义检索会**静默降级**为纯规则模式：

```text
《书名》语义检索「…」（不可用）
语义引擎不可用：Error [ERR_MODULE_NOT_FOUND]: Cannot find package
'@huggingface/tokenizers' imported from .../lib/embedding.js。
插件已回退纯规则模式，不影响其他功能。
```

### 3.2 建书库

书库根下必须是 `novels/` 子目录，每章一个 Markdown 文件：

```text
<书库根>/
├── novels/
│   └── 我的小说/
│       ├── 第01章.md
│       └── 第02章.md
└── .novel-writer/        # 插件自动创建：伏笔表、设定、摘要、索引、报告
```

```bash
mkdir -p "<书库根>/novels/我的小说"
```

书名就是 `novels/` 下的目录名；章号从文件名解析（`第01章.md`、`第02章.md`…）。

### 3.3 配置 MCP 服务器

启动命令：

```bash
<node 路径> <仓库路径>/mcp/server.mjs --root "<书库根>"
```

`--root` 缺省时依次回退到 `DSH_NOVEL_WRITER_ROOT` 环境变量、当前工作目录。**建议显式给 `--root`**，因为 MCP 客户端拉起子进程时的工作目录通常不是你的项目目录。

**workbuddy**：编辑 `~/.workbuddy/mcp.json`（`%USERPROFILE%\.workbuddy\mcp.json`）：

```json
{
  "mcpServers": {
    "novel-writer": {
      "command": "D:/node/node.exe",
      "args": [
        "D:/code/dsh-novel-writer/mcp/server.mjs",
        "--root",
        "D:/novel-workspace"
      ],
      "env": {
        "DSH_NOVEL_WRITER_STATE": "C:/Users/<用户名>/.dsh/dsh-novel-writer/state.json"
      }
    }
  }
}
```

- `command` 用 **node 的绝对路径**。客户端拉起的子进程不保证继承你终端的 PATH；Windows 上 `command: "node"` 常因找不到可执行文件而静默失败。
- 路径分隔符用 `/`，Node 在 Windows 上也接受。
- `env.DSH_NOVEL_WRITER_STATE` 可省略（默认为 `~/.dsh/dsh-novel-writer/state.json`）。**多实例/多书库时用它隔离**，否则所有实例共享同一份开关状态。

**Claude Desktop**：同一份 JSON 结构，写进

- Windows `%APPDATA%\Claude\claude_desktop_config.json`
- macOS `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux `~/.config/Claude/claude_desktop_config.json`

**Cursor**：`~/.cursor/mcp.json` 或项目内 `.cursor/mcp.json`，同上结构。

### 3.4 安装技能文件（弥补提示词注入缺失）

DSH 会通过 `ctx.systemPrompt.section` 注入三段工作流纪律；MCP 客户端没有这个通道。把仓库里的 `skills/novel-writing/SKILL.md` 装进客户端的技能目录即可补回来。

workbuddy 用户级技能目录：`~/.workbuddy/skills/<技能名>/SKILL.md`。它的 frontmatter 约定与仓库内的略有不同，需补三个字段：

```yaml
---
name: novel-writing
version: "7.3.2"
display_name: "小说写作助手（dsh-novel-writer）"
description: "中文网文写作助手：章节库浏览、风格基线分析、伏笔与设定表、必用词表、连贯性审计、本地语义检索。"
description_zh: "同上（中文）"
description_en: "Chinese web-novel writing assistant over MCP."
whenToUse: 用户提到小说、网文、章节、续写、改稿、文风、句式分析、伏笔、设定表、大纲、摘要、必用词时
---
```

正文直接沿用仓库版本，并在开头补一段本机环境说明——因为 MCP 下没有面板、书库根是固定的：

```markdown
## 本机环境

- 书库根固定为 `<书库根>`，章节在 `<书库根>/novels/<书名>/第01章.md`。
  调用工具通常不需要传 `root`。
- 不要用 glob 在会话工作目录下找 `novels/`，那里没有。
- 面板 UI 不可用，全部能力只经由工具返回的文本体现。
- 宿主不注入系统提示词，本文件即工作流纪律的唯一来源。
```

### 3.5 信任并重启

配置文件写好**不会立即生效**。

- **workbuddy**：连接器管理页 → 右上角「自定义连接器」→ 对 `novel-writer` 点「信任」→ 重启客户端。
- **Claude Desktop**：完全退出（含托盘）后重启。
- **Cursor**：Settings → MCP → 确认该 server 处于启用状态，必要时重载窗口。

### 3.6 不发布、不装包也能用

本地定制（改 `lib/*.js`、换词典）不需要 `npm publish`，也不需要 `npm link`：配置里的 `args` 直接指向**本地文件路径**，改完重启客户端即生效。想临时验证，直接跑 §4 的冒烟命令即可。

---

## 4. 验证

### 4.1 冒烟：确认工具与协议

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| node <仓库路径>/mcp/server.mjs --root "<书库根>"
```

期望：stderr 出现 `已注册 22 个工具；书库根目录 = …`，stdout 返回 `serverInfo.name = dsh-novel-writer`、`protocolVersion = 2025-11-25`，`tools` 数组长度 22。

### 4.2 冒烟：确认本地推理真的能用

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"novel_semantic_search","arguments":{"book":"我的小说","query":"与那盏没有点的灯有关的段落","top":3}}}' \
| node <仓库路径>/mcp/server.mjs --root "<书库根>"
```

期望输出形如（相似度与命中段落随正文变化）：

```text
《我的小说》语义检索「…」（命中 3 段，索引 10 段）
- [0.6847] 第02章.md: 对街那盏灯，亮了。
```

若返回「语义引擎不可用」，回到 §3.1 补 `npm ci`。

### 4.3 完整回归

改动 `lib/` 后跑仓库自带测试（需要 Node ≥ 22.3，37 个套件）：

```bash
npm run check     # build:check + check-release + 全部测试
npm test          # 只跑测试
```

`test/mcp-test.mjs` 专门覆盖 MCP 层（工具数派生、参数校验、越界拒绝、错误帧）。

---

## 5. 日常使用

工具名与 DSH 下完全一致，自然语言说需求即可：

| 你说 | 调用 | 得到 |
|---|---|---|
| 我的书库里有什么 | `novel_books` / `novel_chapters` | 作品与章节清单、字数 |
| 给下一章取材料 | `novel_chapter_brief` | 16 项输入一次取齐（上一章承接口、人物、待回收伏笔、用语规范、六维基线、锚段…） |
| 写第 7 章 | `novel_new_chapter` | 新建章节文件，附基线 μ |
| 自检第 7 章 | `novel_style_check` | 相似度 + 偏差清单 + 六维对照 |
| 把这章排成改稿清单 | `novel_fix_plan` | 按严重度排序的待办，带行号与锚段 |
| 看看全书结构 | `novel_plot` `action:"graph"` | 伏笔跨度、人物缺席、剧情线空档 |
| 找「女主压抑克制」的段落 | `novel_semantic_search` | 本地向量检索，0 token |

### 开关与参数（没有面板，只能通过工具改）

```json
{ "action": "set", "enabled": true }
```

调 `novel_sentence_config` 可改：

| 参数 | 说明 |
|---|---|
| `enabled` | 功能总开关。关闭后 `novel_style_check` 直接报错，`novel_sentence_analysis` 返回桩结果 |
| `tools` | 单工具开关，键必须是 `novel_*` 工具名，如 `{"novel_draft": true}` |
| `features` | 功能开关：`semanticEmbedding` / `lexiconFirst` / `emotionCaveat` / `genreTheme` / `webnovelVibe` / `rawWriting` |
| `leanWorkflow` | `true` 时报告类工具默认走精简输出，省 token，长篇建议开 |
| `chatThreshold` | 实时聊天写作的提问节奏（100~5000 字，默认 400），`0` 恢复默认 |
| `systemPromptMode` | 仅对 DSH 生效（MCP 下无注入通道），可忽略 |

两个容易踩的点：

- **`novel_draft`（草稿镜像）默认关闭。** 想在对话里逐段写半成品（只追加、完成前不碰正式章节），先 `{"action":"set","tools":{"novel_draft":true}}`。
- **`rawWriting`（非净化直白模式）在 MCP 下只有半个开关。** 它依赖宿主的 `llm/stream` 钩子做「软化重试」，MCP 客户端没有这个钩子，代码会静默跳过（`installRawModeGuard` 里 `return next()`）。开启它不会报错，但**兜底不生效**——而 DSH 侧还有「双重确认 + 承诺输入」的人为闸门，MCP 下也没有。建议保持关闭。

---

## 6. 排错

| 症状 | 原因 | 处理 |
|---|---|---|
| 客户端显示 server 连不上 / 无工具 | `command` 用了裸 `node`，子进程 PATH 里没有 | 改成 node 的绝对路径；先手跑 §4.1 确认命令本身能起 |
| 工具报「暂无作品」但文件明明在 | `--root` 指错层级。要求的是**含 `novels/` 的根**，不是 `novels/` 本身，也不是某本书的目录 | `--root "<书库根>"`，其下应有 `novels/<书名>/` |
| 语义检索「（不可用）」 | 没装依赖 | `npm ci` |
| 工具报「当前已在「写作助手功能」UI 中关闭」 | 该工具被状态文件关掉了 | `novel_sentence_config {"action":"set","tools":{"<工具名>":true}}` |
| 报「派生路径不安全」/ 参数 `root` 被拒 | 工具参数 `root` 必须落在 `--root` 之内（防越界读文件） | 去掉参数 `root` 用默认值，或把 `--root` 指到真正的书库根 |
| `novel_import` 说源目录不可用 | `src` 默认限书库根内 | 确认来源可信后，启动加 `--allow-external-src` |
| 中文书名/路径乱码 | Windows 终端代码页与 UTF-8 不一致（常见于 `.bat`/PowerShell 写配置） | 配置文件本身用 UTF-8 保存；不要用脚本拼中文路径 |
| 想看为什么一直失败 | 事件日志在 `~/.dsh/dsh-novel-writer/logs/events.jsonl`（512 KB 轮转，留 3 份） | 或用 `novel_diagnose` 生成可安全外发的报告 |

**安全边界**（`mcp/server.mjs` 默认开启，无需配置）：

- 单个请求帧上限 4 MiB、单个响应帧上限 8 MiB；超限丢弃并在 stderr 记长度，不记内容。
- 派生路径（`novels/<book>`、`.novel-writer`）若通过联接/符号链接指向根外，拒绝调用。
- stderr 不打印正文与堆栈，只打一行摘要（`DEBUG=1` 才输出完整堆栈）。
- `novel_diagnose` 的报告走「分享层」：自由文本整体剔除、错误归类为固定 code，可安全贴进 issue。**别直接附本机日志文件**——本机日志里可能含被错误消息回显的输入片段。

---

## 7. 与 DSH 插件形态的取舍

| | MCP 客户端 | DSH 插件 |
|---|---|---|
| 安装成本 | 一份 JSON + 一个技能文件 | `dsh plugin add dsh-novel-writer` |
| 界面 | 无（纯文本报告） | 右侧栏面板 + 开关页 + 诊断页 |
| 提示词注入 | 靠技能文件 | 自动，按档位/场景注入 |
| 流层兜底 | 无 | 有（非净化模式重试） |
| 升级方式 | `git pull` + `npm ci` | `dsh plugin add` 重装 |
| 定制成本 | 改本地文件即生效，无需发布 | 同理，但要处理构建产物 |

两条路可以同时用：同一个书库根、同一份状态文件，DSH 里用面板调开关，MCP 客户端里用工具跑分析，互不冲突（**并发写同一本书时注意别同时改同一章**）。

---

## 8. 最小可用清单

```bash
# 1. 代码与依赖
git clone <repo> && cd dsh-novel-writer && npm ci

# 2. 书库
mkdir -p "<书库根>/novels/我的小说"

# 3. MCP 配置：<node 绝对路径> <仓库路径>/mcp/server.mjs --root "<书库根>"

# 4. 技能：~/.workbuddy/skills/novel-writing/SKILL.md

# 5. 信任 + 重启客户端

# 6. 冒烟
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| node <仓库路径>/mcp/server.mjs --root "<书库根>"
```

看到 `已注册 22 个工具` 就通了。
