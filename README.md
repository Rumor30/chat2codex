# Chat2Codex

**真正的 ChatGPT Web 账号池 → 本地 Responses API → Codex 原生工具。**

0.2.1 是带真实账号验收入口的 **Beta**。已实现账号管理、受保护的设置助手、逐模型验证、运行恢复和本地 session key 导入；核心协议、真实 Chromium 界面、实际 Electron 空白账号启动和真实 Codex CLI 使用独立测试验证。**已登录 ChatGPT 账号的最终生产验收仍需要在账号持有者自己的机器上运行 `acceptance:live`。** 验证证据和剩余发布条件见 [验证记录](docs/VALIDATION.md)、[Live acceptance](docs/LIVE_ACCEPTANCE.md) 与 [发布检查表](docs/RELEASE_CHECKLIST.md)。

```text
Codex CLI ── Responses HTTP/SSE ── Chat2Codex Gateway
                                      │
                              固定线程 → 固定账号
                                      │
                           独立 ChatGPT Web 浏览器
                                      │
                            MCP Connector / Tunnel
                                      │
                                 TurnBroker
                                      │
Codex 原生工具 ←── function_call / custom_tool_call
       │
       └── 工具回执 → 原账号、原网页工具轮次 → 最终回答
```

这里没有用 Codex OAuth 后端替换网页模型。生产路径不使用上游 DEV 模拟工具执行器。Codex 的沙箱与审批仍由 Codex 管理。

## 快速启动

先在本机安装 **Node.js 22+、Git、Bun 1.4.0**。需要可运行 Electron 的桌面环境以及正常访问 GitHub、ChatGPT 的网络。Codex CLI 当前明确测试的版本是 **0.154.0**；旧版 0.125.0 缺少这条网页桥需要的原生元数据。

```sh
git clone https://github.com/Rumor30/chat2codex.git
cd chat2codex
npm start
```

Windows 也可双击 `start.cmd`；macOS/Linux 使用 `./start.sh`。首次启动检查依赖并安装锁定的浏览器运行时，然后打开本地控制台。**这是源码启动包，不是已经内置所有依赖、签名发行的桌面安装器。** Linux 的沙箱和字体说明见 [故障处理](docs/TROUBLESHOOTING.md)。

默认地址为 `http://127.0.0.1:7841`，模型 API 为 `http://127.0.0.1:7841/v1`。自动打开使用一次性、60 秒有效的本地邀请；邀请随即从地址栏移除。打开失败或邀请过期时，运行以下命令取得本地管理密钥，再手动进入控制台：

```sh
node src/cli.mjs token
```

本地管理密钥不是 ChatGPT Cookie、session 或 OpenAI API key，不要将它交给其他人。

## 账号首次设置

在控制台添加账号后，按卡片的四个步骤完成：

**① 登录窗口。** 打开该账号独立的 Electron 窗口并正常登录 ChatGPT。Cookie 留在其独立 profile 内，不要求导出或上传。

**② 配置 Tunnel。** 填入已经授权的 Tunnel ID 和 runtime key，并确认配置。密钥经本地接口及配置子进程的 stdin 传递，不放入命令行参数、操作日志或浏览器持久存储。此处配置本地 Tunnel runtime，**不自动创建 OpenAI Platform 侧的项目或 Tunnel 权限**。

**③ 设置助手。** 复用同一个登录 profile 打开 ChatGPT Apps 设置。程序在明确识别到控件时填写连接器名称、匹配精确 Tunnel ID、选择认证方式并扫描工具。在可确认的表单上可提交创建；不确定的控件、同名服务、安全确认或上次创建结果不明时会显示“需要操作”，保留设置窗口供手动完成。

连接器名称仍需精确为 **`Codex Native2 DEV`**。只允许用户正常拥有的账号/工作区权限；助手不会绕过重新登录、2FA、管理员批准或永久写入授权。**当前真实网页选择器仍需通过登录账号验收；测试表单成功不意味着每个账号的实际设置页都匹配。** 细节见 [Session 设置机制](docs/SESSION_PROVISIONING.md)。

**④ 验证所选模型。** 选择账号实际显示的模型并运行 MCP 探针。它要求网页调用无副作用的 nonce 回显工具，再收到工具回执并正确回复。只有该模型通过才进入网关模型列表：验证 High 不会顺便放行 Pro。创建成功、已登录、Tunnel 已连接，都不等于模型工具回路已通过验证。

配置和验证在“配置进度”中显示，可取消；重启时未完成的操作会标为中断，不偷偷重复创建连接器。

## Session key 导入与真实验收

0.2.1 增加本机 live acceptance。验收脚本可以把本人授权账号的 session key 导入到指定账号的独立 Electron profile，然后立即通过该 profile 的 `/api/auth/session` 验证登录态。session 不经过 Responses 网关，不写入验收报告，也不允许作为明文命令行参数传入。

隐藏粘贴：

```sh
npm run bootstrap
npm run acceptance:live -- --account ACCOUNT_ID --model chatgpt-web/high
```

或从本地私有文件读取：

```sh
# macOS/Linux
chmod 600 /path/to/session.txt
npm run acceptance:live -- --account ACCOUNT_ID --model chatgpt-web/high --session-file /path/to/session.txt
```

输入可为 raw session key、包含 `sessionToken` 的本地 auth-session JSON，或受支持的 NextAuth/Auth.js Cookie header。只提供 `accessToken` 会被拒绝。已经登录的独立 profile 可用 `--use-existing-session`，有意更换已有 session 时才使用 `--replace-session`。

验收通过要求真实网页账号完成 MCP nonce 回路，然后真实 Codex 在隔离 workspace 中通过工具把一个随机 marker 精确写入磁盘，再由 Chat2Codex 从磁盘复核。完整说明见 [docs/LIVE_ACCEPTANCE.md](docs/LIVE_ACCEPTANCE.md)。

## 接入 Codex

从已经验证的模型中选择：

```sh
node src/cli.mjs codex --model chatgpt-web/high
node src/cli.mjs codex --model chatgpt-web/pro --account ACCOUNT_ID
node src/cli.mjs codex --model chatgpt-web/high -- exec "检查项目，不修改文件"
```

`chatgpt-web/high` 和 `chatgpt-web/pro` 只是示例，账号不一定拥有这些模型。wrapper 使用进程级 `-c` provider 和 `model_catalog_json`，模型目录保存在 Chat2Codex 自己的目录，密钥仅在 Codex 子进程环境中传递。

**不修改用户现有 `~/.codex/config.toml`、`auth.json` 或 Codex 安装文件。** Codex 自己正常运行时仍可能写入自己的日志与会话历史，不能理解为整个 Codex 目录绝对零写入。Windows 直接使用原生 exe 或 npm 的 JS 入口，不通过 `cmd.exe` 拼接用户任务参数。

当前正式接入入口是 CLI。通用 Responses 客户端、桌面 Codex App 的完整安装和模型选择器流程尚未完成独立验收。实际 adapter 要求 Codex 原生 thread/turn metadata、工具定义和工作区上下文。

## 日常管理与故障恢复

同一线程及其工具回执始终固定到同一账号。账号掉线、worker 重启、模型变更或响应中断时，不自动把可能执行过工具的任务重放到另一个账号。

新账号默认一个保留任务槽，可在管理台调到 1–5 个；多账号用于授权隔离与任务分配，不是额度耗尽后绕限制的换号器。完成后点“释放此线程”，立即释放该账号槽位。释放会保存线程哈希作为重放保护，不会让已完成任务永久占用活跃路由容量。

控制台提供重命名、停用、恢复、重启桥接、归档和脱敏诊断。停用只阻止新任务；归档不会删除登录资料。取消/释放不会回滚已经发生的项目文件修改。

```sh
node src/cli.mjs doctor
node src/cli.mjs serve --port 7841
node src/cli.mjs account list
```

通过 `CHAT2CODEX_HOME` 设置独立存储根目录。发现真实死进程的锁时可回收；活着或无法判断的进程锁不强抢。磁盘写入失败会阻止新增模型任务，控制台保留；修复存储后再重启和验证，不盲重试原工具轮次。

## 从 0.1/0.2 升级

先结束/取消并释放旧任务，关闭旧网关和该项目打开的账号窗口。保留 `~/.chat2codex`，不要上传其中的 Cookie、密钥或 profile。然后更新源码并重新安装 runtime 扩展；0.2.1 的 session 导入要求 bridge v4，因此 `bootstrap` 不能跳过：

```sh
git pull --ff-only
npm run bootstrap
npm start
```

已有账号记录与浏览器目录保留；新的 launcher/worker 身份和每个模型仍需重新验证。旧 `uncertain` 任务不得直接恢复执行，按控制台取消/释放后新建 Codex 任务。

## 开发与验证

```sh
npm run check
npm test
npm run bootstrap
npm run bridge:check
npm run test:ui

# 真实 Codex，模型端为明确的本地 fixture，不调用 ChatGPT
npm install --prefix .runtime/codex-smoke --no-save @openai/codex@0.154.0
node scripts/codex-smoke.mjs

# 独立 shell 检查；需要本机能正常建立 Codex 沙箱
node scripts/codex-smoke.mjs --shell
```

代码固定复用 `miuuyy/codex-chatgpt-web` commit `e85e3693fdb4e3e033348c08df0298c20fcdb612`。只对其固定 DEV Tunnel 别名做原始 Git blob 校验后的受控 overlay；其余扩展是独立入口文件。公开 Codex 模型目录及许可证同样校验固定 Git blob。不会自动跟随 main，也不会以升级名义覆盖用户修改过的运行时文件。

新增代码 MIT；上游与公开模型模板的归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。