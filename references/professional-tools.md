# 专业工具辅助剪辑

Agent 先读 `docs/PROFESSIONAL_TOOLS.md`，向用户说明实际能力层级。使用已有软件，不自动购买订阅、接受新协议或上传素材。UI 操作用当前电脑工具并逐步观察；不使用盲坐标宏，不修改剪映私有数据库。

```bash
node scripts/kacha.mjs pro-tools detect
node scripts/kacha.mjs pro-tools detect --apps-root '/path/to/app-folder'
node scripts/kacha.mjs pro-tools prepare --tool after-effects --timeline timeline.json --output handoff-ae --title '可选标题'
node scripts/kacha.mjs pro-tools prepare --tool jianying --timeline timeline.json --output handoff-jianying
node scripts/kacha.mjs pro-tools status --package handoff-ae
```

准备通过现有 jobs 后台运行，复用主机编码资源锁。`status` 中准备任务失败时查 job 日志，保留失败产物；不能覆盖旧包来掩盖失败。当前要求单源、帧对齐基础 EDL、源与输出尺寸/帧率相同、固定帧间隔、方形像素、SDR、最多一条音轨。平均帧率匹配但实际为 VFR 的输入与回片也会拒绝。复杂字幕、转场、混音、tick 时间线或扩展 EDL 字段会拒绝，先用明确的基础片段工程，不私自剥离。

AE：确认 package 已准备，再在空白未保存工程里使用 File > Scripts > Run Script File 运行 `assembly.jsx`。已有工程受到保护。每个片段独立图层，可选标题为可编辑文本和透明度关键帧；中文字体与实际布局仍须在 AE 内复核。脚本保存 `assembly.aep` 和实际版本/输出模块回执。若文件写入权限未开启，明确告知需要在 AE 中操作该设置，不能绕过。

```bash
node scripts/kacha.mjs pro-tools render --package handoff-ae --output-module '实际回执中的输出模块名'
node scripts/kacha.mjs jobs status @job:ae-render --project-root handoff-ae
node scripts/kacha.mjs jobs cancel @job:ae-render --project-root handoff-ae
```

`render` 只在唯一明确的 AE 安装、可执行 aerender、当前版本回执及 AEP 都匹配时提交；冻结 AEP，复用 jobs 和主机资源锁。缺应用时不得以模拟回执或其他渲染器代替 AE 能力验证。取消/失败先核查进程及输出；已有渲染输出不覆盖，调整工程另建包。

剪映：在当前 UI 新建独立项目，按 `media/0001.mov` 起顺序导入。准备片段已经裁好，源内时间从零开始；不得按原始 sourceStart 再裁一次。确认画幅、帧率、音轨后精修，保存工程并导出。导入、编辑、保存重开、导出各留实际证据。第三方云资源、付费效果和字体仍按已有授权执行。

```bash
node scripts/kacha.mjs pro-tools receive --package handoff-ae --media exported.mov --output returned-candidate
```

回收复制外部输出，原时间线只读；验证视频总帧数、帧率、时长、几何、音轨存在性/声道和全片可解码，生成独立 `candidate.timeline.json` 与 receipt。回收视频是扁平化候选；可编辑图层保留在 AE/剪映工程，不伪造双向效果重建。技术通过不验证音频语义、字幕准确、字体、切点或审美；按当前节目合同进行正常速度带声音复核后，才可作为交付候选推进，旧审批不继承。

缺少专业软件时可完成媒体准备与回收代码测试，必须明确 `applicationVerified: false`。不得为了显示可用而写假安装、伪造 JSX 成功回执或把合成测试标为真实节目终审。

## 剪映增强任务

美颜、降噪、人声美化、画质提升、防抖、去闪烁、抠像、调色、转场、特效与跟踪按 `jianying-enhancements.md` 执行。`pro-tools capabilities` 查看任务目录，`enhance-plan` 将具体问题和片段绑定当前素材包；Agent 操作应用，CLI 不冒充剪映自动化 API。
