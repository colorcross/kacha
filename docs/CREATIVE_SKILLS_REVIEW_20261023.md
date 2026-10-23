# 四套创作工具接入：深度审查与修复

2026-10-23。审查对象为本次 creative 接入：合同、原生渲染、媒体回收、时间线衔接、诊断和安装。保留工作树中既有封面/栏目改动，不变更节目排期或实际内容。

## 已修复的问题

| 问题 | 影响与修复 | 验证 |
|---|---|---|
| Design 默认导出隐藏 `.title`、`.footer` 等通用类 | 正文可能在预览存在、视频消失；适配器显式 `--keep-chrome`，内容是否隐藏由创作源决定 | 原生生成含 `.title` 色块的视频，实际抽帧读取像素；`titlePreserved=true` |
| 媒体只检查平均帧率与头部帧数 | 平均 25 fps 的 VFR、带旋转标记或非方形像素可能被错误接收；改查实际视频包 PTS、包时长、显示比例和旋转 | FFmpeg 真实反例；旧检查接收 VFR/旋转，新检查拒绝，保留 before-after.json |
| WebM 不声明 `nb_frames` 被误拒绝 | 使用实际视频包计数；VP9 WebM 可保留原件并无损封装到 MP4 | 真实 WebM ingest、回执读取、25 帧与恒定时间检查 |
| 源目录和运行时共用忽略列表 | 源项目 `output/`、`out/`、`.om/` 可能漏拷；区分源与运行时，源资产目录完整冻结，已知必需文件不得落入依赖/缓存排除区 | `output/asset.txt` 回收与改动失效测试；art 引用被排除资产提前拒绝 |
| OM QA 返回码无法代表画面通过 | QA 发现单帧闪跳仍退出 0；改读 JSON，闪跳阻止回收；阅读停留/硬切保留语义审阅 | 闪跳反例拒绝、合法停留保留、原生 OM QA JSON 实测 |
| 依赖检测不完整 | design 缺 Python/Pillow、坏 Python override、缺 Node 模块可能晚失败；建包前检查，绑定所选解释器和模块；lint 使用合同画幅 | 缺失依赖与 runtime helper 漂移回归，四后端原生实测 |
| CLI 的托管 Python 遮住创作依赖 | 从 CLI 进入时优先找到不含 Playwright 的音频环境；改为沿 PATH 寻找兼容的已安装 Python，保留虚拟环境入口，显式 override 错误则直接报缺失 | 不兼容环境前置回归；原生烟测改用真正的 kacha CLI 提交作业 |
| 导入失败后状态查询只找异步任务 | ingest 失败包没有 job，查询报错而无恢复线索；加入 failure.json 和导入状态分支 | 不兼容编码实际回收失败，status 返回 failed/ingest，禁止覆盖重试 |
| 新叠层缺正式时间线的 evidence 字段 | 预览可用，后续正式验证还要补来源；现在随 receipt SHA 同时写入 evidence 路径 | 实际候选时间线合成及来源字段检查；仍保持 preview 与待审状态 |
| 回收/插入末端身份检查不完整 | 完成解码后和写候选前再次验证源、原件、工作画面与回执，补充适配器依赖绑定 | 现有篡改失效、原件保留与 Timeline IR 回归通过 |

非透明工作画面可无损重封装 H.264/HEVC/AV1/VP9/MPEG-4；透明为 ProRes/QTRLE/PNG。其它编码明确要求由原工具导出兼容格式，不静默有损转码。当前实测包括 H.264、VP9、ProRes alpha；未把编码白名单全部称为实测。

## 实际验证

- 专项回归：`TMPDIR=/private/tmp node --test tests/creative_skills_tests.mjs`，11 项通过，0 失败。含 FFmpeg 媒体生成、实际 Timeline IR 合成、插入区间前后像素检查、原人声音轨保留、alpha、越界/身份/fixture 拒绝。
- 最终代码经真正 kacha CLI 提交四后端原生烟测：全部成功，任务最终状态均为 succeeded，均为 1280×720、25 fps、100 帧；核验实际 PTS、无声画面与完整解码。Design 标题像素检查通过并实际查看 2 秒关键帧；Lemo 屏上文字原生阅读检查通过；OM 单帧闪跳检查通过。CLI doctor 四后端 missing 均为空。
- 静态检查和完整仓库门禁 `TMPDIR=/private/tmp make check-full` 通过，退出码 0：主套件 171 项通过、0 失败，专项套件、MCP、工作台分发和安装器测试通过。

证据目录：`output/creative-review-20261023/`。`targeted-tests.log`、`native-cli-tests.log`、`native-cli-final/summary.json` 和各原生 `receipt.json` 绑定本轮最终 CLI 产物；前期直接调用结果保留在 `native-final/`。`repros/before-after.json` 保存旧/新校验行为。之前接入验证保留在 `CREATIVE_SKILLS_VALIDATION_20261023.md`，本记录补充其后的修复。

第一轮全量检查遇到缓存命中断言失败；该轮测试期间继续修改了解释器发现实现，而缓存键包含 scripts 整体身份。停止修改后，`optimization_render_tests.mjs` 独立复跑通过；随后冻结代码重新执行完整门禁。失败日志保留为 `check-full.log`，独立复跑为 `optimization-render-recheck.log`，完整重跑为 `check-full-final.log`，未跳过或放宽测试。

## 验收状态与边界

完整门禁以 `check-full-final.log` 为准。双 Agent 安装通过现有原子安装器，安装状态与备份路径记录在 `output/creative-review-20261023/install-report.json`；最终源码/安装文件 SHA、两个 CLI doctor、目录及四个真实回执回读记录在同目录 `installed-readback.json`。只有安装报告为 applied、回读为 pass 才表示双安装完成。不覆盖已冻结的节目运行包，不更新四套第三方 skill。

这是工具能力的技术验收。四个样片是合成 fixture，未冒充正式节目或全部风格验收；完整节目仍须正常速度审片。代码与已声明依赖身份绑定不代表系统浏览器、字体、GPU、动态网络资源构成完全冻结或沙箱。创作工程使用许可明确的本地资产，实际审片仍要核对缺字、版式、叙事、阅读时间与最终声音。
