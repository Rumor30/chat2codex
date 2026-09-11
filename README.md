# chat2codex

把**真正的 ChatGPT 网页账号**接入一个本地 Responses 网关，再由 Codex 执行原生工具。

> **0.1.0 开发预览，不是已完成真实账号验收的成品。** 网关、管理台、调度和测试可以运行；浏览器桥接代码复用锁定版本的上游。当前不声称“仅导入 session 就自动创建 MCP”，也不拿 Codex OAuth 后端代替网页模型。

```text
Codex CLI  →  localhost /v1/responses  →  账号/线程调度
                                              ↓
                                  独立 ChatGPT Web profile
                                              ↓
                            ChatGPT MCP Connector + Tunnel
                                              ↓
                                   上游 TurnBroker
                                              ↓
Codex 本地工具  ←  Responses function/custom tool call
       ↓
工具回执  →  同一账号、同一网页工具轮次  →  最终回答
```

## 已实现与边界

| 部分 | 当前状态 |
| --- | --- |
| 多账号 metadata、隔离目录、启用/停用 | 已实现，有测试 |
| HTTP/SSE Responses、function/custom tool 回执、压缩路由 | 已实现，有本地 HTTP fixture 测试 |
| 线程粘性、完整并行工具回执、重启隔离、失败不跨号重放 | 已实现，有测试 |
| 本地账号管理台、鉴权、Origin/Host 检查 | 已实现；不是 Electron 安装包 |
| Codex 子进程临时 provider 配置 | 已实现；wrapper 不写用户 config.toml/auth.json |
| 每账号 Electron 登录和 Tunnel | 调用锁定上游的独立 DEV profile；需要本机安装依赖、登录及真实验证 |
| 真实 MCP echo 探针 | 已实现执行路径；必须在登录后的账号上实际通过，才标为 Ready |
| Session 私有接口自动创建 Connector | **未实现，接口及权限流程尚未实证；不猜 endpoint** |
| 两个真实账号并行、真实 Codex 文件修改、长任务压缩 | **未完成在线验收** |

“DEV profile”只用于隔离浏览器、配置和 Tunnel。生产请求只调用上游 adapter/Responses handlers，**不调用 `DevChatDriver.send`，不返回模拟 shell 或补丁成功回执**。

## 运行条件

网关使用 Node.js 22+，无 npm 运行时依赖。本地浏览器桥还需要 Git、**Bun 1.4.0**、桌面会话和可访问 GitHub / ChatGPT 的网络。上游依赖及 Electron 由 bootstrap 按锁文件安装。不要在无桌面服务器上把 browser worker 标为可用。

代码固定复用 `miuuyy/codex-chatgpt-web` 的 commit：

```text
e85e3693fdb4e3e033348c08df0298c20fcdb612
```

不自动跟随上游 main；唯一受控源码 overlay 将固定 DEV Tunnel 别名改为账号专属别名，防止两个账号占用同一 Tunnel runtime。代码、许可证保存在 `.runtime/<commit>/`，不复制用户现有 Codex 登录。源码升级后重新 bootstrap。

## 首次启动

```sh
git clone https://github.com/Rumor30/chat2codex.git
cd chat2codex
npm run bootstrap
node src/cli.mjs account add --label "账号 A"
node src/cli.mjs account add --label "账号 B"
node src/cli.mjs serve
```

管理台在 `http://127.0.0.1:7841`。另开终端运行以下命令获取**本地管理密钥**并粘贴到管理台；这不是 ChatGPT Cookie 或 OpenAI API key，不要发给别人：

```sh
node src/cli.mjs token
```

为每个账号使用其返回的 ACCOUNT_ID 打开独立窗口：

```sh
node src/cli.mjs account launch ACCOUNT_ID
```

在该窗口登录 ChatGPT，完成上游的 **Full harness** 设置。当前保留上游识别所需的精确 Connector 名称 **`Codex Native2 DEV`**，不要改成任意名称。各账号使用各自已授权的 Tunnel/Connector；不共享 Cookie。安全再认证、工作区管理员批准和工具写入授权由用户按正常流程完成。

已经准备好 Tunnel ID 和本机 runtime key 文件时，也可使用：

```sh
node src/cli.mjs account setup ACCOUNT_ID --tunnel-id tunnel_YOUR_ID --key-file /absolute/path/runtime-key.txt
```

key 文件内容是实际的 runtime key。不要把密钥作为命令行参数，也不要提交到仓库。这个命令配置上游隔离的 DEV runtime，**不等于已在 ChatGPT 服务端创建 Connector**。仍须完成窗口里的 Connector 创建/权限步骤。

在管理台点击“启动桥接”，刷新；出现账号可用模型后选择模型并运行“真实 MCP 探针”。也可运行：

```sh
node src/cli.mjs account verify ACCOUNT_ID --model chatgpt-web/high
```

探针真的经过网页 MCP → TurnBroker → Responses，执行一个无副作用的 nonce echo，再把回执交回网页。只有网页最终返回同一个 nonce 才通过。探针不执行 shell、读写项目或使用模拟成功回执。不要在已经服务用户任务的 worker 中反复探测；清理空闲会话后再探测。

## 接入 Codex

从该账号实际显示并通过验证的模型中选择，不保证每个账号拥有下列示例模型：

```sh
node src/cli.mjs codex --model chatgpt-web/high
node src/cli.mjs codex --model chatgpt-web/pro --account ACCOUNT_ID
node src/cli.mjs codex --model chatgpt-web/high -- exec "检查项目，不修改文件"
```

wrapper 使用 `-c model_providers.chat2codex.*` 和子进程环境变量传递网关凭据。密钥不在 argv。不会运行 Codex 的持久配置安装/迁移程序，不修改现有 `~/.codex/config.toml`、`auth.json` 或 Codex 安装文件。**Codex 自己运行时仍可能正常写入会话历史和日志**，这里不承诺所有 Codex 目录零写入。

当前 wrapper 采用进程级 V1 多 agent 兼容配置，仍须用目标 Codex 版本实测。桌面 Codex App 的启动注入和模型选择器集成没有完成；当前入口是 CLI，不声称所有 Responses 客户端均可即插即用。

## API 和生命周期

- `GET /v1/models`：仅汇总已启用且 Ready 的账号能力。
- `POST /v1/responses`：流式或非流式；输入和工具定义原样转发。
- `POST /v1/responses/compact`：转交上游原生形状的压缩处理器。
- `GET /v1/responses` / WebSocket Upgrade：明确返回 426，使用 HTTP/SSE。

除了静态管理页和不含账号信息的 `/health`，接口都需要 `Authorization: Bearer <local key>`。只监听 IPv4 loopback，不提供公开互联网部署、TLS、多租户授权或跨机器 worker 注册。

实际网页 adapter 需要原生 Codex 的 thread/turn metadata 和可信工作区上下文。网关认识 `previous_response_id`，但不能把不完整的任意客户端历史猜成一个 Codex 任务。使用新 Codex 任务；已有工具轮次不能热迁移到另一账号。

正在等待工具回执的线程不会让出账号。账号不可用、429、SSE 截断或 worker 重启时不自动换号重放，不伪造完成事件。浏览器动作已经发生但客户端状态不确定时标记 `uncertain`，需要明确取消/退役，而不是重试有副作用的工具。

停用账号只阻止新线程。每账号最多五个保留线程；不通过增加并发或轮换账号规避服务限制。完成后，可清理一个账号上的全部空闲会话以释放任务槽；需要重新运行探针：

```sh
node src/cli.mjs account disable ACCOUNT_ID
node src/cli.mjs account reset ACCOUNT_ID
node src/cli.mjs doctor
```

清理会话不会回滚 Codex 已执行的项目修改。网关重启或崩溃后的恢复采用保守隔离，不能保证无损恢复正在执行的工具。

## 检查

```sh
npm run check
npm test
npm run bridge:check   # 先完成 bootstrap；检查锁定上游的类型和导出
```

详见 [验证记录](docs/VALIDATION.md)、[安全边界](docs/SECURITY.md) 和 [Session provisioning 未完成项](docs/SESSION_PROVISIONING.md)。

许可证：新增代码 MIT；上游归属与锁定来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
