# 咔嚓 MCP

咔嚓 MCP 是本机 `stdio` 控制面。每次启动必须绑定一个绝对 `--root`，所有 Timeline、Project Bin 和项目状态访问均限制在该根目录内。写操作继续走 Timeline SHA、字段/操作白名单、Command Journal、快照和 undo/redo；MCP 不能整项目覆盖，也不能把 Canvas 预览提升为最终渲染证据。

生成客户端配置：

```bash
node scripts/kacha.mjs mcp-config show --client codex --root /absolute/project
node scripts/kacha.mjs mcp-config show --client claude --root /absolute/project
```

检查本机客户端能力：

```bash
node scripts/kacha.mjs mcp-config validate --client codex --root /absolute/project
node scripts/kacha.mjs mcp-config validate --client claude --root /absolute/project
```

显式注册（检测到同名配置时拒绝覆盖）：

```bash
node scripts/kacha.mjs mcp-config install --client codex --root /absolute/project --apply
node scripts/kacha.mjs mcp-config install --client claude --root /absolute/project --apply
```

协议实现同时服务当前 `server/discover` 客户端与仍使用 `initialize` 的旧客户端；标准输出只写逐行 JSON-RPC，诊断信息写标准错误。
