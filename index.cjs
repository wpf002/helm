"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
const electron = require("electron");
const node_path = require("node:path");
const node_fs = require("node:fs");
const node_os = require("node:os");
const node_crypto = require("node:crypto");
const nodePty = require("node-pty");
const promises = require("node:fs/promises");
function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2 || value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\$\{?HOME\}?/g, node_os.homedir());
    out[key] = value;
  }
  return out;
}
function findEnvFile(start) {
  let dir = node_path.resolve(start);
  for (let i = 0; i < 6; i++) {
    const candidate = node_path.join(dir, ".env");
    if (node_fs.existsSync(candidate)) return candidate;
    const parent = node_path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return void 0;
}
function loadEnv(startDir) {
  const envFile = findEnvFile(startDir);
  const fromFile = envFile ? parseEnvFile(node_fs.readFileSync(envFile, "utf8")) : {};
  for (const [key, value] of Object.entries(fromFile)) {
    if (process.env[key] === void 0) process.env[key] = value;
  }
  const read = (key) => process.env[key] ?? fromFile[key];
  const rawMode = read("HELM_PERMISSION_MODE");
  const permissionMode = rawMode === "off" || rawMode === "auto" || rawMode === "prompt" ? rawMode : "prompt";
  const rawRoots = read("HELM_EXTRA_ROOTS") ?? "";
  return {
    shell: read("HELM_SHELL") || process.env["SHELL"] || "/bin/zsh",
    homeRoot: read("HELM_HOME_ROOT") || node_os.homedir(),
    extraRoots: rawRoots.split(":").filter((r) => r.length > 0),
    permissionMode,
    model: read("HELM_MODEL"),
    envFile
  };
}
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const OSC7 = new RegExp(`${ESC}\\]7;file://([^/]*)([^${BEL}${ESC}]*)(?:${BEL}|${ESC}\\\\)`, "g");
const MAX_RESIDUAL = 4096;
function spawnPty(config, callbacks) {
  const id = node_crypto.randomUUID();
  const pty = nodePty.spawn(config.shell, [], {
    name: "xterm-256color",
    cols: Math.max(1, Math.floor(config.cols)),
    rows: Math.max(1, Math.floor(config.rows)),
    cwd: config.cwd,
    env: config.env
  });
  let currentCwd = config.cwd;
  let residual = "";
  let dead = false;
  const trackCwd = (chunk) => {
    const buf = residual + chunk;
    let lastEnd = 0;
    let match;
    OSC7.lastIndex = 0;
    while ((match = OSC7.exec(buf)) !== null) {
      const encoded = match[2];
      if (encoded) {
        try {
          currentCwd = decodeURIComponent(encoded);
        } catch {
          currentCwd = encoded;
        }
      }
      lastEnd = OSC7.lastIndex;
    }
    const tail = buf.slice(lastEnd);
    const esc = tail.lastIndexOf(ESC);
    residual = esc === -1 ? "" : tail.slice(esc).slice(0, MAX_RESIDUAL);
  };
  pty.onData((data) => {
    trackCwd(data);
    callbacks.onData(id, data);
  });
  pty.onExit(({ exitCode }) => {
    dead = true;
    callbacks.onExit(id, exitCode);
  });
  return {
    id,
    write(data) {
      if (!dead)
        pty.write(data);
    },
    resize(cols, rows) {
      if (dead)
        return;
      if (!Number.isFinite(cols) || !Number.isFinite(rows))
        return;
      try {
        pty.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)));
      } catch {
      }
    },
    cwd() {
      return currentCwd;
    },
    kill() {
      if (dead)
        return;
      try {
        pty.kill();
      } catch {
      }
    }
  };
}
const PATH_KEYS = {
  Read: ["file_path", "notebook_path"],
  Write: ["file_path"],
  Edit: ["file_path", "notebook_path"],
  NotebookEdit: ["notebook_path"],
  Glob: ["path"],
  Grep: ["path"],
  LS: ["path"]
};
const GENERIC_KEYS = ["file_path", "notebook_path", "path", "cwd", "directory"];
function isRecord$2(value) {
  return typeof value === "object" && value !== null;
}
function expandHome(value) {
  if (value === "~")
    return node_os.homedir();
  if (value.startsWith("~/"))
    return node_path.resolve(node_os.homedir(), value.slice(2));
  return value;
}
function pathsFromCommand(command) {
  const found = [];
  const re = /(?:^|[\s'"=<>|&;()])((?:~\/|\.\.?\/|\/)[^\s'"<>|&;()]+)/g;
  let match;
  while ((match = re.exec(command)) !== null) {
    const candidate = match[1];
    if (candidate)
      found.push(candidate);
  }
  return found;
}
function collectRaw(toolName, input) {
  if (!isRecord$2(input))
    return { raw: [] };
  const raw = [];
  const keys = PATH_KEYS[toolName] ?? GENERIC_KEYS;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0)
      raw.push(value);
  }
  const command = typeof input["command"] === "string" ? input["command"] : void 0;
  if (command)
    raw.push(...pathsFromCommand(command));
  return command === void 0 ? { raw } : { raw, command };
}
async function realpathOrNearest(absolute) {
  try {
    return await promises.realpath(absolute);
  } catch {
    const parent = node_path.dirname(absolute);
    if (parent === absolute)
      return absolute;
    const resolvedParent = await realpathOrNearest(parent);
    return node_path.resolve(resolvedParent, absolute.slice(parent.length + 1));
  }
}
async function isWithinRoots(path, roots) {
  if (roots.length === 0)
    return false;
  const target = await realpathOrNearest(node_path.isAbsolute(path) ? path : node_path.resolve(path));
  for (const root of roots) {
    const realRoot = await realpathOrNearest(node_path.resolve(expandHome(root)));
    if (target === realRoot)
      return true;
    if (target.startsWith(realRoot.endsWith(node_path.sep) ? realRoot : realRoot + node_path.sep))
      return true;
  }
  return false;
}
async function evaluateScope(toolName, input, cwd, roots) {
  const factors = [];
  const { raw, command } = collectRaw(toolName, input);
  if (roots.length === 0) {
    factors.push({
      rule: "no-roots-configured",
      detail: "No roots are configured, so nothing can be judged in scope.",
      effect: "out-of-scope"
    });
  }
  if (raw.length === 0) {
    factors.push({
      rule: command ? "command-paths-unparsed" : "no-path-arguments",
      detail: command ? `No filesystem paths could be parsed out of: ${command.slice(0, 120)}` : `${toolName} declared no path arguments.`,
      effect: "info"
    });
    return {
      paths: [],
      outOfScope: command !== void 0,
      factors: command ? [
        ...factors,
        {
          rule: "unresolved-command",
          detail: "A shell command with no parsable paths can still reach anywhere.",
          effect: "out-of-scope"
        }
      ] : factors
    };
  }
  const paths = [];
  let outOfScope = false;
  for (const value of raw) {
    const expanded = expandHome(value);
    const absolute = node_path.isAbsolute(expanded) ? expanded : node_path.resolve(cwd, expanded);
    const real = await realpathOrNearest(absolute);
    if (!paths.includes(real))
      paths.push(real);
    if (real !== absolute) {
      factors.push({
        rule: "symlink-resolved",
        detail: `${absolute} resolves to ${real}`,
        effect: "info"
      });
    }
    const inside = await isWithinRoots(real, roots);
    if (inside) {
      factors.push({ rule: "within-root", detail: `${real} is inside a configured root.`, effect: "in-scope" });
    } else {
      outOfScope = true;
      factors.push({
        rule: "outside-roots",
        detail: `${real} is outside every configured root.`,
        effect: "out-of-scope"
      });
    }
  }
  return { paths, outOfScope, factors };
}
const DEFAULT_MODEL = "claude-sonnet-5";
const DISALLOWED_TOOLS = [
  "Task",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "TodoWrite",
  "ExitPlanMode",
  "SlashCommand"
];
const SYSTEM_APPEND = "You are running inside Helm, a terminal. Output is rendered as plain text in a scrollback buffer shared with the user's shell. Keep replies short and concrete. Do not use markdown headings or tables.";
class PromptQueue {
  buffered = [];
  waiting = null;
  closed = false;
  push(text) {
    if (this.closed)
      return;
    const message = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: ""
    };
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = null;
      waiting({ value: message, done: false });
    } else {
      this.buffered.push(message);
    }
  }
  close() {
    this.closed = true;
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = null;
      waiting({ value: void 0, done: true });
    }
  }
  async *[Symbol.asyncIterator]() {
    for (; ; ) {
      const next = this.buffered.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed)
        return;
      const result = await new Promise((resolve) => {
        this.waiting = resolve;
      });
      if (result.done)
        return;
      yield result.value;
    }
  }
}
function isRecord$1(value) {
  return typeof value === "object" && value !== null;
}
function summariseTool(toolName, input) {
  if (!isRecord$1(input))
    return toolName;
  const pick = (key) => typeof input[key] === "string" ? input[key] : void 0;
  switch (toolName) {
    case "Bash":
      return `Bash ${pick("command") ?? ""}`.trim();
    case "Read":
    case "Write":
    case "Edit":
      return `${toolName} ${pick("file_path") ?? ""}`.trim();
    case "Glob":
    case "Grep":
      return `${toolName} ${pick("pattern") ?? ""}`.trim();
    default: {
      const keys = Object.keys(input).slice(0, 3).join(", ");
      return keys ? `${toolName} (${keys})` : toolName;
    }
  }
}
function readUsage(raw) {
  if (!isRecord$1(raw))
    return void 0;
  const num = (key) => typeof raw[key] === "number" ? raw[key] : 0;
  return {
    input: num("input_tokens"),
    output: num("output_tokens"),
    cacheRead: num("cache_read_input_tokens"),
    cacheWrite: num("cache_creation_input_tokens")
  };
}
async function createSession(config, callbacks) {
  const id = node_crypto.randomUUID();
  const queue = new PromptQueue();
  let active = null;
  let disposed = false;
  const emit = (event) => {
    if (!disposed)
      callbacks.onEvent(event);
  };
  const roots = [config.homeRoot, ...config.extraRoots];
  const ask = async (toolName, input) => {
    const verdict = await evaluateScope(toolName, input, config.homeRoot, roots);
    if (config.permissionMode === "auto" && !verdict.outOfScope) {
      return {
        id: node_crypto.randomUUID(),
        behavior: "allow",
        persist: false,
        reason: "auto: every resolved path is within your roots"
      };
    }
    return callbacks.requestPermission({
      id: node_crypto.randomUUID(),
      toolName,
      input,
      affectedPaths: verdict.paths,
      outOfScope: verdict.outOfScope,
      factors: verdict.factors,
      roots
    });
  };
  const canUseTool = async (toolName, input) => {
    const decision = await ask(toolName, input);
    return decision.behavior === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: decision.reason ?? "Denied in Helm." };
  };
  const preToolUse = async (hookInput) => {
    const record = isRecord$1(hookInput) ? hookInput : {};
    const toolName = typeof record["tool_name"] === "string" ? record["tool_name"] : "unknown";
    const toolInput = record["tool_input"];
    const decision = await ask(toolName, toolInput);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision.behavior === "allow" ? "allow" : "deny",
        permissionDecisionReason: decision.reason ?? "Decided in Helm."
      }
    };
  };
  const options = {
    cwd: config.homeRoot,
    additionalDirectories: config.extraRoots,
    model: config.model ?? DEFAULT_MODEL,
    disallowedTools: DISALLOWED_TOOLS,
    // Dynamic sections carry git status and directory listings that change every
    // turn, which defeats prompt caching as well as costing tokens outright.
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: SYSTEM_APPEND,
      excludeDynamicSections: true
    },
    // Do not load user/project settings or CLAUDE.md files: Helm's scope is the
    // whole home directory, so those would be picked up unpredictably.
    settingSources: [],
    includePartialMessages: true,
    permissionMode: config.permissionMode === "off" ? "bypassPermissions" : "default",
    ...config.permissionMode === "off" ? {} : {
      canUseTool,
      hooks: {
        PreToolUse: [{ hooks: [preToolUse] }]
      }
    },
    ...config.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: config.pathToClaudeCodeExecutable } : {}
  };
  const consume = async (running) => {
    try {
      for await (const message of running) {
        if (disposed)
          return;
        if (message.type === "stream_event") {
          const event = message.event;
          if (!isRecord$1(event) || event["type"] !== "content_block_delta")
            continue;
          const delta = event["delta"];
          if (!isRecord$1(delta))
            continue;
          if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
            emit({ kind: "text", sessionId: id, text: delta["text"] });
          } else if (delta["type"] === "thinking_delta" && typeof delta["thinking"] === "string") {
            emit({ kind: "thinking", sessionId: id, text: delta["thinking"] });
          }
          continue;
        }
        if (message.type === "assistant") {
          const content = message.message?.content;
          if (!Array.isArray(content))
            continue;
          for (const block of content) {
            if (isRecord$1(block) && block["type"] === "tool_use") {
              emit({
                kind: "tool_start",
                sessionId: id,
                toolId: String(block["id"] ?? ""),
                toolName: summariseTool(String(block["name"] ?? ""), block["input"]),
                input: block["input"]
              });
            }
          }
          continue;
        }
        if (message.type === "user") {
          const content = message.message?.content;
          if (!Array.isArray(content))
            continue;
          for (const block of content) {
            if (isRecord$1(block) && block["type"] === "tool_result") {
              const raw = block["content"];
              const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part) => isRecord$1(part) && typeof part["text"] === "string" ? part["text"] : "").join("") : "";
              emit({
                kind: "tool_result",
                sessionId: id,
                toolId: String(block["tool_use_id"] ?? ""),
                ok: block["is_error"] !== true,
                output: text
              });
            }
          }
          continue;
        }
        if (message.type === "result") {
          const usage = readUsage(message["usage"]);
          if (message.subtype !== "success" || message.is_error) {
            const text = "result" in message && typeof message.result === "string" ? message.result : `Agent turn ended: ${message.subtype}`;
            emit({ kind: "error", sessionId: id, message: text });
          }
          emit({ kind: "turn_end", sessionId: id, ...usage ? { usage } : {} });
        }
      }
    } catch (error) {
      if (disposed)
        return;
      const text = error instanceof Error ? error.message : String(error);
      emit({ kind: "error", sessionId: id, message: text });
      emit({ kind: "turn_end", sessionId: id });
      active = null;
    }
  };
  return {
    id,
    async prompt(text) {
      if (disposed)
        return;
      if (!active) {
        const { query } = await import("@anthropic-ai/claude-agent-sdk");
        active = query({ prompt: queue, options });
        consume(active);
      }
      queue.push(text);
    },
    async interrupt() {
      if (!active)
        return;
      try {
        await active.interrupt();
      } catch {
      }
    },
    async dispose() {
      disposed = true;
      queue.close();
      const running = active;
      active = null;
      if (running) {
        try {
          await running.interrupt();
        } catch {
        }
      }
    }
  };
}
const SHELL_BUILTINS = /* @__PURE__ */ new Set([
  // POSIX / bash
  "cd",
  "export",
  "source",
  "alias",
  "unalias",
  "set",
  "unset",
  "echo",
  "pwd",
  "exit",
  "jobs",
  "fg",
  "bg",
  "kill",
  "wait",
  "type",
  "which",
  "command",
  "history",
  "eval",
  "exec",
  "test",
  "read",
  "shift",
  "trap",
  "umask",
  "ulimit",
  "local",
  "return",
  "declare",
  "typeset",
  "let",
  "pushd",
  "popd",
  "dirs",
  "hash",
  "times",
  "time",
  "builtin",
  "enable",
  "disown",
  "suspend",
  "getopts",
  "printf",
  "true",
  "false",
  "break",
  "continue",
  "readonly",
  // zsh
  "print",
  "setopt",
  "unsetopt",
  "autoload",
  "whence",
  "bindkey",
  "zmodload",
  "zstyle",
  "compdef",
  "compinit",
  "zle",
  "emulate",
  "functions",
  "integer",
  "float",
  "noglob",
  "nocorrect",
  "zcompile",
  "zparseopts",
  "zregexparse",
  "add-zsh-hook",
  "vared",
  "fc",
  "rehash",
  "ttyctl",
  "sched",
  "limit",
  "unlimit",
  "unfunction",
  "unhash",
  "where",
  "zargs",
  "zed",
  "zmv",
  // reserved words
  "if",
  "fi",
  "else",
  "elif",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "function",
  "select",
  "repeat",
  "foreach",
  "end",
  "coproc"
]);
const PROSE_MARKERS = /* @__PURE__ */ new Set([
  "the",
  "a",
  "an",
  "my",
  "your",
  "our",
  "this",
  "that",
  "these",
  "those",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "am",
  "do",
  "does",
  "did",
  "what",
  "why",
  "how",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "whose",
  "can",
  "could",
  "should",
  "would",
  "will",
  "shall",
  "may",
  "might",
  "must",
  "please",
  "me",
  "us",
  "it",
  "them",
  "him",
  "her",
  "i",
  "you",
  "we",
  "they",
  "and",
  "but",
  "or",
  "if",
  "then",
  "than",
  "because",
  "about",
  "into",
  "from",
  "with",
  "without",
  "for",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by"
]);
function shellSyntax(line, tokens) {
  const seen = [];
  if (/(^|\s)-{1,2}[A-Za-z0-9]/.test(line))
    seen.push("flag");
  if (/[|;]|&&|\|\|/.test(line))
    seen.push("operator");
  if (/(^|\s)[<>]|>>/.test(line))
    seen.push("redirect");
  if (/(^|\s)(\.{1,2}\/|\/|~\/)/.test(line))
    seen.push("path");
  if (/\$\{?[A-Za-z_]/.test(line))
    seen.push("variable");
  if (/[*?[\]]/.test(line) && tokens.length > 1)
    seen.push("glob");
  if (/`|\$\(/.test(line))
    seen.push("substitution");
  if (/[A-Za-z0-9._-]+=[^\s]/.test(line))
    seen.push("assignment");
  if (/(^|\s)['"]/.test(line))
    seen.push("quoted");
  return seen;
}
function withoutQuoted(line) {
  return line.replace(/'[^']*'/g, " ").replace(/"[^"]*"/g, " ");
}
function sentencePunctuation(line) {
  const seen = [];
  if (/\?\s*$/.test(line))
    seen.push("trailing-question-mark");
  if (/[a-z]\.\s*$/.test(line) && line.split(/\s+/).length > 2)
    seen.push("trailing-period");
  if (/!\s*$/.test(line) && !/\bhistory\b/.test(line))
    seen.push("trailing-exclamation");
  if (/,\s/.test(line))
    seen.push("comma");
  if (/\b(can't|won't|don't|isn't|doesn't|it's|i'm|i'd|let's)\b/i.test(line)) {
    seen.push("contraction");
  }
  return seen;
}
function routeInputWithFactors(line, pathBinaries2) {
  const factors = [];
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    factors.push({ rule: "empty-line", detail: "Nothing to route.", effect: "info" });
    return { route: { target: "agent", prompt: "" }, factors };
  }
  if (trimmed.startsWith("$")) {
    factors.push({ rule: "explicit-shell-prefix", detail: "Line begins with $.", effect: "info" });
    return { route: { target: "shell", command: trimmed.slice(1).trim() }, factors };
  }
  if (trimmed.startsWith("?")) {
    factors.push({ rule: "explicit-agent-prefix", detail: "Line begins with ?.", effect: "info" });
    return { route: { target: "agent", prompt: trimmed.slice(1).trim() }, factors };
  }
  const tokens = trimmed.split(/\s+/);
  let commandIndex = 0;
  while (commandIndex < tokens.length - 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[commandIndex] ?? "")) {
    commandIndex++;
  }
  const first = (tokens[commandIndex] ?? "").split(/[;|&<>()]/)[0] ?? "";
  const head = first.replace(/^.*\//, "");
  const isBuiltin = SHELL_BUILTINS.has(first);
  const onPath = pathBinaries2.has(first) || pathBinaries2.has(head);
  const looksExecutablePath = /^(\.{1,2}\/|\/|~\/)/.test(first);
  if (!isBuiltin && !onPath && !looksExecutablePath) {
    factors.push({
      rule: "first-token-unknown",
      detail: `"${first}" is not a shell builtin and does not resolve on PATH.`,
      effect: "info"
    });
    return { route: { target: "agent", prompt: trimmed }, factors };
  }
  factors.push({
    rule: isBuiltin ? "first-token-builtin" : "first-token-on-path",
    detail: `"${first}" ${isBuiltin ? "is a shell builtin" : "resolves to an executable"}.`,
    effect: "info"
  });
  const RESERVED_STARTS = /* @__PURE__ */ new Set([
    "if",
    "for",
    "while",
    "until",
    "case",
    "select",
    "repeat",
    "function",
    "foreach",
    "coproc",
    "do",
    "then"
  ]);
  if (RESERVED_STARTS.has(first)) {
    factors.push({
      rule: "shell-control-structure",
      detail: `"${first}" opens a shell control structure.`,
      effect: "info"
    });
    return { route: { target: "shell", command: trimmed }, factors };
  }
  const punctuation = sentencePunctuation(withoutQuoted(trimmed));
  const prose = withoutQuoted(trimmed).split(/\s+/).slice(commandIndex + 1).filter((word) => PROSE_MARKERS.has(word.toLowerCase()));
  const syntax = shellSyntax(trimmed, tokens);
  if (syntax.length > 0) {
    factors.push({
      rule: "shell-syntax-present",
      detail: `Carries shell syntax: ${syntax.join(", ")}.`,
      effect: "info"
    });
  }
  if (punctuation.length > 0) {
    factors.push({
      rule: "sentence-punctuation",
      detail: `Reads as a sentence: ${punctuation.join(", ")}.`,
      effect: "info"
    });
    return { route: { target: "agent", prompt: trimmed }, factors };
  }
  const strongSyntax = syntax.filter((s) => ["operator", "redirect", "substitution"].includes(s));
  if (strongSyntax.length > 0) {
    factors.push({
      rule: "shell-grammar",
      detail: `Carries shell grammar no sentence would: ${strongSyntax.join(", ")}.`,
      effect: "info"
    });
    return { route: { target: "shell", command: trimmed }, factors };
  }
  if (prose.length > 0) {
    factors.push({
      rule: "prose-markers",
      detail: `Contains English function words: ${prose.slice(0, 4).join(", ")}.`,
      effect: "info"
    });
    return { route: { target: "agent", prompt: trimmed }, factors };
  }
  factors.push({
    rule: "resolves-and-clean",
    detail: "First token resolves and nothing reads as prose.",
    effect: "info"
  });
  return { route: { target: "shell", command: trimmed }, factors };
}
async function scanPathBinaries() {
  const found = /* @__PURE__ */ new Set();
  const dirs = (process.env["PATH"] ?? "").split(node_path.delimiter).filter(Boolean);
  await Promise.all(dirs.map(async (dir) => {
    let entries;
    try {
      entries = await promises.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      found.add(entry);
    }
  }));
  for (const builtin of SHELL_BUILTINS)
    found.add(builtin);
  return found;
}
const IPC = {
  // renderer -> main
  AgentPrompt: "agent:prompt",
  AgentInterrupt: "agent:interrupt",
  PermissionResolve: "permission:resolve",
  PtyWrite: "pty:write",
  PtyResize: "pty:resize",
  InputSubmit: "input:submit",
  RouteObserve: "route:observe",
  RouteVocabulary: "route:vocabulary",
  SessionNew: "session:new",
  SessionClose: "session:close",
  SessionActivate: "session:activate",
  SessionTranscript: "session:transcript",
  SessionList: "session:list",
  // main -> renderer
  AgentStream: "agent:stream",
  PermissionRequest: "permission:request",
  PtyData: "pty:data",
  PtyExit: "pty:exit"
};
const pending = /* @__PURE__ */ new Map();
const sessionGrants = /* @__PURE__ */ new Set();
function clearPermissionState() {
  for (const [, entry] of pending) {
    entry.resolve({ id: "", behavior: "deny", persist: false, reason: "Session ended." });
  }
  pending.clear();
  sessionGrants.clear();
}
function requestPermission(win, request) {
  if (sessionGrants.has(request.toolName)) {
    return Promise.resolve({ id: request.id, behavior: "allow", persist: true });
  }
  if (win.isDestroyed()) {
    return Promise.resolve({
      id: request.id,
      behavior: "deny",
      persist: false,
      reason: "No window to ask."
    });
  }
  return new Promise((resolve) => {
    pending.set(request.id, { resolve });
    win.webContents.send(IPC.PermissionRequest, request);
  });
}
function resolvePermission(decision, toolName) {
  const entry = pending.get(decision.id);
  if (!entry) return;
  pending.delete(decision.id);
  if (decision.persist && decision.behavior === "allow" && toolName) {
    sessionGrants.add(toolName);
  }
  entry.resolve(decision);
}
const ROUTING_LOG = node_path.join(node_os.homedir(), ".helm", "routing.jsonl");
let warned = false;
async function logRouting(record) {
  try {
    await promises.mkdir(node_path.dirname(ROUTING_LOG), { recursive: true });
    await promises.appendFile(ROUTING_LOG, JSON.stringify(record) + "\n", "utf8");
  } catch (error) {
    if (!warned) {
      warned = true;
      console.error(`[helm] routing log unavailable: ${String(error)}`);
    }
  }
}
function recordFor(input, route, factors, mode, actual) {
  const inferred = route.target;
  const target = actual ?? inferred;
  return {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    input,
    target,
    ...inferred === target ? {} : { inferred },
    factors,
    mode
  };
}
const SESSION_DIR = node_path.join(node_os.homedir(), ".helm", "sessions");
const MAX_BYTES = 8 * 1024 * 1024;
const KEEP_SESSIONS = 20;
const sinks = /* @__PURE__ */ new Map();
function transcriptPath(sessionId) {
  return node_path.join(SESSION_DIR, `${sessionId}.jsonl`);
}
async function openTranscript(sessionId) {
  if (sinks.has(sessionId)) return;
  await promises.mkdir(SESSION_DIR, { recursive: true });
  const stream = node_fs.createWriteStream(transcriptPath(sessionId), { flags: "a" });
  stream.on("error", () => sinks.delete(sessionId));
  sinks.set(sessionId, { stream, bytes: 0, capped: false });
}
function append(sessionId, entry) {
  const sink = sinks.get(sessionId);
  if (!sink || sink.capped) return;
  const line = JSON.stringify(entry) + "\n";
  sink.bytes += Buffer.byteLength(line);
  if (sink.bytes > MAX_BYTES) {
    sink.capped = true;
    sink.stream.write(
      JSON.stringify({ t: "pty", d: "\r\n[transcript truncated: size limit reached]\r\n" }) + "\n"
    );
    return;
  }
  sink.stream.write(line);
}
function recordPty(sessionId, data) {
  append(sessionId, { t: "pty", d: data });
}
function recordAgent(sessionId, event) {
  append(sessionId, { t: "agent", e: event });
}
function closeTranscript(sessionId) {
  const sink = sinks.get(sessionId);
  if (!sink) return;
  sinks.delete(sessionId);
  sink.stream.end();
}
function closeAllTranscripts() {
  for (const id of [...sinks.keys()]) closeTranscript(id);
}
async function listTranscripts() {
  if (!node_fs.existsSync(SESSION_DIR)) return [];
  const files = (await promises.readdir(SESSION_DIR)).filter((f) => f.endsWith(".jsonl"));
  const out = [];
  for (const file of files) {
    try {
      const info = await promises.stat(node_path.join(SESSION_DIR, file));
      out.push({ id: file.replace(/\.jsonl$/, ""), mtime: info.mtimeMs, bytes: info.size });
    } catch {
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
async function readTranscript(sessionId) {
  const path = transcriptPath(sessionId);
  if (!node_fs.existsSync(path)) return [];
  const text = await promises.readFile(path, "utf8");
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
    }
  }
  return entries;
}
async function pruneTranscripts() {
  const all = await listTranscripts();
  for (const old of all.slice(KEEP_SESSIONS)) {
    try {
      await promises.unlink(transcriptPath(old.id));
    } catch {
    }
  }
}
const sessions = /* @__PURE__ */ new Map();
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function readSize(value) {
  const cols = isRecord(value) && typeof value["cols"] === "number" ? value["cols"] : 80;
  const rows = isRecord(value) && typeof value["rows"] === "number" ? value["rows"] : 24;
  return {
    cols: Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : 80,
    rows: Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 24
  };
}
function cleanEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  out["TERM"] = "xterm-256color";
  out["TERM_PROGRAM"] = "Helm";
  out["COLORTERM"] = "truecolor";
  if (!out["LANG"] && !out["LC_ALL"] && !out["LC_CTYPE"]) {
    out["LANG"] = `${systemLocale()}.UTF-8`;
  }
  return out;
}
function systemLocale() {
  try {
    const tag = Intl.DateTimeFormat().resolvedOptions().locale;
    const [language, region] = tag.split("-");
    if (language && region && /^[a-z]{2,3}$/.test(language) && /^[A-Z]{2}$/.test(region)) {
      return `${language}_${region}`;
    }
  } catch {
  }
  return "en_US";
}
let agent = null;
let agentStarting = null;
const requestTools = /* @__PURE__ */ new Map();
function resolveClaudeExecutable() {
  const platformPkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const candidates = [];
  try {
    const sdkDir = node_path.dirname(require.resolve("@anthropic-ai/claude-agent-sdk/package.json"));
    candidates.push(node_path.join(sdkDir, "node_modules", platformPkg, "claude"));
    candidates.push(node_path.join(sdkDir, "..", "..", platformPkg, "claude"));
  } catch {
  }
  const seen = /* @__PURE__ */ new Set();
  for (const candidate of candidates) {
    for (const path of [candidate, candidate.replace(`app.asar${node_path.sep}`, `app.asar.unpacked${node_path.sep}`)]) {
      if (seen.has(path)) continue;
      seen.add(path);
      if (node_fs.existsSync(path)) return path;
    }
  }
  return void 0;
}
let activeSessionId = null;
function killAllSessions() {
  for (const session of sessions.values()) session.kill();
  sessions.clear();
  closeAllTranscripts();
}
async function disposeAgent() {
  clearPermissionState();
  requestTools.clear();
  const current = agent;
  agent = null;
  agentStarting = null;
  if (current) await current.dispose();
}
let pathBinaries = /* @__PURE__ */ new Set();
void scanPathBinaries().then((found) => {
  pathBinaries = found;
}).catch(() => {
});
let ipcRegistered = false;
function registerIpc(getWindow, env2) {
  if (ipcRegistered) return;
  ipcRegistered = true;
  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  electron.ipcMain.handle(IPC.SessionNew, async (_event, raw) => {
    const { cols, rows } = readSize(raw);
    const session = spawnPty(
      { shell: env2.shell, cwd: env2.homeRoot, env: cleanEnv(), cols, rows },
      {
        onData: (sessionId, data) => {
          recordPty(sessionId, data);
          send(IPC.PtyData, { sessionId, data });
        },
        onExit: (sessionId, code) => {
          sessions.delete(sessionId);
          closeTranscript(sessionId);
          send(IPC.PtyExit, { sessionId, code });
        }
      }
    );
    sessions.set(session.id, session);
    await openTranscript(session.id);
    void pruneTranscripts();
    return {
      id: session.id,
      shell: env2.shell,
      cwd: session.cwd(),
      permissionMode: env2.permissionMode
    };
  });
  electron.ipcMain.handle(IPC.SessionClose, (_event, raw) => {
    if (typeof raw !== "string") return false;
    const session = sessions.get(raw);
    if (!session) return false;
    session.kill();
    sessions.delete(raw);
    closeTranscript(raw);
    clearPermissionState();
    return true;
  });
  electron.ipcMain.handle(IPC.SessionTranscript, async (_event, raw) => {
    if (raw === void 0 || raw === null) return listTranscripts();
    if (typeof raw !== "string") return [];
    return readTranscript(raw);
  });
  electron.ipcMain.on(IPC.PtyWrite, (_event, raw) => {
    if (!isRecord(raw)) return;
    const { sessionId, data } = raw;
    if (typeof sessionId !== "string" || typeof data !== "string") return;
    sessions.get(sessionId)?.write(data);
  });
  electron.ipcMain.on(IPC.SessionActivate, (_event, raw) => {
    if (typeof raw === "string") activeSessionId = raw;
  });
  electron.ipcMain.on(IPC.PtyResize, (_event, raw) => {
    if (!isRecord(raw)) return;
    const { sessionId } = raw;
    if (typeof sessionId !== "string") return;
    const { cols, rows } = readSize(raw);
    sessions.get(sessionId)?.resize(cols, rows);
  });
  electron.ipcMain.handle(
    IPC.SessionList,
    () => [...sessions.values()].map((s) => ({
      id: s.id,
      shell: env2.shell,
      cwd: s.cwd(),
      permissionMode: env2.permissionMode
    }))
  );
  const claudeExecutable = resolveClaudeExecutable();
  if (!claudeExecutable) {
    console.error("[helm] could not locate the Claude Code executable; the agent will not start.");
  }
  const ensureAgent = async () => {
    if (agent) return agent;
    if (agentStarting) return agentStarting;
    agentStarting = createSession(
      {
        homeRoot: env2.homeRoot,
        extraRoots: env2.extraRoots,
        permissionMode: env2.permissionMode,
        ...env2.model ? { model: env2.model } : {},
        ...claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}
      },
      {
        onEvent: (event) => {
          if (activeSessionId) recordAgent(activeSessionId, event);
          send(IPC.AgentStream, event);
        },
        requestPermission: async (request) => {
          const win = getWindow();
          if (!win || win.isDestroyed()) {
            return { id: request.id, behavior: "deny", persist: false, reason: "No window." };
          }
          requestTools.set(request.id, request.toolName);
          const decision = await requestPermission(win, request);
          requestTools.delete(request.id);
          return decision;
        }
      }
    ).then((created) => {
      agent = created;
      return created;
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      send(IPC.AgentStream, { kind: "error", sessionId: "", message });
      agentStarting = null;
      return null;
    });
    return agentStarting;
  };
  electron.ipcMain.on(IPC.AgentPrompt, (_event, raw) => {
    if (typeof raw !== "string" || raw.length === 0) return;
    void (async () => {
      const session = await ensureAgent();
      if (!session) return;
      try {
        await session.prompt(raw);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send(IPC.AgentStream, { kind: "error", sessionId: session.id, message });
        send(IPC.AgentStream, { kind: "turn_end", sessionId: session.id });
      }
    })();
  });
  electron.ipcMain.handle(IPC.InputSubmit, (_event, raw) => {
    const line = typeof raw === "string" ? raw : "";
    const { route, factors } = routeInputWithFactors(line, pathBinaries);
    const trimmed = line.trim();
    const explicit = trimmed.startsWith("$") || trimmed.startsWith("?");
    void logRouting(recordFor(line, route, factors, explicit ? "prefix" : "live"));
    return route;
  });
  electron.ipcMain.on(IPC.RouteVocabulary, (_event, raw) => {
    if (!Array.isArray(raw)) return;
    for (const word of raw) {
      if (typeof word === "string" && word.length > 0 && word.length < 128) {
        pathBinaries.add(word);
      }
    }
  });
  electron.ipcMain.on(IPC.RouteObserve, (_event, raw) => {
    if (!isRecord(raw)) return;
    const { input, target } = raw;
    if (typeof input !== "string" || target !== "shell" && target !== "agent") return;
    if (input.trim().length === 0) return;
    const { route, factors } = routeInputWithFactors(input, pathBinaries);
    const explicit = input.trim().startsWith("$") || input.trim().startsWith("?");
    void logRouting(recordFor(input, route, factors, explicit ? "prefix" : "shadow", target));
  });
  electron.ipcMain.on(IPC.AgentInterrupt, () => {
    void agent?.interrupt();
  });
  electron.ipcMain.on(IPC.PermissionResolve, (_event, raw) => {
    if (!isRecord(raw)) return;
    const { id, behavior, persist } = raw;
    if (typeof id !== "string") return;
    if (behavior !== "allow" && behavior !== "deny") return;
    resolvePermission(
      {
        id,
        behavior,
        persist: persist === true,
        ...typeof raw["reason"] === "string" ? { reason: raw["reason"] } : {}
      },
      requestTools.get(id)
    );
  });
}
const BACKGROUND = "#0d1017";
electron.app.setName("Helm");
electron.app.commandLine.appendSwitch("disable-features", "MacWebContentsOcclusion");
electron.app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
electron.app.commandLine.appendSwitch("disable-renderer-backgrounding");
const env = loadEnv(electron.app.getAppPath());
let mainWindow = null;
let isQuitting = false;
const HOTKEY = "CommandOrControl+Shift+H";
function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}
function buildMenu() {
  electron.Menu.setApplicationMenu(
    electron.Menu.buildFromTemplate([
      {
        label: "Helm",
        submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "quit" }]
      },
      {
        label: "Session",
        submenu: [
          {
            label: "New Session",
            accelerator: "CmdOrCtrl+T",
            click: () => mainWindow?.webContents.send("helm:session-new")
          },
          {
            label: "Close Session",
            accelerator: "CmdOrCtrl+W",
            click: () => mainWindow?.webContents.send("helm:session-close")
          },
          { type: "separator" },
          {
            label: "Resume Previous Session",
            accelerator: "CmdOrCtrl+Shift+R",
            click: () => mainWindow?.webContents.send("helm:session-resume")
          }
        ]
      },
      {
        label: "Edit",
        submenu: [
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
          { type: "separator" },
          {
            label: "Clear Scrollback",
            accelerator: "CmdOrCtrl+K",
            click: () => mainWindow?.webContents.send("helm:clear")
          }
        ]
      },
      {
        label: "View",
        submenu: [
          { role: "togglefullscreen" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { label: "Hide Helm", accelerator: HOTKEY, click: toggleWindow }
        ]
      },
      { role: "windowMenu" }
    ])
  );
}
function createWindow() {
  electron.nativeTheme.themeSource = "dark";
  mainWindow = new electron.BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 520,
    minHeight: 320,
    show: false,
    backgroundColor: BACKGROUND,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      // Non-negotiable: the renderer reaches nothing directly.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: node_path.join(__dirname, "../preload/index.cjs")
    }
  });
  mainWindow.on("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) void electron.shell.openExternal(url);
    return { action: "deny" };
  });
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(node_path.join(__dirname, "../renderer/index.html"));
  }
}
electron.app.whenReady().then(() => {
  if (!electron.app.isPackaged && electron.app.dock) {
    const icon = electron.nativeImage.createFromPath(node_path.join(electron.app.getAppPath(), "build", "icon.png"));
    if (!icon.isEmpty()) electron.app.dock.setIcon(icon);
  }
  electron.app.setAboutPanelOptions({
    applicationName: "Helm",
    applicationVersion: electron.app.getVersion(),
    version: "",
    credits: "A shell and the Claude agent loop behind one prompt."
  });
  buildMenu();
  registerIpc(() => mainWindow, env);
  createWindow();
  if (!electron.globalShortcut.register(HOTKEY, toggleWindow)) {
    console.error(`[helm] could not register ${HOTKEY}; it is already taken.`);
  }
  electron.app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else mainWindow.show();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    killAllSessions();
    void disposeAgent();
    electron.app.quit();
  }
});
electron.app.on("before-quit", () => {
  isQuitting = true;
  killAllSessions();
  void disposeAgent();
});
electron.app.on("will-quit", () => {
  electron.globalShortcut.unregisterAll();
});
