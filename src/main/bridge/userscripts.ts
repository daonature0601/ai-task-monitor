import type { ToolId } from '@shared/types'

interface ScriptConfig {
  tool: ToolId
  label: string
  port: number
  token: string
  /** 命中这些 URL 片段才解析响应 */
  urlHints: string[]
  matchOrigin: string
}

function commonCore(cfg: ScriptConfig): string {
  return `
  const BRIDGE = 'http://127.0.0.1:${cfg.port}/v1/usage';
  const TOKEN = '${cfg.token}';
  const TOOL = '${cfg.tool}';
  const URL_HINTS = ${JSON.stringify(cfg.urlHints)};
  const SESSION_KEY = '__atm_session_id';
  const MODEL_KEY = '__atm_model';

  function sessionId() {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      const m = location.pathname.match(/\\/(?:chat|c|conversation)\\/([\\w-]{6,})/i);
      id = (m && m[1]) || (TOOL + '-' + Date.now().toString(36));
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  }

  function num(v) {
    return typeof v === 'number' && isFinite(v) && v > 0 ? Math.round(v) : 0;
  }

  /** 在任意响应 JSON 中定位 usage 字段（同时兼容 OpenAI / Anthropic 命名） */
  function extractUsage(node, depth) {
    if (!node || depth > 8) return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = extractUsage(item, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    if (typeof node !== 'object') return null;
    const u = node.usage || node.token_usage || node.tokenUsage;
    if (u && typeof u === 'object') {
      const inputTotal = num(u.prompt_tokens) || num(u.input_tokens) || num(u.inputTokens);
      const cacheRead = num(u.prompt_cache_hit_tokens) || num(u.cache_read_input_tokens) || num(u.cached_tokens) || 0;
      const cacheWrite = num(u.prompt_cache_write_tokens) || num(u.cache_creation_input_tokens) || 0;
      const output = num(u.completion_tokens) || num(u.output_tokens) || num(u.outputTokens);
      if (inputTotal || output || cacheRead || cacheWrite) {
        return {
          inputTokens: Math.max(0, inputTotal - cacheRead),
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite
        };
      }
    }
    if (typeof node.model === 'string') sessionStorage.setItem(MODEL_KEY, node.model);
    for (const key in node) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      const hit = extractUsage(node[key], depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  function report(usage, end) {
    const body = {
      tool: TOOL,
      sessionId: sessionId(),
      title: document.title.slice(0, 120),
      model: sessionStorage.getItem(MODEL_KEY) || undefined,
      inputTokens: usage ? usage.inputTokens : 0,
      outputTokens: usage ? usage.outputTokens : 0,
      cacheReadTokens: usage ? usage.cacheReadTokens : 0,
      cacheWriteTokens: usage ? usage.cacheWriteTokens : 0,
      ts: Date.now(),
      end: !!end
    };
    fetch(BRIDGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': TOKEN },
      body: JSON.stringify(body)
    }).catch(function () { /* 桥接未启动时静默重试下一次 */ });
  }

  function matched(url) {
    return URL_HINTS.some(function (hint) { return url.indexOf(hint) >= 0; });
  }

  const rawFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const response = await rawFetch.apply(this, arguments);
    if (!matched(url)) return response;
    try {
      const clone = response.clone();
      const text = await clone.text();
      const usage = extractUsage(JSON.parse(text), 0);
      if (usage) report(usage, false);
      else report(null, false);
    } catch (e) { /* SSE / 非 JSON 响应忽略 */ }
    return response;
  };

  const rawOpen = XMLHttpRequest.prototype.open;
  const rawSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__atmUrl = url;
    return rawOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      if (!matched(String(this.__atmUrl || ''))) return;
      try {
        const usage = extractUsage(JSON.parse(this.responseText), 0);
        if (usage) report(usage, false);
        else report(null, false);
      } catch (e) { /* ignore */ }
    });
    return rawSend.apply(this, arguments);
  };

  window.addEventListener('beforeunload', function () { report(null, true); });
  console.log('[AI Task Monitor] ${cfg.label} 采集脚本已加载，桥接端口 ${cfg.port}');
`
}

export function buildUserscript(tool: ToolId, port: number, token: string): string {
  const isYuanbao = tool === 'yuanbao'
  const cfg: ScriptConfig = {
    tool,
    label: isYuanbao ? '元宝' : 'DeepSeek',
    port,
    token,
    urlHints: isYuanbao
      ? ['/api/', 'chat/complet', 'conversation']
      : ['/api/', 'chat/complet', 'completion'],
    matchOrigin: isYuanbao ? 'https://yuanbao.tencent.com' : 'https://chat.deepseek.com'
  }

  const header = `// ==UserScript==
// @name         AI Task Monitor · ${cfg.label} 用量上报
// @namespace    ai-task-monitor
// @version      1.0.0
// @description  将 ${cfg.label} 网页端的真实 token 用量上报到本机监控面板（仅监听 127.0.0.1）
// @match        ${cfg.matchOrigin}/*
// @grant        none
// @run-at       document-start
// ==/UserScript==
`

  return `${header}(function () {\n  'use strict';\n${commonCore(cfg)}})();\n`
}

export function scriptFileName(tool: ToolId): string {
  return tool === 'yuanbao' ? 'ai-task-monitor-yuanbao.user.js' : 'ai-task-monitor-deepseek.user.js'
}
