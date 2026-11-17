# 安全策略

## 支持范围

| 版本 | 是否接收安全更新 |
| --- | --- |
| 1.x（当前） | ✅ |
| < 1.0 | ❌ |

## 报告漏洞

**请勿通过公开 Issue 报告安全问题。**

- 邮箱：`sanwuwy@gmail.com`（标题前缀 `[SECURITY]`）
- 请在邮件中说明：影响版本、复现步骤、影响面（例如能否读取任意文件、能否被网页跨域调用）
- 一般在 72 小时内确认收到，7 天内给出初步结论

确认后会在修复版本发布时于 [CHANGELOG.md](CHANGELOG.md) 中致谢（如你愿意署名）。

---

## 安全模型

本工具的设计前提是「**只读、本地、不联网**」，以下边界是刻意的：

### 数据读取

- 仅读取当前用户有权限访问的文件，路径固定在各适配器中，不接受外部输入
- 外部 SQLite（WorkBuddy、Cursor 等）一律以 `readonly: true` 打开，**绝不写入**
- 不读取 prompt、代码、文件内容，只取时间戳、模型名、token 计数与工作区路径

### 网络

- 除可选的网页端桥接外，应用不发起任何出站请求，也不做遥测
- 桥接服务仅监听 `127.0.0.1`，不对外暴露

### 桥接服务（`src/main/bridge/server.ts`）

| 措施 | 说明 |
| --- | --- |
| 令牌校验 | 首次启动生成 24 字节随机 token，存于 `<userData>/monitor/bridge-token`（权限 0600），请求需带 `X-Bridge-Token` |
| 来源限制 | 仅允许 `yuanbao.tencent.com`、`chat.deepseek.com` 的 Origin |
| 体积限制 | 请求体上限 64 KB，超限直接断开 |
| 频率限制 | 30 req/s，超出返回 429 |
| 端口范围 | 43117–43200，被占用时自动递增 |

用户脚本只上报 token 计数与页面标题，不上报对话正文。

### Electron 加固

- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`
- preload 通过 `contextBridge` 白名单暴露 API，渲染进程无法直接触达 `fs` / `db` / `node`
- 窗口内禁止导航，外链交给系统浏览器
- 生产构建启用 CSP（见 `src/renderer/index.html`）

---

## 已知的信任假设

1. **本机数据是可信的**：若攻击者已能写入 `~/.codex/sessions` 等目录，其权限已高于本工具
2. **桥接 token 等同口令**：泄露 token 的第三方页面可在白名单 Origin 下伪造上报（只影响统计数据，不影响系统）
3. **未做代码签名与公证**：从非官方渠道获取的安装包请自行校验来源；正式分发建议配置 Developer ID 签名
