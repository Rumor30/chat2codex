# 验证记录

## 本轮已执行

日期：2026-09-11。环境：Linux，Node.js v22.16.0。

- `npm run check`：通过 JavaScript 语法检查。
- `npm test`：52 项通过，0 项失败。
- 真实本地 HTTP server/client 测试了 SSE 原始字节、Unicode 分块、普通/自定义工具回执、跨请求账号粘性、压缩路由、429 不重试、截断失败、管理鉴权及 CSP。
- 工具执行 worker 在上述网络测试中是**明确的 fixture**，不是真实 ChatGPT 账号。测试不会声称已修改任何用户项目。
- 浏览器 UI 自动化尝试受到本环境 Chromium 的 `ERR_BLOCKED_BY_ADMINISTRATOR` 限制；没有将该次尝试记录为通过。

## GitHub Actions 已观察结果

已检查代码提交 `4cc81e425049a398a022f82d10af43f0e8f99feb` 的 PR run `34608302002`，六项作业均成功：

| 作业 | 结果 |
| --- | --- |
| core / Ubuntu | 通过 |
| core / Windows | 通过；symlink 权限测试明确跳过 |
| core / macOS | 通过 |
| pinned-bridge / Ubuntu | 上游安装、TypeScript、Bun 打包和两个账号的 Tunnel 别名隔离检查通过 |
| native-codex-fixture / Ubuntu | Codex 0.154.0 的原生计划工具闭环通过 |
| native-codex-fixture / Windows | Codex 0.154.0 的原生计划工具闭环通过 |

真实 Codex 测试实际启动 CLI、经本地网关接收 `function_call`、执行 `update_plan`、回传精确的 `Plan updated`，最后接收最终回答；同时验证原生 thread/turn metadata，以及预置的 config.toml/auth.json 字节未变。模型输出由明确的本地 fixture 产生，不是 ChatGPT 推理。

默认计划工具在此版本需要测试进程临时设置 `tools.update_plan.enabled=true`；测试不改变用户配置文件，不增加 shell 权限。实际日志仍出现自定义模型未找到完整 catalog metadata 的警告，完整模型目录/桌面选择器集成尚未完成。

初始 36 项测试的 CI run `34604375376` 也通过，随后扩展到 52 项。后续提交的结果以对应 Checks 为准；本记录不声称未检查过的提交也已经通过。

## 独立验证层

1. 网关/路由的本地单元和 HTTP 集成测试。
2. `bridge:check`：安装锁定上游之后的 TypeScript + Bun 打包检查，验证实际导出/接口，不运行模型。
3. `scripts/codex-smoke.mjs`：真实 Codex 0.154.0 CLI + 明确的本地模型 fixture，通过原生 `update_plan` 检查工具回执、metadata 和 config/auth 不变；不使用真实 ChatGPT，也不把此项当作 shell 执行验证。
4. 每账号真实 MCP nonce echo 探针：在用户的已登录独立浏览器中执行。
5. 真正 Codex → 网页 → MCP → Codex 的项目任务和跨账号并行测试。

层 1/2/3 通过不等于层 4/5 通过。管理台的 Ready 必须来自层 4，不得由手动 metadata 或测试 fixture 推导。

## 已遇到并保留的兼容性/环境限制

- Codex 0.125.0 的 Windows shell 在本地 fixture 中执行了命令，但缺少当前网页桥所需的原生 turn metadata，因此整个检查未通过，不列为兼容版本。
- Codex 0.154.0 的 CI shell 检查：Linux 返回 `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`；Windows 返回命令被策略拒绝。没有关闭沙箱或绕过该限制。
- 最初的测试仅搜索 nonce 子串，可能把“错误消息里引用的命令”误判为成功；已修正为必须同时出现零退出码与独立 stdout 行，并增加四项回归测试。旧检查日志里的 PASS 字样不能作为 shell 成功证据。
- 默认 CLI smoke 改为不依赖操作系统命令的原生 `update_plan` 工具；需要严格返回 `Plan updated`。这验证真实工具协议闭环，不验证 shell。
- 独立 shell 检查仍保留：`node scripts/codex-smoke.mjs --shell`。必须在允许正常建立 Codex 沙箱的本机运行，不建议关闭沙箱来让测试通过。

## 尚待真实账号验收

- 两个独立账号并发时 Cookie、Tunnel、工具回执不串号。
- Codex 的 `exec_command`、freeform `apply_patch`、配置中的 MCP、图片结果。
- 长回答取消、等待工具期间取消、浏览器关闭、Tunnel 断线。
- 自动压缩以及多 agent 子任务。
- Windows / macOS 本机 Electron 启动与权限流程。
- Session 方式创建 Connector 的真实请求链与重复创建恢复。

当前没有用户已登录的浏览器、Tunnel key 或用户本机 Codex 环境；CI 的真实 Codex + 本地 fixture 不能代替以上真实账号验收。
