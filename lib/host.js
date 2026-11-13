/**
 * 宿主能力记录（本地定制 v7.4.0-local）
 *
 * 为什么需要这个文件：本插件有两个入口，宿主能力面并不相同——
 *   ① DSH 插件：cordis ctx 提供 tools / systemPrompt / webServer / skills / on / slots 六面；
 *   ② MCP 服务器：mcp/server.mjs 用 stub ctx 只提供 tools / systemPrompt / inject。
 *
 * ② 之下有几处能力**静默缺失**，而开关仍显示"已开启"——最典型的是 `features.rawWriting`：
 * 它依赖宿主 `llm/stream` 钩子做软化重试，MCP 宿主没有这个钩子，`installRawModeGuard` 直接
 * return，钩子从未安装。用户看到"开"，行为等于"关"。本模块把这些事实集中记录，供
 * `novel_sentence_config` 与 `novel_diagnose` 如实报告，避免"看起来开了、其实没生效"。
 *
 * 口径：
 *   true  = 可用（已探测到）
 *   false = 不可用（已确证缺失）
 *   null  = 未知（只能靠 `ctx.inject` 回调证明的能力，在注册期无法可靠探测——宁可标未知也不猜）
 *
 * MCP 模式为什么要把 webServer / skills 直接钉成 false：stub ctx 的 `inject` 会**同步回调**
 * 并传入空桩，若按回调是否执行来判定，会把"桩"误读成"可用"。显式模式优先，不采信桩的回调。
 */

const state = {
  mode: "unknown",
  tools: null,
  systemPrompt: null,
  webServer: null,
  skills: null,
  llmStream: null,
  slots: null
};

/**
 * 探测宿主能力面。必须在 `apply()` 开头调用一次。
 * @param {object} ctx 宿主 context
 * @param {string} [hostMode] 显式宿主形态："mcp" / "dsh"；缺省按 unknown 处理
 */
export function detectHostCapabilities(ctx, hostMode) {
  const mode = hostMode === "mcp" || hostMode === "dsh" ? hostMode : "unknown";
  state.mode = mode;
  state.tools = typeof ctx?.tools?.register === "function";
  state.systemPrompt = typeof ctx?.systemPrompt?.section === "function";
  state.llmStream = typeof ctx?.on === "function";
  state.slots = typeof ctx?.slots?.inject === "function";
  // 这两项只能由 ctx.inject 回调证明，stub 会同步回调 → 非 MCP 模式保留"未知"
  state.webServer = mode === "mcp" ? false : null;
  state.skills = mode === "mcp" ? false : null;
  return getHostCapabilities();
}

/** 由 ctx.inject 回调侧回报"某项服务确实拿到了"。MCP 模式下不采信（见文件头）。 */
export function markHostCapability(name, value) {
  if (name === "mode" || !(name in state)) return;
  if (state.mode === "mcp") return;
  state[name] = value === true;
}

/** @returns {{mode:string, tools:boolean|null, systemPrompt:boolean|null, webServer:boolean|null, skills:boolean|null, llmStream:boolean|null, slots:boolean|null}} */
export function getHostCapabilities() {
  return { ...state };
}

/** 当前是否是 MCP 形态（无面板宿主）。报告类工具的 brief 默认值依赖它。 */
export function isMcpHost() {
  return state.mode === "mcp";
}

/** 宿主是否具备 llm/stream 钩子（非净化模式兜底的前提）。 */
export function llmStreamAvailable() {
  return state.llmStream === true;
}

const ROWS = Object.freeze([
  ["tools", "工具注册"],
  ["systemPrompt", "系统提示注入"],
  ["webServer", "面板 HTTP 路由"],
  ["skills", "技能注册"],
  ["llmStream", "流层兜底（llm/stream）"],
  ["slots", "侧栏席位"]
]);

function stateText(value) {
  return value === true ? "可用" : value === false ? "不可用" : "未知";
}

/** 一行摘要，供 issue.detail 使用。 */
export function hostCapabilitySummary() {
  return ROWS.map(([key, label]) => `${label}：${stateText(state[key])}`).join("；");
}

/**
 * 生成可直接塞进 `novel_diagnose` 的 issues（元素只含 level/title/detail/suggestion 四个键——
 * 该工具的 output schema 是 additionalProperties:false，多一个键会被宿主拒收）。
 * mode 为 unknown（未显式声明宿主形态）时返回空数组：不改变既有 DSH 行为的报告内容。
 */
export function hostCapabilityIssues() {
  if (state.mode === "unknown") return [];
  const issues = [];
  const availableCount = ROWS.filter(([key]) => state[key] === true).length;
  const modeLabel = state.mode === "mcp" ? "MCP 客户端" : "DSH 插件";
  issues.push({
    level: "info",
    title: `宿主形态：${modeLabel}（${availableCount}/${ROWS.length} 项能力可用）`,
    detail: hostCapabilitySummary(),
    suggestion: state.mode === "mcp"
      ? "缺失项不影响 22 个工具本身：报告类工具在未显式指定时默认精简输出；工作流纪律由客户端技能文件（SKILL.md）承载；面板类功能需改用 DSH 插件形态。"
      : "无需处理。"
  });
  if (state.mode === "mcp" && state.llmStream === false) {
    issues.push({
      level: "warn",
      title: "非净化模式（rawWriting）在本宿主下不生效",
      detail: "该模式依赖宿主 llm/stream 钩子做「软化重试」。MCP 宿主没有这个钩子，钩子从未安装，模型在场景里自我刹车时不会丢弃重试。",
      suggestion: "若已开启 features.rawWriting，建议关闭（开关会显示为开，但行为等于关）；需要该兜底请改用 DSH 插件形态。"
    });
  }
  return issues;
}
