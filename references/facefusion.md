# FaceFusion 接入与使用合同

## 结论

FaceFusion 是咔嚓的显式候选处理器，不是默认全片滤镜。只在换脸、口型同步、人脸修复或真实低清后期修复能够解决明确问题时进入候选；身份处理不得自动执行。

入口：

```bash
node scripts/kacha.mjs facefusion probe
node scripts/kacha.mjs facefusion profiles
node scripts/kacha.mjs facefusion template --operation face_swap --output /absolute/plan.json
node scripts/kacha.mjs facefusion validate --plan /absolute/plan.json --for-execution
node scripts/kacha.mjs facefusion run --plan /absolute/plan.json --project-root /absolute/project
```

## 四种操作

| 操作 | 处理器 | 默认稳定 profile | 适用条件 |
|---|---|---|---|
| `face_swap` | `face_swapper` | `face-swap-release-candidate` | 已授权人物参考与目标素材，需要同一身份或明确创意换脸 |
| `lip_sync` | `lip_syncer` | `lip-sync-release-candidate` | 已有最终旁白，需要把获授权人物口型与音频同步 |
| `face_restore` | `face_enhancer` | `face-restore-natural` | 人脸因压缩、失焦或生成素材出现真实损伤 |
| `post_process` | `frame_enhancer` | `frame-postprocess-natural` | 画面存在可见压缩损伤、锯齿或低清，不用于普通全片重绘 |

Beauty v2 与 `face_restore` 不等价：Beauty v2 负责磨皮、美白、匀肤和法令纹；FaceFusion 人脸修复只补救真实画质损伤。

## 授权与许可门禁

每个计划只授权冻结哈希对应的输入和一次候选输出。执行前按 profile 要求填写：

- `canExecute`；
- 人脸身份处理的 `identityManipulationConsent`；
- 参考人物素材的 `sourceRightsConfirmed`；
- 目标人物的 `targetSubjectConsent`；
- 口型同步音频的 `voiceRightsConfirmed`；
- 修复处理的 `postProcessingAuthorized`；
- `modelLicenseReviewed`；
- 公开发布时记录 `disclosureDecisionRecorded`；
- `evidence` 写明授权证据。

本机 FaceFusion 服务默认模型中存在 Non-Commercial 模型。咔嚓稳定 profile 使用本机模型元数据中许可更明确的候选，但仍要求逐项目复核；不得仅凭 profile 名称推断商业合规。

## 执行与缓存

- API 必须是 loopback HTTP；Bearer token 只从权限为 `0600` 的文件读取，日志统一显示 `[REDACTED]`。
- 服务版本必须满足 profile 声明的最低版本。输入通过流式上传接口传给本机
  服务，不一次性把大视频读入内存，也不扩大服务允许读取的目录。
- 调度同时占用 `mps`、`videoEncode` 和 `ioHeavy`，避免与 Beauty、生成视频或正式编码争抢统一内存。
- 缓存指纹包含输入哈希、operation、profile、options、FaceFusion 版本和处理器清单；只复用哈希完整的候选。
- 输出写入新文件，并生成 `<output>.facefusion.json`；缓存命中也必须生成
  当前输出自己的 sidecar，源文件永不覆盖。

## 专项 QC

自动门禁检查输入/输出可解码、几何、有效帧率、音轨存在性和时长。人工必须
正常速度逐镜检查：

- 换脸：发际线、耳朵、眼镜、牙齿、侧脸、手部遮挡、边缘和身份跳变；
- 口型：爆破音、闭口音、元音张口、牙齿/嘴唇闪烁、胡须和遮挡；
- 人脸修复：眼睛、眉毛、眼镜、发丝、皮肤纹理、蜡感和身份变化；
- 后处理：振铃、锯齿、纹理幻觉、字幕变形、背景闪烁。

命令输出状态是 `candidate_requires_manual_qc`，不等于发布批准。
