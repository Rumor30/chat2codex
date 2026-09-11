# 故障处理

先运行 `node src/cli.mjs doctor` 或使用控制台“重新检查”。导出的诊断只有有限的时间、错误代码、账号本地 ID，不包含会话、命令或密钥。不要提交整个 profile、浏览器 Cookie、runtime key、auth.json 或未脱敏 HAR。

| 状态 | 处理方式 |
| --- | --- |
| dependency_missing / dependencies_required | 检查 Node 22+、Git、Bun 1.4.0 和 Codex CLI 是否安装且在 PATH 中。 |
| launcher_missing / launcher_upgrade_required | 关闭该项目旧窗口，运行 `npm run bootstrap`，重新打开独立账号窗口。 |
| launcher_login_required | 在对应账号窗口正常登录；不要把账号 A 的登录资料复制到 B。 |
| setup_required | 先在控制台配置此账号已经授权的 Tunnel ID/runtime key。 |
| tunnel_auth_required / tunnel_unavailable | 核对该 Tunnel 和 runtime key 的授权、网络及上游窗口里的 Tunnel 状态。不要反复重新创建 Connector。 |
| creation_needs_reconciliation | 上次创建结果不确定；打开设置核对已有 Connector，避免重复创建。 |
| tunnel_selection_required | 设置助手无法可靠识别精确 ID；在账号窗口手动选择正确 Tunnel。 |
| security_confirmation_required | 正常完成服务端安全确认、2FA 或管理员授权；助手不会代替这一步。 |
| model_not_verified / needs_mcp_probe | 针对准备使用的那个模型运行 MCP 探针。验证其他模型不算通过。 |
| thread_busy / account_busy | 等待或明确取消正在进行的任务/配置操作。 |
| worker_restarted / thread_uncertain | 原工具状态不能安全恢复；明确取消/释放后新建任务，不重放有副作用工具。 |
| storage_unavailable / journal_write_failed | 检查磁盘空间和目录权限，保留状态文件，修复后重启。不能删除所有路由数据来假装任务没有发生。 |

## Linux Electron 沙箱

若启动器立即退出，日志包含 `SUID sandbox helper ... mode 4755`，安装的 Electron 沙箱辅助程序缺少正常的系统权限。本项目不自动提权，不加入 `--no-sandbox`。

在**可信的本机源码和依赖**上，由管理员核对以下实际文件后设置正常的沙箱安装权限。不要将可写的陌生二进制提权；有组织管理策略时先让管理员按该策略安装。

```sh
helper="$PWD/.runtime/e85e3693fdb4e3e033348c08df0298c20fcdb612/launcher/node_modules/electron/dist/chrome-sandbox"
test -f "$helper" && test ! -L "$helper"
sudo chown root:root "$helper"
sudo chmod 4755 "$helper"
```

每次更新 Electron 后可能需要重新按正式安装方式配置。若仍有命名空间、AppArmor 或组织策略限制，不关闭安全功能；交给该机器管理员判断适用安装方式。CI 仅在一次性 runner 中配置该固定辅助文件。

无桌面服务器需要正常的桌面显示环境；本项目不是免浏览器的 headless subscription API。Linux 出现中文方框时安装系统 CJK 字体，例如发行版的 Noto CJK 包；字体不由此源码包分发。

## Windows 启动

双击 `start.cmd`，失败时窗口会保留。Bun 不在 PATH 中可设置 `CHAT2CODEX_BUN` 为其 exe 完整路径。Codex 的路径可用 `CHAT2CODEX_CODEX` 指向 `codex.exe` 或 npm 安装中的 `@openai/codex/bin/codex.js`。本项目不通过 `.cmd` shell 拼接模型参数。

## 不把测试失败掩盖为成功

`codex-smoke.mjs` 默认检查真实 Codex 的 `update_plan` 工具与 Responses 回执。`--shell` 是独立测试，必须有零退出码和正确 stdout 行才算成功。命令被策略拒绝、错误文本恰好包含 nonce、或沙箱启动失败都不是执行成功。此前 CI 的 shell 沙箱限制仍记录在验证文档，不关闭沙箱来刷绿。
