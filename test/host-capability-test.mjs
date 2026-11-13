// 宿主能力探测测试（本地定制 v7.4.0-local）
// 覆盖三件事：
//   ① MCP 形态下 6 个能力面的判定（stub ctx 的 inject 会同步回调，不得被误读成"可用"）；
//   ② rawWriting 在无 llm/stream 宿主下的告警必须产出；
//   ③ 未声明宿主形态（DSH 既有路径）时 issues 为空——不改变既有报告内容。
import {
  detectHostCapabilities, markHostCapability, getHostCapabilities,
  isMcpHost, llmStreamAvailable, hostCapabilityIssues, hostCapabilitySummary
} from "../lib/host.js";

let ok = true;
function check(name, cond, extra = "") {
  if (cond) {
    console.log("  ✓ " + name);
  } else {
    ok = false;
    console.log("  ✗ " + name + (extra ? "　" + extra : ""));
  }
}

// 与 mcp/server.mjs 的 stub ctx 一致：只有 tools / systemPrompt / inject
const mcpCtx = {
  tools: { register: () => () => {} },
  systemPrompt: { section: () => () => {} },
  inject: (_names, callback) => callback({
    webServer: { register: () => () => {} },
    skills: { registerProvider: () => () => {} },
    effect: (fn) => (typeof fn === "function" ? fn() : undefined)
  })
};

console.log("MCP 形态：");
let caps = detectHostCapabilities(mcpCtx, "mcp");
check("mode = mcp", caps.mode === "mcp");
check("tools 可用", caps.tools === true);
check("systemPrompt 可用", caps.systemPrompt === true);
check("llmStream 不可用", caps.llmStream === false);
check("webServer 不可用", caps.webServer === false);
check("skills 不可用", caps.skills === false);
check("slots 不可用", caps.slots === false);
check("isMcpHost()", isMcpHost() === true);
check("llmStreamAvailable() === false", llmStreamAvailable() === false);

// stub 的 inject 会同步回调并传入空桩：若按"回调执行过"判定，会把桩误读成可用
markHostCapability("webServer", true);
markHostCapability("skills", true);
check("不采信 stub 回调（webServer 仍不可用）", getHostCapabilities().webServer === false);
check("不采信 stub 回调（skills 仍不可用）", getHostCapabilities().skills === false);

const issues = hostCapabilityIssues();
check("issues 产出 2 条", issues.length === 2, "实际 " + issues.length);
check("首条为 info（能力矩阵）", issues[0]?.level === "info");
check("次条为 warn 且点名 rawWriting", issues[1]?.level === "warn" && String(issues[1]?.title).includes("rawWriting"));
const ALLOWED = ["level", "title", "detail", "suggestion"];
check("issue 只含 schema 允许的四个键", issues.every((it) => Object.keys(it).every((k) => ALLOWED.includes(k))));
check("摘要含「流层兜底（llm/stream）：不可用」", hostCapabilitySummary().includes("流层兜底（llm/stream）：不可用"));

console.log("未声明形态（DSH 既有路径）：");
const dshCtx = {
  tools: { register: () => () => {} },
  systemPrompt: { section: () => () => {} },
  on: () => () => {},
  slots: { inject: () => () => {} }
};
caps = detectHostCapabilities(dshCtx);
check("mode = unknown", caps.mode === "unknown");
check("llmStream 可用（有 ctx.on）", caps.llmStream === true);
check("slots 可用", caps.slots === true);
check("webServer / skills 标未知", caps.webServer === null && caps.skills === null);
check("isMcpHost() === false（brief 默认不改变）", isMcpHost() === false);
check("不产出 issues（既有报告不变）", hostCapabilityIssues().length === 0);

markHostCapability("skills", true);
check("非 MCP 模式下 markHostCapability 生效", getHostCapabilities().skills === true);

console.log("边界：");
caps = detectHostCapabilities(null, "mcp");
check("空 ctx 不抛，tools 不可用", caps.tools === false && caps.mode === "mcp");
caps = detectHostCapabilities(mcpCtx, "不认识的形态");
check("非法 hostMode 归为 unknown", caps.mode === "unknown");

console.log(ok ? "\n宿主能力测试全部通过" : "\n宿主能力测试有失败项");
process.exit(ok ? 0 : 1);
