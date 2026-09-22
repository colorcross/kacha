# 叙事与执行新版合同

适用于 `editorialPolicy.version=narrative-v1` 的新工程。旧工程缺少该字段时仍按 legacy 校验，不自动重算或省略已批准效果。本文覆盖旧文档中的通用数量下限和“J/L 仅候选”说明；其余安全、身份、许可与审片要求继续有效。

- 必需表达包括用户要求、事实证据、真实操作结果；不得降级。条件增强记录条件与是否触发，可选装饰记录采用/省略理由。需求文件绑定 SHA，各必需项映射到真实时间线对象。没有实际素材时不能让叙述或示意冒充证据。
- 主开场可以由真实动作/问题完成，须有唯一叙事落点与当前预览；不再以通用效果数、机制数、SFX 数或每项清单配声作为目标。密度上限、人物/字幕保护、阅读时间、呼吸空间和正常速度审片保留。
- `production-quality template --editorial-policy narrative-v1 --requirements FILE` 和 `visual-capabilities template --editorial-policy narrative-v1 --requirements FILE` 必须采用同一需求身份。新项目默认新版；空需求模板不能过计划门禁。
- `craft compile --timeline FILE --operations FILE --output NEW_FILE` 编译已明确选择的 reading-hold、reaction-hold、proof-reveal、natural-sound、j-cut、l-cut。每项须有源身份、cue、理由与证据。具体 schema/边界见 `docs/OPTIMIZATION_EXECUTION_V5.md`。候选导演计划本身仍不代表执行。
- 阅读/反应停留只能扩展真实源段；缺 handle 不能冻结/重复帧。J/L 分别编译剪口两侧音频与独立 stem，需完整遮盖音画分离范围，并按源时间重建字幕。当前自动编译只支持硬切、单源、尚无独立 dialogue 的工程；不支持的组合明确阻断并保留原工程。
- Studio 的“生成真实声画预览”走 Timeline IR + jobs。快速画布仍是近似投影。预览绑定 timeline、源/资产、配置和实现，过期结果不替换当前版本；相同请求复用，连续点击防抖。任务失败按 jobs 日志显式恢复。
- `netstyle compile-unified` 仅加工效果区间并缓存局部合成，再用 Timeline IR 统一终编；普通间隙不单独转码。旧网感局部渲染器当前只支持已验证 SDR 8-bit 4:2:0，其他色彩/位深不得静默降级。简单统一终编支持保留 10-bit 与颜色标签；复杂高位深/HDR 组合尚未放行。
- 确定性适配器使用现有 efficiency + jobs + resources + telemetry。首批 media_probe、transcript_index、audio_analysis、styleframe。不自动重试付费或不明状态任务，不新增并发槽位。
- `observe` / `status --quick` 只读观察，不允许执行。新生产工程冻结运行包；旧工程只能显式绑定/迁移，保留旧版本。无需另一个 Agent 同步才能运行已绑定包。
- 真实用量按字段区分 measured/estimated/unavailable；现金引用账本并按条目去重，未对账不记为零。工程通过不能证明成片观感、生产收益或人工验收。
