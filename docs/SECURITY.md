# 安全边界

服务默认且仅支持 `127.0.0.1`。管理与模型接口使用本地随机 bearer key；拒绝跨站 Origin、非 loopback Host 和 worker 重定向。不把浏览器 Cookie、OpenAI OAuth/登录 token 或 tunnel runtime key 放入账号 metadata、模型响应或前端存储。

Unix 状态目录/密钥使用 0700/0600；Windows 依赖用户目录 ACL，请在可信用户目录运行。这里不声称同一系统用户下的恶意程序不能读凭据。原生 Codex 的沙箱与审批不由网关替代；不要把管理台暴露到公网。

每账号独立 profile、worker key、broker 路径、Tunnel 配置。浏览器状态留在 Electron profile，程序不接收来历不明的 session/cookie 批量导入。只接入本人或获得授权的账号。账号配置不能创建额外的服务端 entitlement。

并行工具结果必须完整配对。客户端中断后的副作用不确定时，不重发、不切号、不假装失败的工具执行成功。取消只中止计算/传输，不会撤销已经发生的项目修改。

私有 Connector 接口尚未被验证，因此没有硬编码猜测 endpoint，也没有自动勾选永久写入授权、修改 2FA、跳过安全再认证或工作区管理员审批。

生产路径没有模拟工具执行器。测试 fixture 位于 test/，真实 MCP 探针只允许调用它自己声明的无副作用 nonce echo。所有非探针用户工具必须由外层 Codex 按实际授权执行。

进程锁不自动强抢。发现旧 lock 时先核实 PID 已退出，再由用户删除对应锁文件。这样避免第二个 worker 绑定到同一个浏览器和 broker。

上游固定 commit，bootstrap 只允许与仓库 `bridge/profile-constants.ts` 字节完全一致的受控 overlay，拒绝覆盖其他被修改的 tracked files。依赖安装会执行锁定依赖的安装脚本；只在可信机器上安装，升级前审阅变更。浏览器自动化属于非官方集成，仍受服务条款、账户权限和界面变化影响。
