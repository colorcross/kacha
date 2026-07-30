# Inventory 阶段紧凑合同

目标：只建立可信输入与能力证据，不开始创意渲染。

- 源文件只读；记录绝对路径、SHA-256、时长、宽高、SAR/DAR、声明/平均 FPS、
  音轨和采样率。输出永不覆盖源。
- 先判断任务是完整制作还是 v3 增量返工；增量返工必须锁定 baseline、delta
  和 artifact index。
- 真人口播先运行 `separate_dialogue.sh`；它通过内容指纹缓存复用 Demucs 结果，
  候选仍需同响度 A/B 和残余人声检查。
- 转写运行 `kacha.mjs transcribe`。音频是字幕事实源，原稿只作专名、数字和语境
  校准；只把语义 cue 与低置信度段送给模型，完整逐词 JSON 留在文件中。
- 重型 MPS、4K 编码、网络和 I/O 必须经过资源池；不得并发多个 MPS 或多个完整
  视频编码。
- 本阶段产物：source inventory、capability snapshot、ASR、分离 stem、项目状态
  snapshot。缺输入、失效 hash 或能力不可用时阻断，不静默换后端。

稳定入口：

```bash
node scripts/kacha.mjs doctor --profile full
node scripts/kacha.mjs transcribe INPUT --output transcript.json
node scripts/kacha.mjs prepare --task source_edit --stage inventory --source INPUT
```
