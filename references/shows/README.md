# 栏目口播风格卡与语料库

本目录是"行者大灰"五个正式栏目的**口播风格卡**与**文案语料库**的入口。
风格卡约束稿件的腔调、句式与禁则；语料库积累真实成稿中可复用的表达片段。

栏目体系、期号与定位的最终事实来源是《行者大灰自媒体IP完整执行方案
V3.3》（仓库外私有文档，不在本仓库分发）。克隆/安装环境中请以各卡片内
已摘录的定位与禁则为准；不得在此恢复已取消的栏目名称。

## 五个正式栏目

| 栏目 | 风格卡 | 语料 |
| --- | --- | --- |
| 工具分享 | [tool-sharing.md](tool-sharing.md) | [../corpus/tool-sharing.jsonl](../corpus/tool-sharing.jsonl) |
| 解读好书 | [book-interpretation.md](book-interpretation.md) | [../corpus/book-interpretation.jsonl](../corpus/book-interpretation.jsonl) |
| 有限的无限游戏 | [infinite-game.md](infinite-game.md) | [../corpus/infinite-game.jsonl](../corpus/infinite-game.jsonl) |
| 灰常AI | [huichang-ai.md](huichang-ai.md) | [../corpus/huichang-ai.jsonl](../corpus/huichang-ai.jsonl) |
| 闲聊 | [casual-chat.md](casual-chat.md) | [../corpus/casual-chat.jsonl](../corpus/casual-chat.jsonl) |

## 语料 JSONL 格式

每行一个 JSON object：

```json
{"id": "tool-0001", "show": "工具分享", "episode": 1, "kind": "hook", "text": "……", "tags": ["开场", "问题引入"], "note": "可选备注", "sample": false}
```

- `id`：`<栏目缩写>-<四位序号>`，唯一；
- `show`：必须是五个正式栏目名之一；
- `kind`：`hook`（开场）/ `transition`（过渡）/ `judgment`（判断句）/ `ending`（结尾）/ `boundary`（边界与免责表述）；
- `text`：真实成稿中的原句（不要为语料编造句子）；
- `sample: true` 的条目只是格式示例，不可直接引用进成稿。

**积累原则**：语料只从已发布的真实稿件中摘录；发现跨栏目混用、过时表述
或与方案冲突的表达，先改风格卡，再清理语料。
