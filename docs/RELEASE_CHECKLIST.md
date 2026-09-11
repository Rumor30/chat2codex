# 从 Beta 到成熟版本的验收门槛

测试数量和 CI 通过不能代替真实账号验收。本表未勾选部分必须有明确环境、版本和可复现结果后才更新。

## 已实现的自动验证

- [x] 本地 Node 核心、HTTP/SSE、进程取消、状态持久化和恶意输入测试。
- [x] Linux / Windows / macOS 核心 CI。
- [x] 锁定上游依赖、TypeScript 导出和 Bun 构建检查。
- [x] 真实 Codex 0.154.0 + 本地 fixture 的工具调用/回执/最终回答，以及 config/auth 文件不变。
- [x] 实际 Chromium 经本地 HTTP 网关的管理台操作、密钥清空和窄屏检查。
- [x] 实际 Electron 41.10.7 的空白账号启动、隔离 descriptor 和控制接口鉴权（正常沙箱）。
- [x] 实际 Chromium 合成 Connector 表单的准确填写、创建门槛和不重复提交检查。

## 发布前真实账号验证

- [ ] 授权账号首次登录 → Tunnel → 当前真实设置页 → 扫描工具 → Connector 权限 → MCP 探针。
- [ ] High、Pro 等实际可用模型分别验证，不静默降级或串用已验证状态。
- [ ] 两个真实账号同时执行不同项目，Cookie、Tunnel、工具参数和回执完全隔离。
- [ ] Codex 执行 shell、freeform apply_patch、已配置的 MCP 和图片回执，结果与真实项目一致。
- [ ] 连续长任务、压缩、多 agent、客户端取消、等待工具时断线、浏览器关闭和重新登录。
- [ ] 身份/工作区切换不能继续使用旧会话/旧验证结果。
- [ ] 创建 Connector 超时后核对已有服务，不重复创建、不误选同名服务。
- [ ] Windows、macOS、Linux 的本机首次安装、升级、卸载与登录资料保留流程。
- [ ] 对外发布的签名安装包、回滚、离线校验和受支持版本矩阵。

实际 Electron 启动的 CI 结果见 VALIDATION.md；它使用新建的空白 profile，不代表真实登录成功。真实账号测试应只导出安全状态和结果证据，不上传 session、密钥或包含它们的 HAR。
