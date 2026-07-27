# 用一句话让 Agent 自动安装

咔嚓遵循 Agent Skills 的 `SKILL.md` 结构，同时支持 Codex 和 Claude Code。

目录和加载行为依据当前官方文档：[Codex Skills](https://developers.openai.com/codex/skills) 与 [Claude Code Skills](https://code.claude.com/docs/en/slash-commands)。

## 推荐：复制这句话给当前 Agent

```text
请帮我安装“咔嚓”skill：从 https://github.com/colorcross/kacha.git 获取最新版；先判断你当前是 Codex 还是 Claude Code，再检查并运行仓库的 scripts/install.sh，安装到对应的用户级 skills 目录。不要覆盖已有安装或修改，不要上传或提交我的任何本地文件、密钥和素材；如果目标已经存在，只报告现状，不做覆盖。安装后运行隐私扫描与回归测试，立即完整读取已安装的 SKILL.md 和任务所需 references，然后告诉我安装路径、版本、验证结果以及现在是否可以直接使用。
```

这段话要求 Agent 完成下载、安装、隐私检查、测试和当前会话加载。即使客户端尚未刷新 skill 列表，Agent 也可以通过直接读取刚安装的 `SKILL.md` 在当前会话使用。

## 原生安装位置

| Agent | 用户级安装目录 | 当前会话 |
| --- | --- | --- |
| Codex | `~/.codex/skills/kacha` | 安装后让 Codex 立即读取 `SKILL.md`；后续会话自动发现 |
| Claude Code | `~/.claude/skills/kacha` | 已存在 skills 顶层目录时支持热发现；首次创建顶层目录可能需要重启 |

不要通过软链接替代完整目录；直接 clone 可以减少不同客户端文件监听和索引行为的差异。

从旧名称迁移时，先把新版完整安装并验证到 `kacha`，再归档旧 `kacha-kacha` 目录；不要让新旧名称同时长期存在于自动发现目录中。

## 可选：直接运行安装器

Codex：

```bash
curl -fsSL https://raw.githubusercontent.com/colorcross/kacha/main/scripts/install.sh \
  | bash -s -- --agent codex
```

Claude Code：

```bash
curl -fsSL https://raw.githubusercontent.com/colorcross/kacha/main/scripts/install.sh \
  | bash -s -- --agent claude
```

同时安装：

```bash
curl -fsSL https://raw.githubusercontent.com/colorcross/kacha/main/scripts/install.sh \
  | bash -s -- --agent both
```

直接执行远程脚本前，应先查看脚本内容。更推荐上面的自然语言安装方式，让 Agent 先检查仓库和脚本再执行。

## 安装器的安全行为

- 使用 GitHub 公开源码归档下载，不读取 Git 凭据；
- 目标不存在时，先下载到临时目录，验证结构和隐私扫描后再移动；
- 目标已存在时保持不变，不覆盖已有安装或本地修改；
- 不读取、不复制、不上传用户项目、密钥、素材和现有其他 skills；
- Codex 安装不会修改 Claude Code 目录，Claude Code 安装不会修改 Codex 目录。

## 安装后怎么用

自然语言触发：

```text
用咔嚓先检查这批素材，给我一份详细剪辑方案，先不要改文件。
```

Claude Code 也可以直接输入：

```text
/kacha
```

Codex 可在提示中明确写：

```text
使用 $kacha 处理这个视频项目。
```

如果当前客户端没有刷新技能列表，直接让 Agent 完整读取安装路径下的 `SKILL.md` 即可在当前会话使用。
