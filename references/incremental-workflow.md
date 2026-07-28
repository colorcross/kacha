# 增量返工与缓存复用

整支首剪继续使用 v2 十三阶段。已有基线上的修改优先使用 v3：

```bash
node scripts/init_incremental_project.mjs BASE.mov \
  --project-id PROJECT --output-dir PROJECT_DIR
node scripts/create_version_delta.mjs PROJECT_DIR/project-context.json \
  --write PROJECT_DIR/v2-delta.json --new-version v2 \
  --type beauty_adjust --output-video PROJECT_DIR/v2.mov
node scripts/create_incremental_manifest.mjs \
  PROJECT_DIR/project-context.json PROJECT_DIR/v2-delta.json \
  PROJECT_DIR/artifact-index.json --output PROJECT_DIR/v2-project.json
node scripts/kacha.mjs gate-plan incremental-project.json
node scripts/kacha.mjs gate-render incremental-project.json
node scripts/kacha.mjs qc incremental-project.json
node scripts/kacha.mjs gate-candidate incremental-project.json
node scripts/kacha.mjs gate-release incremental-project.json
```

`preview`、`candidate`、`release_candidate` 必须分开。只有最后一种可以进入
完整人工审片和 release gate。

`project-context.delivery` 是稳定交付授权。delta 不能临时增加未声明的视频、
封面画幅或字幕语言；需要扩展交付范围时先重新锁定 context。

## 反馈归一化与同类扫描

每轮先把自然语言反馈归并为稳定配方，再创建 delta：

- `style`：统一字体、色板、弹窗、卡片、PIP、品牌、封面或运动风格；
- `timing_sync`：视觉动作或 SFX 与口播触发词/可见动作错位；
- `popup_layout`：弹窗遮头、字幕、品牌或平台 UI；
- `connections`：硬跳、双切点、短残片或不自然连接；
- 原有 `subtitles / bgm / sfx / beauty / color / insert_replace` 等配方继续使用。

这些配方会写入 `regressionScans`。修复一个实例后，必须以同一问题签名扫描
全片；不能只修用户点名的时间点，等待下一轮再次暴露同类问题。

风格由 `styleId + styleDigest` 标识。只改 token 时不重复转写、人声分离、
字幕校准或无关生成素材；但凡依赖旧 style digest 的视觉层、字幕层或封面必须
失效。完整 style 变化覆盖全片时使用 `full_rebuild`，不能误用局部 segment
渲染。

## 低成本返工顺序

1. 用反馈分类器确定配方、变化层和同类扫描签名；
2. 先生成 1–3 个最小代表性样例，只带必要 handle；
3. 参数批准后冻结 style/effect digest；
4. 只渲染失效层或区间，复用哈希一致的高成本产物；
5. 自动执行同类全片扫描；
6. `candidate` 只检查变化层、连接 handle 和冻结流证明；
7. 用户确定最终版本后才升级 `release_candidate` 并做完整 QC。

这样把“探索参数”和“整片渲染”分开，避免每次反馈都重新加载全部 reference、
重新分析全片和重编码冻结层。节省时间不能降低当前版本连接点、变化层和最终
发布门禁。

## 文件角色

- `project-context.json`：项目和基线的稳定事实；
- `version-delta.json`：本轮变化，不重复完整方案；
- `artifact-index.json`：产物依赖、指纹、成本和保留状态；
- `incremental-plan.json`：脚本推导的影响、渲染和 QC 方案；
- `delta-qc.json`：变化层检查与冻结层哈希证据；
- `incremental-review.json`：当前候选或最终版本的人工证据。

## 不变性证明

旧报告不能复制成新报告。只有同时满足以下条件，冻结层才能继承结论：

1. context、delta、基线和当前输出都有真实 SHA-256；
2. 变化层不依赖该冻结层；
3. 基线与当前输出对应 elementary stream 的 SHA-256 相同；
4. artifact 的工具、参数、尺寸、FPS、时间范围和依赖指纹一致；
5. 新报告明确记录继承来源和验证时间。

任何一项不成立就重新检查。

gate 会在 QC 后再次比较当前 context、delta、artifact index 和生成 plan 的
SHA-256。任何一个文件发生变化，旧 delta QC 和人工报告立即失效。

## 影响级别

- `L0`：元数据或容器；
- `L1`：单个媒体/交付层；
- `L2`：局部多层和连接点；
- `L3`：结构、时长、顺序或几何变化。

脚本可以把风险升级，不能手工降级。

## 最低检查

- 完整候选视频始终完整解码并检查几何、FPS、时长和 A/V 漂移；
- 冻结音频比较音频流哈希，跳过重复响度判定；
- 冻结视频比较视频流哈希，跳过重复视觉探测；
- 封面专项版本不触发视频渲染；
- L2 检查全部连接点及前后 handle；
- L3 和 `release_candidate` 执行完整 QC；
- 用户未确认最终版本时不生成虚假的完整 release report。
- `pass_with_review` 会自动把技术线索处置加入当前候选的人工清单；
- preview 不能通过 candidate gate，candidate 不能通过 release gate。

## 缓存保留

转写、校准字幕、dialogue stem、蒙版、跟踪、设计预检和付费生成素材默认是
高价值返工资产。只有 artifact index 证明用户不需要、没有引用且可快速重建，
才生成 routine 清理候选；生成清单不等于授权删除。

显式 `reuseRequests` 必须提供 artifact ID 与精确 fingerprint。请求命中仍不
能覆盖依赖传播的失效结果；变更类型判定该 artifact 已失效时直接拒绝。

## 分层测试

先跑本轮涉及的套件，再跑全量：

```bash
node tests/run_tests.mjs --suite incremental
node tests/run_tests.mjs --suite audio
node tests/run_tests.mjs --suite visual
node tests/run_tests.mjs
```

公开 core 与本机私有能力组合时使用 `sync_skill_installs.mjs` 先 dry-run；
脚本先扫描纯公开 core，再白名单应用私有 overlay、执行公开/私有回归，并在
`--apply` 后备份旧安装、原子替换和核对 Codex/Claude bundle hash。
