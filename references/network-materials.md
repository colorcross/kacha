# 为当前视频找图、找视频并剪入

用户用自然语言说明需要什么画面即可。Agent 负责下面的记录、检索、选段和命令，不能把填 JSON 和手动下载转交用户。这条流程同时适用新大灰AI与明确指定的历史行者大灰工程；它不修改历史作品的品牌身份。

## 从具体缺口开始

先读当前节目、转写、导演素材缺口和 Timeline IR，查看当前段落。一个需求只绑定一个当前输出区间：说了什么、观众需要看懂什么、找什么对象/动作/地点/年代、事实材料还是示意、应保留哪些条件。不要把整篇旁白当搜索词，也不要仅用“科技感”“高级感”检索。已有证据足够就不增加素材。

```bash
node scripts/kacha.mjs network-materials request --timeline /PROJECT/timeline.json \
  --start 12 --end 16 --text '当前段落的实际旁白' --purpose '展示翻页动作，给论证换气' \
  --query 'hands turning book pages close up' --evidence-type illustration \
  --output /PROJECT/assets/reading-request.json
node scripts/kacha.mjs network-materials search --request /PROJECT/assets/reading-request.json \
  --provider commons --kind video --limit 3 --output /PROJECT/assets/search
```

支持 Commons（无需密钥）、Pixabay、Pexels。搜索先保存候选，不自动把排名第一项当匹配。必要时换中英文具体检索词、放宽画幅或查看原始发布者；每次1–5项。候选少或无结果时明确回到需求，不循环囤库。Commons逐文件读取作者与许可，视频优先长边不超过1920的版本；图片使用可剪辑的1920宽预览版本，实际尺寸以下载解码为准。

```bash
python3 scripts/fetch_stock_media.py --provider commons --kind video \
  --query 'hands turning book pages close up' --candidates /PROJECT/assets/search/candidates.commons.ID.json \
  --asset-id 12345 --limit 1 --output-dir /PROJECT/assets/downloads
```

`12345` 是实际搜索返回的 ID。可先预览候选来源页，再只下载选中的项。下载保存实际来源、作者、逐项许可、时间、SHA、解码结果；部分成功清单保留，失败项不会成为可用素材。

其他网络来源通过搜索工具查到原始发布页，核对可下载链接后使用 `--provider web --candidates FILE`。格式为：

```json
{
  "schema":"kacha.network-candidates.v1",
  "provider":"web", "kind":"photo", "query":"本次具体检索词",
  "items":[{
    "id":1, "download_url":"https://original.example/media.jpg",
    "source_url":"https://original.example/source-page",
    "creator":"实际作者", "license_url":"https://original.example/license",
    "usage_terms":"针对当前用途核对的条件", "fallback_suffix":".jpg"
  }]
}
```

这里的示例 URL 不能执行。不得以搜索引擎缩略图页代替来源，不绕过登录/付费/下载限制，不把任意网页交给视频下载器。需要付费素材时先完成可审阅选择，已有预算授权范围外再请用户决定。

## 看素材、确定选段、记录采用理由

```bash
node scripts/kacha.mjs network-materials select --request /PROJECT/assets/reading-request.json \
  --manifest /PROJECT/assets/downloads/manifest.commons.video.ID.json --asset-id 12345 \
  --output /PROJECT/assets/reading-selection.json
node scripts/kacha.mjs network-materials inspect --selection /PROJECT/assets/reading-selection.json \
  --output /PROJECT/assets/reading-frames
```

Agent 先在 selection 设置 `sourceIn`，再抽帧并实际打开图片查看；视频还须查看完整选段及动作的进出，必要时试听源音。抽帧本身保持 `pending`。记录 `observation`（实际看到了什么）、`matchReason`（与当前句子的具体关系）、`mismatch`（未解决问题）、真实审阅人和时间。主体、动作、地点/年代、观看方向、画幅与清晰度都要对照；不符就换候选或不用。

核原始来源与许可页后填写 `rightsChecked`、`usageConditions`、`attribution`；Commons 的 CC BY-SA 等条件逐项处理，作者署名不能被笼统的“来自网络”代替。`fullSelectedRangeViewed` 只在真的查看后填写。事实素材先用 `network-materials fact-template --selection FILE --output FACT.json` 创建待核对记录，填写来源快照 `sourceRecord`、定位、核对理由、审阅人和时间，再以 `review.sourceEvidence` 的文件身份绑定。记录须匹配本期工程、当前需求、素材SHA和具体论点；普通图库画面没有这个资格。示意填写 `disclosure`，在字幕/来源说明中落实标签；**该字段记录意图，不自动烧录文字**。

当前入口使用 `fit: contain` 保留完整画面、`audio: mute` 保持主视频人声。需要裁切、原声接力或音效时另用已有编辑与声音模块显式编排，不能假定已执行。视频选段必须足够长；不静默循环、定格或拿其他片段补足。

## 剪入与检查

```bash
node scripts/kacha.mjs network-materials validate --selection /PROJECT/assets/reading-selection.json --id reading-insert
node scripts/kacha.mjs network-materials apply --selection /PROJECT/assets/reading-selection.json --id reading-insert
node scripts/kacha.mjs timeline render --plan /PROJECT/timeline.json --output /PROJECT/output/reading-preview.mp4
```

实际渲染命令也可直接使用 `node scripts/timeline_ir.mjs render --plan ... --output ...`。`apply` 经已有 Command Journal 新增覆盖层，支持撤销/重做，固定源入点并使旧预览/终审失效。每次插入后，后续需求须基于新时间线建立；不能用旧区间映射批准新剪辑。

检查插入前、过程中和返回真人后的连续性，确认没有挡住必要证据、字幕可读、人声不断、选段没有多一帧/少一帧。大灰AI节目将 selection 的 path/SHA 放入 `editingBrief.networkMaterials`，在节目 beats 引用实际 overlay ID。时间线仍是唯一剪辑事实来源；素材选择文件不是第二条时间线。

在线检索、下载成功、技术渲染、语义适配、版权用途核对和全片终审分别记录。没有实际当前节目素材时，只能交付工具回归与演示，不能宣称某期已剪完。

接口依据：[MediaWiki Imageinfo](https://www.mediawiki.org/wiki/API:Imageinfo)、[TimedMediaHandler Videoinfo](https://www.mediawiki.org/wiki/Extension:TimedMediaHandler/API)。

### 观察帧、替换与工程交接

当前抽帧记录使用 `source-pts-v1`：观察时间来自选段内实际视频帧，并按容器起始时间换算为相对 `sourceIn`。单帧等极短选段可以重复同一有效帧，不向选段外取图。旧观察记录需要重新 `inspect`，再观看完整选段、核对用途与许可后审阅。

普通 Project Bin 的 `replace_media` 不能替换已绑定网络审阅的插镜，也不能直接把网络候选换进本地插镜。请为新素材重新建立需求、选择与审阅，通过 selection 插入；合并索引中包含的网络来源也按此处理。

不含媒体的合同包保留网络来源、署名与 selection 摘要，将本机审阅路径改为待绑定占位并标记 `requires_rebind`。接收方必须重新绑定素材及当前工程审阅；合同包不会复制本机的私有审阅证据或项目音效源文件。
