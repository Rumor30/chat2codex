# Session 自动创建 MCP：未完成部分和验收标准

当前实现自动准备隔离目录、启动 worker、调用上游 DEV setup、检查运行环境，并提供真实 MCP echo 验证。**没有实现或验证用 ChatGPT session 直接在服务器创建 Connector。** 不把“页面里已经登录”当作创建成功，也不把 2FA 相关项目视为 Connector API 的证据。

下一步必须在一个用户正常授权的已登录 profile 中，观测一次真实创建流程，确认开发者模式/工作区权限、Connector 创建、工具扫描、会话附加和授权确认各自的成功依据。不能猜 `/backend-api/...` 路径，不能假设同源 fetch 自动满足额外的 authorization、CSRF、再认证或组织授权要求。

已规划的事务边界：

```text
登录已验证 → entitlement 已确认 → Tunnel 健康
→ 查询同一服务 identity 的现有 Connector
→ 创建一次或确认已有 → 扫描 tools → 附加到会话
→ 完成必要的用户授权 → 真实 nonce 工具闭环验证 → Ready
```

网络超时之后要先查询是否已经创建，不能直接回退 UI 再创建一次；这会导致重复 Connector。只允许同一账号、同一 workspace、同一服务 identity 内恢复，不能仅凭名称匹配其他服务。session、Cookie、CSRF token、完整认证 headers 不落入日志或导出的诊断。

安全确认、2FA、管理员批准和缺少 entitlement 都必须呈现为明确的用户操作/权限状态，不能通过私有请求强行开启。当前源码没有任何“无需授权、只给 session 就必定开好 MCP”的承诺。
