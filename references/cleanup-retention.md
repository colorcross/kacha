# 中间产物保留与安全清理

清理分成两个层级，不能把“导出完成”直接等同于“可以删除全部工程文件”。

## 1. 每次出片后的条件式例行清理

每次预览、版本渲染或正式成片处理完成后，可以评估中间产物并生成 dry-run 清单，但不自动删除。例行清理只允许删除同时满足以下条件的项目内产物：

- 已确认用户不需要保留该缓存；
- 已验证能够快速重建，并记录重建方法和预计时间；
- 可从仍保留的源文件、方案和脚本确定性重建；
- 不再被当前时间线、字幕、声音、蒙版、封面或下一轮返工引用；
- 分类属于缓存、渲染临时目录、重复预览、抽帧缓存或已拒绝测试片；
- 不包含当前版本或历史基线版本的唯一证据。

“可重建”不等于“适合删除”。生成一次需要长时间、付费 API、重新下载大模型、重新人工校准或重新审核的文件，不属于快速缓存，应继续保留。

例行阶段必须保留：

- 原始素材和外部授权素材；
- 当前及最近认可版本的成片、封面和字幕；
- NLE/时间线工程、proposal、edit plan、project manifest、release report 和 QC 报告；
- 转写、字幕校准日志、cut sheet、关键时间码和设计预检；
- 已批准的 dialogue/BGM/SFX 组件 stems 与最终 mix stem；
- 仍可能用于返工的蒙版视频、关键帧、生成镜头原件和许可记录。

## 2. 用户确认完成后的最终清理

只有用户明确说明“视频已经完成且不会再修改”，并把原话、确认时间及 `noFurtherEdits=true` 写入清理方案后，才允许使用 `mode=final`。

最终清理可额外删除代理文件、蒙版缓存、渲染分片、中间编码、临时音频、临时叠加层和已拒绝生成候选，但仍永久保护：

- 用户原始素材；
- 最终发布视频、封面、字幕和交付哈希；
- 最终 proposal、edit plan、project manifest、release/QC 报告；
- 工程文件、字体/素材许可和生成任务来源记录；
- 用户指定保留的任何文件；
- 经批准的独立人声 stem，除非用户另行明确授权删除。

## 3. 执行门禁

```bash
node scripts/generate_cleanup_plan.mjs \
  project-context.json artifact-index.json \
  --output cleanup-plan.json
node scripts/cleanup_project.mjs cleanup-plan.json
node scripts/cleanup_project.mjs cleanup-plan.json --apply
```

生成器只从 artifact index 挑出当前无引用、`userNeeds=false` 且符合当前模式
重建成本的候选；它不会删除文件。第二条盘点并写 dry-run 报告，第三条才对
已经通过门禁的精确相对路径执行删除，不接受 glob、未解析变量、项目根目录、
用户主目录或项目外路径。没有 `--apply` 就不会删除任何内容。

清理前必须：

1. 核对项目根目录；
2. 核对所有候选的真实类型、数量和大小；
3. 核对候选不包含 protected path；
4. 核对 Git 状态和当前时间线/进程没有引用；
5. 保存 dry-run 报告；
6. final 模式复核用户明确确认。

清理后必须：

1. 复扫候选路径确实不存在；
2. 核对所有 protected path 仍存在；
3. 记录实际释放空间和失败项；
4. 重新打开最终视频、封面和工程文件；
5. 把清理报告放入 release package。

没有精确清单时不删除；无法证明可重建或不影响返工时默认保留。
