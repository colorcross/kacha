# 会话闭环 hooks（Stop Closeout Hook）

咔嚓可以把"发布合同"延伸到 Agent 会话层：注册后，每次 Claude Code 会话
结束时（Stop 事件），hook 会检查当前目录是否是一个咔嚓项目，以及该项目的
发布门禁是否走完。这是对 gate 命令的补充——gate 靠 Agent 主动执行，hook
由宿主在每次停止时强制运行。

## 行为

- **触发条件**：工作目录存在 `contracts/project-manifest.json` 且
  `kind === "kacha-project-manifest"`。其他目录一律静默放行，零干扰。
- **检查**（只有 `outputs.finalVideo` 指向的成片真实存在时才启动）：
  1. `outputs.releaseReport` 已声明且文件存在；
  2. 报告的 `finalVideoSha256` 与磁盘上成片的 SHA-256 一致——**成片在
     审片后被改动过，旧报告视为过期，必须重新审片**；
  3. `report.status === "approved_local_release"`——十一项人工检查全部
     通过；
  4. **fail-closed**：报告未绑定成片 SHA-256 时视为不可验证，同样阻断——
     不能用一份缺少绑定字段的报告冒充新鲜审片。
- **逃生门**：项目根或 `contracts/` 下存在非空 `unresolved.md`（缺口已
  显式记录）即放行。
- **防死循环**：同一会话同一规则连续阻断最多 2 次，第 3 次尝试即放行并把
  违规记录写入 `.kacha/hook-state/violations.jsonl`。计数按 `session_id`
  隔离，不会泄漏到其他会话。
- **性能**：成片 SHA-256 按（路径+大小+mtime）缓存，重复停止不重算大文件。

阻断时 hook 输出 `{"decision":"block","reason":"…"}`，其中包含明确的下一步
（运行 release-review、记录 unresolved.md，或重新审片）。注意 `.kacha/`
存放 hook 状态与观察台账，属本机缓存，建议加入项目 `.gitignore`。

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/colorcross/kacha/main/scripts/install.sh \
  | bash -s -- --agent claude --channel canary --hooks
```

或在本地仓库直接：

```bash
bash scripts/install.sh --agent claude --archive kacha.tar.gz --hooks
```

`--hooks` 只对 Claude Code 目标生效（Codex 没有 hooks 机制，会提示跳过）。
注册是**幂等合并**：往 `~/.claude/settings.json` 的 `hooks.Stop` 追加一条
命令，绝不删除或改写已有 hooks。可用 `KACHA_CLAUDE_SETTINGS_DIR` 覆盖
settings.json 所在目录。

## 卸载

从 `~/.claude/settings.json` 的 `hooks.Stop` 中删除包含
`hooks/check_closeout.mjs` 的条目即可；hook 脚本本身随 skill 安装，不单独
运行。

## 与咔嚓门禁的关系

hook 不替代任何 gate：`gate-release`/`release-review` 仍是唯一权威；hook
只在会话结束前提醒"项目里有一部已产出但未走完发布合同的成片"。缺口已经
记录（unresolved.md）或有意的暂停（strike 放行）都不会卡住工作。
