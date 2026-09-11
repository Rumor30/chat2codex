# 验证记录

## 0.2.0 本轮结果

记录日期：2026-09-11（CI 使用 UTC）。本地环境 Node.js 22.16.0 / Linux。

`npm run check` 通过；`npm test` **117 项通过、0 失败**。测试覆盖账号隔离、持久化操作、真实子进程取消、HTTP/SSE、逐轮工具回执、维护互斥、状态写入失败、线程释放/重放保护及身份接口的字段脱敏。

已读取代码提交 **`0978c2f00b2ed80a8686ba778ca7b2037b15c70b`** 的 PR workflow **`34619912951`**：**7 个作业全部成功**。

| 作业 | 实际验证内容 | 结果 |
| --- | --- | --- |
| core / Ubuntu | Node 语法和全部核心测试 | 通过 |
| core / Windows | Node 语法和核心测试；symlink 权限测试明确跳过 | 通过 |
| core / macOS | Node 语法和核心测试 | 通过 |
| pinned-bridge | 锁定上游安装、TypeScript、Bun 打包、不同账号 Tunnel 别名 | 通过 |
| native-codex-fixture / Ubuntu | 真正 Codex 0.154.0、完整模型目录、原生计划工具回执 | 通过 |
| native-codex-fixture / Windows | 同上，并验证 config.toml / auth.json 字节不变 | 通过 |
| desktop-integration / Ubuntu | 全量 Electron/renderer 构建、实际 Chromium 页面操作、实际 Electron 空白账号启动 | 通过 |

### 真实 Chromium 界面检查

通过 `scripts/ui-smoke.mjs` 启动真实浏览器，访问真实本地 Chat2Codex HTTP 服务。worker/模型/账号仍是明确的 fixture。验证了：一次性邀请、密钥不进浏览器持久存储、Tunnel 表单、敏感输入清空、账号名作为文本而非 HTML、锁定操作和 390px 窄屏无横向溢出。

同一作业还在实际 Chromium 中验证**合成 Connector DOM**：只填精确表单、选择正确 Tunnel ID、工具扫描门槛、不提前创建、禁用安全控件停下、歧义输入不提交。这不是 ChatGPT 服务端创建测试。

已下载并查看该作业的桌面/移动截图。截图显示“界面测试账号”，没有真实 ChatGPT 登录、Cookie 或账号信息。

### 真实 Electron 启动检查

`scripts/launcher-smoke.mjs` 在 Xvfb 桌面中实际启动安装后的 Electron 41.10.7，使用新建的空白独立账号目录。读取真实 descriptor，确认 development profile、预期 partition、本地设置扩展已挂载，未鉴权控制请求被拒绝。

本次检查使用 Electron 正常沙箱。CI 先把锁定依赖中的 `chrome-sandbox` 安装为 root 所有、4755 权限；没有加入 `--no-sandbox`。该过程只在一次性 CI runner 执行。本机源码安装是否需要管理员配置，取决于其正常系统安全策略。

**空白账号能启动不代表 ChatGPT 登录成功，更不代表 MCP/Tunnel 已连通。**

### 真实 Codex 协议检查

`scripts/codex-smoke.mjs` 使用实际 Codex 0.154.0，接收本地 fixture 模型生成的 Responses `function_call`，执行它自己注册的 `update_plan`，返回精确 `Plan updated`，再接收最终回答。完整公开模型目录通过 `-c model_catalog_json` 注入，支持当前的 `model_messages.instructions_template`。

测试核对原生 thread/turn metadata，以及测试环境预先放置的 `config.toml`、`auth.json` 字节不变。其模型端不是 ChatGPT；该检查不包含网页、MCP、真实模型推理或 shell。

## 本轮发现并修复的问题

1. 上游 launcher 所需的 `.launcher-runtime/browser-helper.cjs` 未生成；bootstrap 已补齐。
2. 原模板验证只接受旧 `base_instructions`，真实 Codex 新模板使用 `model_messages`；已兼容并加回归测试。
3. Linux Electron 正常 sandbox helper 缺少安装权限；CI 按正常方式安装，并给用户明确诊断。
4. 未成功启动的 owned Electron 子进程可能阻止退出；已增加有界退出，只处理本程序创建的子进程，不扫描/终止其他程序。
5. 释放线程后旧记录积累会消耗活跃容量；改为追加式哈希重放日志，测试超过 1000 次完成释放后的新任务接入。
6. 最终路由状态写入失败可能使异步 HTTP handler 崩溃；现在停止新增模型工作而保留控制台。
7. 一个模型探针成功被当作整个账号所有模型可用；现在逐模型授权并绑定登录身份和配置指纹。

## 明确没有完成的验收

- 真实授权账号的首次登录、实际当前 ChatGPT Apps DOM、Connector 创建与工具扫描。
- 完整 ChatGPT Web → MCP → Tunnel → TurnBroker → Codex → 工具回执 → 网页推理的真实用户任务。
- 两个真实账号并发、图片回执、真实 shell/patch、多 agent、长任务压缩和登录主体/工作区切换。
- Windows/macOS 本机 Electron 首次安装全流程、签名独立安装包和 Codex App 整体接入。

没有用户的已登录浏览器/Tunnel 授权环境，因此这些项目没有被写为通过；源码中的真实 MCP nonce 探针必须在本机实际通过后，网关才放行对应模型。

## 历史兼容性与不得误读的测试

0.1 的代码提交 `4cc81e425049a398a022f82d10af43f0e8f99feb`、PR run `34608302002` 六项检查曾全部通过。之后的结果必须按对应提交重新确认，本记录不推断未经检查的未来提交成功。

Codex 0.125.0 缺少当前网页桥要求的原生 turn metadata，不列为兼容版本。0.154.0 的独立 CI shell 检查曾遭遇 Linux bwrap 命名空间权限失败和 Windows 策略拒绝；未记为成功，没有关闭沙箱绕过。默认改用原生计划工具验证协议，`--shell` 仍作为独立检查保留。

早期 shell fixture 用 nonce 子串判断可能把“错误消息引用命令”误判为成功，已修正为**零退出码 + 独立 stdout 行**并增加回归测试。旧日志中的单独 PASS 字样不是 shell 成功证据。
