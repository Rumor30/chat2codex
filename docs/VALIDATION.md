# 验证记录

## 本轮已执行

日期：2026-09-11。环境：Linux，Node.js v22.16.0。

- `npm run check`：通过 JavaScript 语法检查。
- `npm test`：36 项通过，0 项失败。
- 真实本地 HTTP server/client 测试了 SSE 原始字节、Unicode 分块、普通/自定义工具回执、跨请求账号粘性、压缩路由、429 不重试、截断失败、管理鉴权及 CSP。
- 工具执行 worker 在上述网络测试中是**明确的 fixture**，不是真实 ChatGPT 账号。测试不会声称已修改任何用户项目。
- 浏览器 UI 自动化尝试受到本环境 Chromium 的 `ERR_BLOCKED_BY_ADMINISTRATOR` 限制；没有将该次尝试记录为通过。

## 独立验证层

1. 网关/路由的本地单元和 HTTP 集成测试。
2. `bridge:check`：安装锁定上游之后的 TypeScript + Bun 打包检查，验证实际导出/接口，不运行模型。
3. 每账号真实 MCP nonce echo 探针：在用户的已登录独立浏览器中执行。
4. 真正 Codex → 网页 → MCP → Codex 的项目任务和跨账号并行测试。

层 1 通过不等于层 3/4 通过。管理台的 Ready 必须来自层 3，不得由手动 metadata 或测试 fixture 推导。

## 尚待真实账号验收

- 两个独立账号并发时 Cookie、Tunnel、工具回执不串号。
- Codex 的 `exec_command`、freeform `apply_patch`、配置中的 MCP、图片结果。
- 长回答取消、等待工具期间取消、浏览器关闭、Tunnel 断线。
- 自动压缩以及多 agent 子任务。
- Windows / macOS 本机 Electron 启动与权限流程。
- Session 方式创建 Connector 的真实请求链与重复创建恢复。

目前没有用户的登录浏览器、Tunnel key 或本地 Codex 进程，不能把这些验收写成“已完成”。
