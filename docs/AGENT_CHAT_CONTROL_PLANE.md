# Agent 对话控制面

咔嚓的默认操作方式仍然是和 Codex 或 Claude Code 对话。新增控制面把五类
容易消耗上下文、阻塞对话或产生版本漂移的问题下沉到本地脚本：

| 能力 | 解决的问题 | Agent 获得的结果 |
| --- | --- | --- |
| Mutation Delta | 小修改反复传整份 timeline | 变化对象、路径、层和 Token 估算 |
| 本地语义素材搜索 | 靠文件名翻目录、容易插错素材 | 带许可与匹配理由的 `@asset` 候选 |
| 异步任务与 Placeholder | 生成、分离、渲染阻塞当前对话 | 可恢复 `@job` 与 ready 产物证明 |
| 对象级 `@` 引用 | “那个卡片/刚才素材”容易歧义 | 绑定文件 SHA 与 JSON Pointer 的短引用 |
| 安装同步状态 | 源码改了但 Agent 仍用旧 Skill | Codex/Claude 的 current/out-of-sync 状态 |

生产不变量：

- Delta 终端窗口发生截断时必须自动落完整报告并公开遗漏数；
- macOS 使用本地 Apple NaturalLanguage 句向量，其他环境明确标记关键词回退；
- Job 参数不持久化密钥，cwd/产物不能经符号链接越出项目；
- 取消必须确认进程退出，旧 run 不得把终态反写成 ready；
- 失败任务恢复前隔离部分产物；
- Timeline IR 只接受 `ready + 当前产物 SHA-256` 的 Placeholder；
- 重复对象 ID 必须全部使用确定性后缀，不能因索引顺序改变引用指向。

用户不需要学习这些命令。Agent 根据自然语言自动调用；只有需要复现或调试时
才查看下面的接口。

## 最短示例

```bash
# 小变更，不把整份 after JSON 回填上下文
node scripts/kacha.mjs delta apply timeline.json mutation.json \
  --write timeline.next.json

# 搜索已授权的本机素材
node scripts/kacha.mjs media index --root ./assets \
  --output .kacha/media-index.json
node scripts/kacha.mjs media search .kacha/media-index.json \
  --query "城市夜景地标"

# 后台执行耗时任务并返回 placeholder
node scripts/kacha.mjs jobs submit --project-root . \
  --kind render --expected-output output/preview.mp4 -- RENDER_COMMAND

# 用稳定对象引用继续修改
node scripts/kacha.mjs refs index timeline.next.json \
  --output .kacha/object-index.json
node scripts/kacha.mjs refs resolve @overlay:card-1 \
  --index .kacha/object-index.json

# 只读检查双端安装
node scripts/kacha.mjs install status --agent both
```

完整协议、失败边界和 Agent 编排见
[`references/agent-chat-control-plane.md`](../references/agent-chat-control-plane.md)。
