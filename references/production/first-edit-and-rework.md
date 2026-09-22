# first-edit-and-rework

本文件中的 scripts/、references/、docs/、config/ 均相对咔嚓根目录。按当前任务读取；新旧政策由项目合同决定。

## v2：首剪与结构重做

先建立真实 `editProposal`，至少锁定：

- 输入路径、媒体规格、哈希、只读状态和授权；
- 平台、受众、语言、时长、输出几何、格式、系列身份和交付物；
- 内容骨架、保留/删除/重排、切镜与连接策略；
- dialogue、字幕、视觉、BGM/SFX、封面、生成媒体、fallback 和 QC。

使用：

```bash
node scripts/kacha.mjs gate-plan project-manifest.json
scripts/capability_probe.sh --profile core --output capabilities.json
node scripts/kacha.mjs gate-render project-manifest.json
node scripts/kacha.mjs render project-manifest.json
```

十三阶段为：`inventory → transcript_structure → rough_cut →
dialogue_preprocess → connection_qc → fine_cut → visual_packaging →
subtitles → final_mix → cover → preview_render → final_qc →
release_package`。前一阶段没有证据，不得把后一阶段写成完成。
阶段完成证据必须是当前真实文件的 `{path, sha256}`；`next` 与
`.kacha/project-state.json` 共用这套状态机。proposal/edit plan/timeline、
能力合同或媒体合同变化时重置失效阶段；仅回填成片 SHA 不得误清空进度。

方案模板见 `examples/edit-proposal.json`、`examples/edit-plan.json` 和
`examples/project-manifest.json`。具体合同以 `references/project-workflow.md`
为准。

完整项目必须把 `plans.timeline` 登记为唯一时间线事实源。预览显式使用独立
输出，可加 `--range-start/--range-end`；正式 `render` 先通过
`gate-render`，再在一个 filter graph 中完成 EDL、画面、字幕和混音。纯音频
与封面返工继续走 v3 零视频编码路径。

## v3：增量返工

第一次进入增量模式时初始化稳定 context 和 artifact index：

```bash
node scripts/init_incremental_project.mjs BASE.mov \
  --project-id PROJECT --output-dir PROJECT_DIR
```

每轮反馈只创建一个 `version-delta.json`，记录版本意图、变化类型、变化层、
区间、验收条件和输出；冻结层由脚本推导，不复制整套旧方案：

```bash
node scripts/create_version_delta.mjs PROJECT_DIR/project-context.json \
  --write PROJECT_DIR/v2-delta.json --new-version v2 \
  --type beauty_adjust --output-video PROJECT_DIR/v2.mov

node scripts/create_incremental_manifest.mjs \
  PROJECT_DIR/project-context.json PROJECT_DIR/v2-delta.json \
  PROJECT_DIR/artifact-index.json --output PROJECT_DIR/v2-project.json

node scripts/kacha.mjs gate-plan PROJECT_DIR/v2-project.json
node scripts/kacha.mjs gate-render PROJECT_DIR/v2-project.json
```

影响级别由脚本推导，只能升级不能手工降级：

- `L0`：元数据/容器；
- `L1`：单层变化；
- `L2`：局部多层、切点或连接变化；
- `L3`：结构、顺序、时长或几何变化。

缓存复用必须同时匹配 artifact ID、内容指纹和依赖；显式复用请求不能绕过
本轮失效规则。`preview` 只用于样例，`candidate` 用于返工验收，
`release_candidate` 才能进入最终发布门禁。

返工禁止边试边整片导出。L0–L2 只允许 1–3 个代表区间探索，代表样例批准并
冻结 EDL/style/capability/audio digest 后，每个版本最多一次整片代理、一次
正式视频编码和一次完整 QC；完整 QC 只在 `release_candidate` 执行。同一
Render Graph 必须零编码复用，L0–L2 手工请求 `full_rebuild` 直接阻断。
所有返工渲染必须通过 `metrics run --workflow incremental --version-id ...`
记录 `render-scope`/`qc-scope` 并在执行前消费预算。

## 最小实现与验证闭环

1. 先做最小代表性预览：样式帧、1–2 秒跟踪片段、含 handle 的连接点或
   同源同响度音频 A/B。
2. 用户反馈参数冻结后再渲染受影响层；冻结层优先 stream-copy 或复用已验证
   artifact，禁止无意义重编码。
3. 完整候选视频始终检查存在性、哈希、完整解码、几何、FPS、时长和
   A/V 漂移。
4. 只改画面时比较基线与候选的音频 elementary-stream SHA-256；只改音频
   时比较视频流 SHA-256。哈希不一致就重新检查，不能继承旧结论。
5. 变化层执行专项探测和人工检查；L2 检查全部连接点及前后 handle；
   L3 执行完整重建与完整 QC。

```bash
node scripts/kacha.mjs qc PROJECT_DIR/v2-project.json
node scripts/create_incremental_review.mjs PROJECT_DIR/v2-project.json
node scripts/kacha.mjs gate-candidate PROJECT_DIR/v2-project.json
```

最终版本必须把 intent 设为 `release_candidate`，完成十一项当前版本人工证据：

```bash
node scripts/kacha.mjs gate-release PROJECT_DIR/final-project.json
```

自动报告中的 `pass_with_review` 不是全片通过；预览、候选、已渲染、自动 QC、
本地完整 QC、已上传和已发布必须分别表述。

## 缓存、指标与清理

高价值返工资产（校准字幕、dialogue stem、蒙版/跟踪、设计预检、付费生成）
进入 `artifact-index.json`。每轮可写运行指标：

```bash
node scripts/write_run_metrics.mjs PROJECT_DIR/v2-project.json \
  --output PROJECT_DIR/output/run-metrics.json
```

清理只先生成 dry-run：

```bash
node scripts/generate_cleanup_plan.mjs \
  PROJECT_DIR/project-context.json PROJECT_DIR/artifact-index.json \
  --output PROJECT_DIR/cleanup-plan.json
node scripts/cleanup_project.mjs PROJECT_DIR/cleanup-plan.json
```

例行清理只允许处理“用户不需要、当前无引用、已验证可快速重建”的产物。
最终清理还要用户明确确认项目完成且不再修改。源素材、基线/最终成片、工程、
方案、许可、QC/release 证据和批准 stem 始终保护。
