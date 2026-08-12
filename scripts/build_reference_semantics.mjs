#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const stable = (value) => JSON.stringify(value, Object.keys(value).sort());
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

const gallery = readJson(path.join(repoRoot, "design/reference-gallery/xingzhe-v3/manifest.json"));
const antiWeb = readJson(path.join(repoRoot, "config/design-system/anti-web.json"));
const components = readJson(path.join(repoRoot, "config/design-system/components.json")).components;
const scenes = readJson(path.join(repoRoot, "config/design-system/scenes.json")).scenes;
const implementations = readJson(path.join(repoRoot, "config/design-system/implementations.json"));
const registries = {
  component: new Map(components.map((item) => [item.id, item])),
  scene: new Map(scenes.map((item) => [item.id, item])),
  renderer: new Map(implementations.renderers.map((item) => [item.id, item])),
  layout: new Map(implementations.layouts.map((item) => [item.id, item])),
  motion: new Map(implementations.motions.map((item) => [item.id, item])),
};

// These are deliberate registry wrappers that share one visual implementation.
// Exact duplicate assets are allowed only when both sides declare the same
// equivalence group here; unrelated effects must still render differently.
const visualEquivalenceGroups = new Map([
  ["source-tag", ["component:source_tag", "scene:source_tag_scene"]],
  ["disclosure-tag", ["component:disclosure_tag", "scene:status_disclosure"]],
  ["subtitle-plain", ["component:subtitle_single", "scene:subtitle_plain"]],
  ["subtitle-bilingual", ["component:subtitle_bilingual", "scene:subtitle_bilingual_scene"]],
  ["subtitle-emphasis", ["component:subtitle_emphasis", "scene:subtitle_emphasis_only"]],
  ["subtitle-quote", ["component:subtitle_quote", "scene:subtitle_quote_scene"]],
  ["subtitle-correction", ["component:subtitle_correction", "scene:narrative_correction"]],
  ["subtitle-speaker", ["component:subtitle_speaker", "scene:subtitle_speaker_only"]],
  ["chapter-title", ["component:chapter_title", "scene:narrative_chapter"]],
  ["statement-title", ["component:statement_title", "scene:narrative_statement"]],
  ["text-behind-subject", ["component:text_behind_subject", "scene:text_behind_subject_scene"]],
  ["numeric-punch", ["component:numeric_punch", "scene:numeric_result"]],
  ["term-definition", ["component:definition_term", "scene:narrative_definition"]],
  ["quote-pull", ["component:quote_pull", "scene:narrative_quote"]],
  ["checklist", ["component:checklist_card", "scene:checklist_progressive"]],
  ["three-reasons", ["component:three_reason_card", "scene:info_three_reasons"]],
  ["caution-warning", ["component:caution_card", "scene:info_warning"]],
  ["subject-safe-popup", ["component:subject_safe_popup", "scene:ai_response_popup"]],
  ["screen-focus", ["component:screen_focus_callout", "scene:tool_click_focus"]],
  ["bar-chart", ["component:bar_chart", "scene:data_bar"]],
  ["before-after", ["scene:compare_two", "scene:compare_before_after"]],
  ["full-screen", ["scene:tool_screen_full", "layout:full_screen"]],
  ["screen-corner-pip", ["scene:tool_screen_pip", "layout:screen_with_corner_pip"]],
  ["moving-pip", ["scene:pip_shape_demo", "layout:moving_pip_safe_zones"]],
  ["corner-pip", ["scene:pip_rect_only", "layout:corner_safe"]],
  ["split-vertical", ["component:split_vertical", "scene:split_vertical_demo", "layout:two_panes"]],
  ["split-horizontal", ["component:split_horizontal", "scene:split_horizontal_demo", "layout:two_panes_subject_aware"]],
  ["scale-bridge", ["scene:bridge_scale_change", "layout:wide_to_medium_or_close"]],
  ["subject-ai-relationship", ["layout:subject_and_ai_symbol", "layout:two_role_relationship"]],
].flatMap(([group, keys]) => keys.map((key) => [key, group])));

const motionRows = [
  ["a_then_b","A/B顺序切换","A先建立并试听，切到B后只高亮B，不把两组同时当结果","ab-sequence"],
  ["after_conclusion","结论后进入","结论完整落地后，行动信息才进入且不抢最后一句","timed-entry-after"],
  ["all_clear_before_a_roll","回真人前全清场","所有PIP、卡片、字幕装饰在A-roll出现前3–5帧清空","preclear-all"],
  ["arc_draw","环形路径绘制","圆弧从起点沿单方向生长，当前扇区在峰值帧高亮","arc-progress"],
  ["audio_end","音频结束清场","最后一个可听音节结束帧即完成画面清场","audio-boundary"],
  ["before_next_event","下一事件前退出","当前题眼在下一事件前完整退出并让出视觉重心","preclear-event"],
  ["before_subject_reply","真人回应前退出","AI幕后回应在真人开口前清场，不把AI推到前台","preclear-reply"],
  ["branch_grow","分支路径生长","主干先出现，分支按条件逐条生长，结果节点最后点亮","branch-tree"],
  ["center_split","中线分屏揭示","中线从中心展开，两侧内容同时获得完整安全区","center-split"],
  ["claim_then_verdict","主张后判定","先显示待核验主张，再落位正确、错误或无法确认的判定","claim-verdict"],
  ["clean_cut","干净切","只在信息、情绪或视角变化点切换，不添加装饰遮罩","clean-cut"],
  ["clean_cut_or_push","干净切或轻推入","优先干净切；确有方向关系时才做一次克制推入","cut-push"],
  ["clear_before_a_roll","回A-roll前清场","附加画面在真人镜头出现前完整消失","preclear-a-roll"],
  ["collapse","聚拢收束","分散信息向语义重心聚拢并缩小淡出","collapse-center"],
  ["complete_then_fade","完成后淡出","最后一项完成并停稳后，整体才淡出","complete-fade"],
  ["converge","节点汇聚","已完成节点向最终结论汇聚，形成单一结果","converge-result"],
  ["count_or_scale","数字计数或放大","关键数字计数到目标值或从小到大停在100%","numeric-punch"],
  ["cursor_release","光标结束释放","最后一个字完成后光标停顿、熄灭，再退出文本","cursor-release"],
  ["cut","即时切换","当前语义边界即时替换画面，不引入闪白或黑场","instant-cut"],
  ["cut_on_audio_end","音频结束帧切","最后一个音节结束即切断画面，不保留空尾","audio-end-cut"],
  ["cut_on_phrase","语义短句切镜","在完整短句边界换景别，避免半句话被切断","phrase-cut"],
  ["cut_on_speech","口播起点切入","第一可听音节与目标画面同帧建立","speech-start-cut"],
  ["directional_reveal","定向揭示","沿前镜动作方向揭示新章节，方向不中途反转","directional-reveal"],
  ["draw_line","折线路径绘制","折线逐段绘制，转折点在峰值帧单独标记","line-draw"],
  ["fade","克制淡入淡出","短距离透明度过渡，不制造长时间半透明残影","fade"],
  ["grow_from_zero","从零增长","条形或数值从共同零基线增长，终值可比较","grow-zero"],
  ["highlight_result","结果高亮","仅最终结果改变颜色、描边或亮度，其他元素保持稳定","result-highlight"],
  ["highlight_segment","区段高亮","只高亮当前占比区段，整体环形和其他区段不闪","segment-highlight"],
  ["highlight_turning_point","转折点高亮","折线保持稳定，仅转折点出现光圈、标签或短促强调","turning-point"],
  ["highlight_winner_or_boundary","胜者或边界高亮","有明确胜者才高亮胜者；无胜者时高亮适用边界","winner-boundary"],
  ["hold_result","结果停稳","对比完成后保持同源同帧结果供观众核验","result-hold"],
  ["j_or_l_cut","J/L声音桥","声音跨越画面切点延续，隐藏固定机位删段的生硬感","audio-bridge"],
  ["label_then_title","标签后标题","栏目与期号先轻落位，主标题随后建立阅读重心","label-title"],
  ["line_grow","主线生长","时间线主线先沿单方向生长，事件节点随后落位","timeline-grow"],
  ["local_highlight","局部当前项高亮","只更新当前节点，已完成项降亮，未开始项保持静止","local-highlight"],
  ["mark_current_level","标记当前等级","证据阶梯全部可见，但只圈定当前证据等级","level-marker"],
  ["mask_reveal","遮罩揭示","遮罩边界沿对象或构图方向移动，峰值帧完整露出主题","mask-reveal"],
  ["matched_motion","动作匹配切","以相同方向、速度或形状的动作作为前后镜头接点","match-cut"],
  ["merge","分屏合并","两块画面向共同边界收束，最终回到单一主画面","split-merge"],
  ["natural_action","自然动作保持","保留真实动作本身，只做必要的镜头跟随和呼吸","natural-hold"],
  ["none","无附加动效","不添加装饰动画，依靠真实镜头和声音完成表达","none"],
  ["per_character","逐字输入","每个字按语音或输入节奏逐个出现，光标始终跟随","typewriter"],
  ["phrase_groups","短语分组进入","按语义短语分批建立，而不是整句同时弹出","phrase-groups"],
  ["pip_then_focus","PIP先入再聚焦","画中画边框先停稳，再放大或标注其中的关键区域","pip-focus"],
  ["progressive","逐项建立","同层级项目按口播顺序逐项出现，观众不能提前读完","progressive"],
  ["progressive_local","局部逐项建立","仅当前局部新增或点亮，禁止整屏随节点闪烁","progressive-local"],
  ["quote_then_source","引文后来源","引用先出现，来源在引用可读后再轻量补充","quote-source"],
  ["response_sync","回应同步进入","AI回应内容与对应语音或真人停顿精确同步","response-sync"],
  ["result_reveal","结果揭示","结果先形成完整信息差，再回到过程或真人解释","result-reveal"],
  ["result_tag","结果标签落位","A/B完成后用轻量标签标识结论，不覆盖波形或人物","result-tag"],
  ["return_to_dialogue","返回对话","核验信息收束后回到人机对话关系，不保留卡片残影","return-dialogue"],
  ["return_to_original","返回原画","美颜对比结束后回到原始画面作为可信基准","return-original"],
  ["return_to_subject","返回人物","插镜或全屏信息完成后平滑回到真人主画面","return-subject"],
  ["scale_fade","缩放淡出","组件轻微缩小同时淡出，锚点保持在信息重心","scale-fade"],
  ["shape_morph","形状变换","同一内容在圆形、方形或异形轮廓间连续变形","shape-morph"],
  ["short_fade","短淡出","6–10帧完成退出，切回主画面前不残留","short-fade"],
  ["short_wipe","短遮切","局部窄遮罩快速经过跳切区域，不覆盖整屏","local-wipe"],
  ["soft_pop","轻弹入","由96%到100%轻弹入并停稳，不做过冲弹跳","soft-pop"],
  ["speech_end","口播结束退出","当前语义最后音节结束后立即退出，不拖尾","speech-end"],
  ["speech_sync","口播同步进入","动效峰值与关键词对齐，允许最多2帧误差","speech-sync"],
  ["split_reveal","分屏揭示","两侧从共同分界线展开，并保持同一比较基准","split-reveal"],
  ["stagger","交错进入","同级元素保持固定节拍依次进入，先后顺序可读","stagger"],
  ["static","静态峰值","只定义稳定构图；如需视频化，仅允许极轻呼吸","static"],
  ["step_up","阶梯递进","证据或等级从低到高逐阶建立，当前阶梯明确标记","step-up"],
  ["strike_then_replace","删除后替换","错误文字先被划掉，再在同一阅读位置出现正确文本","strike-replace"],
  ["target_reveal","目标聚焦揭示","锚点锁定真实控件后，局部放大与说明依次出现","target-reveal"],
  ["task_card","任务卡落位","对话结论收束为一张轻量任务卡并停稳","task-card"],
  ["term_then_body","术语后正文","术语先成为题眼，正文和适用边界随后分层出现","term-body"],
  ["term_then_definition","术语后定义","术语先出现，定义在其下方进入并保持阅读层级","term-definition"],
  ["time_jump","时间跳切","明确显示时间跨度后切到新时点，避免伪连续","time-jump"],
  ["time_marker","时间标记","时间标签先建立跨越范围，再让事件画面接入","time-marker"],
  ["typing_or_soft_pop","打字或轻弹回应","文字型回应逐字出现；短标签型回应使用轻弹入","typing-pop"],
  ["visuals_clear_early","提前清场","插镜结束前3–5帧撤掉字幕和装饰，再回真人","preclear-visuals"],
  ["weight_color","字形与颜色强调","只对逻辑重音词改变颜色、字号或字距，不改变整句","word-emphasis"],
  ["wipe_compare","擦拭对比","同源同帧以可拖动分界线展示前后差异","wipe-compare"],
];

const layoutRows = [
  ["a_roll","真人主画面","人物完整居中或按原构图保留，字幕与常驻品牌各有安全区","subject-full"],
  ["corner_safe","安全角画中画","PIP进入远离人物头部、字幕和平台控件的角落","corner-pip"],
  ["editorial_left","左侧编辑排版","标题和说明占左侧负空间，人物保留在右侧","editorial-left"],
  ["footage_with_time_marker","带时间标记的插镜","全屏素材保留时间标记和来源，时间跨度可读","fullbleed-time"],
  ["full_bleed_event_photo","事件照片满版","事件照片满版展示，人物与标题不遮挡关键证据","fullbleed-photo"],
  ["full_bleed_footage","视频素材满版","外部视频满版展示，来源和字幕占用独立安全区","fullbleed-video"],
  ["full_screen","全屏信息舞台","主信息占据全屏但仍保留字幕、品牌和平台安全区","full-screen"],
  ["full_screen_or_subject_safe","全屏或人物避让","根据信息密度在全屏和人物侧边浮层之间自适应","adaptive-safe"],
  ["full_screen_with_pip","全屏内容加人物PIP","主内容全屏，真人缩小到不遮挡信息的角落","screen-pip"],
  ["local_band","局部窄带","只覆盖跳切或强调所在的局部窄带，不遮整屏","local-band"],
  ["lower_corner_safe","下角轻标签","来源或披露标签置于不与字幕冲突的下角","lower-tag"],
  ["moving_pip_safe_zones","移动PIP安全路径","PIP在多个安全角之间移动，全程避开头部与字幕","moving-pip"],
  ["negative_space","负空间题眼","文字进入人物旁的负空间，不压在脸和身体上","negative-space"],
  ["negative_space_behind_subject","人物后负空间","2–4字题眼位于人物后景层，仅发丝边缘轻遮挡","behind-subject"],
  ["negative_space_opposite_gaze","视线反向负空间","回应或信息进入人物视线反方向的空区","opposite-gaze"],
  ["portrait_subject_right_title_left","右人左题封面","人物缩小置右，主标题在左侧形成封面阅读重心","cover-right"],
  ["screen_focus","屏幕局部聚焦","屏幕主体保持完整，目标区域单独放大或描边","screen-focus"],
  ["screen_with_corner_pip","屏幕加角落人物","工具屏幕为主，真人PIP保留反应和叙事连续性","screen-corner-pip"],
  ["shared_motion_or_sound","动作或声音桥布局","前后镜头以共同动作方向或连续声音建立连接","bridge-layout"],
  ["split_cover","对比型封面","左右或上下同基准展示两个结果，标题不跨分界线","split-cover"],
  ["stack_left","左侧关键词堆叠","最多三组短词在左侧按层级堆叠，人物保持完整","stack-left"],
  ["subject_and_ai_symbol","人物与AI符号关系","人物与AI符号分居两侧，表现关系而非第二主持人","two-role-symbol"],
  ["foreground_evidence_occlusion","前景证据遮挡布局","让真实证据或前景物件穿过人物边缘建立前中后景；人物头脸、证据主体和字幕保持完整可读","foreground-evidence"],
  ["subject_negative_space","人物加负空间","根据人物位置把题眼放进相对空的一侧","subject-negative"],
  ["subject_safe_bottom","人物安全底部信息","纠错或说明位于人物下方且高于平台遮挡区","subject-bottom"],
  ["subject_safe_right","人物右侧信息区","定义或说明进入人物右侧，不压住头部和手部","subject-right-safe"],
  ["subject_safe_side","人物侧边信息区","自动选择人物左右更空的一侧放轻量内容","subject-side-safe"],
  ["subject_with_meter","人物加音频仪表","人物与A/B波形并存，仪表不遮脸和字幕","subject-meter"],
  ["subject_with_top_label","人物加顶部标签","顶部轻量栏目标签避开头部并保持低显著度","subject-top-label"],
  ["subtitle_safe","单行字幕安全带","单行金陵体字幕位于平台安全带上方，不超出屏幕","subtitle-safe"],
  ["subtitle_safe_two_lines","双语字幕安全带","英文主字幕在上、中文辅助在下，两行分别保持单行","subtitle-bilingual"],
  ["terminal_center","终端打字舞台","终端框位于负空间，人物缩小或让位且不被遮头","terminal"],
  ["two_panes","双画面并列","两块画面使用共同基准并列，分界线清楚但克制","two-panes"],
  ["two_panes_subject_aware","人物安全双画面","上下或左右分屏根据头部位置单独裁切，人物不被截头","split-subject-aware"],
  ["two_role_relationship","双角色关系布局","人物在前台，AI回应在幕后负空间建立关系","two-role"],
  ["wide_to_medium_or_close","景别变化桥接","同一机位在远、中、近景之间形成明显尺度差","scale-bridge"],
];

const rendererRows = [
  ["svg","静态矢量渲染","矢量输入直接输出可缩放SVG和峰值PNG","vector-output"],
  ["ass_svg","字幕渲染","真实字体、字幕安全区与ASS时序共同生成字幕成品","subtitle-output"],
  ["svg_sequence","状态序列渲染","entry、peak、exit三个可seek状态依次产出","state-sequence"],
  ["mask_composite","蒙版合成渲染","主体蒙版把文字或素材分到人物前后景层","mask-layers"],
  ["ffmpeg_overlay","画中画合成渲染","主画面与带边框PIP按安全位置叠加","overlay-pip"],
  ["ffmpeg_xstack","分屏合成渲染","多路画面按共同边界无损拼接并独立裁切","xstack-split"],
  ["timeline","时间线渲染","素材、字幕、动效和声音按时间线精确对齐","timeline-tracks"],
  ["svg_overlay","屏幕标注渲染","矢量锚点、引导线和标签绑定真实屏幕目标","vector-callout"],
];

const toMap = (rows) => new Map(rows.map(([id, label, intent, visualArchetype]) => [id, {
  id, label, intent, visualArchetype,
}]));
const motionMeta = toMap(motionRows);
const layoutMeta = toMap(layoutRows);
const rendererMeta = toMap(rendererRows);

function categoryPurpose(category) {
  return ({
    brand: "建立持续但克制的品牌识别",
    subtitle: "准确承载口播并维护阅读节奏",
    text: "把章节、判断、数字或术语变成清楚的视觉重心",
    card: "在不遮挡人物的前提下组织结构化信息",
    layout: "重新分配真人、素材与字幕的空间关系",
    data: "用可比较、可追溯的图形表达数据和关系",
    opening: "在黄金三秒内建立问题、冲突或结果差",
    narrative: "随论证推进强化当前语义重心",
    explainer: "把复杂信息按口播顺序逐步解释清楚",
    comparison: "用共同基准展示方案或处理差异",
    tool_ai: "把工具操作和AI回应作为证据而非前台主持人",
    bridge: "让删段、插镜和景别变化保持连续自然",
    netstyle: "以语义驱动的空间、参数和引导动效增强表达",
    ending: "收束结论并在音频结束帧完成退出",
    cover: "在横竖封面中建立栏目、期号和核心标题层级",
  })[category] ?? "为当前语义提供必要的视觉表达";
}

function baseMotion(category, id, states = []) {
  if (category === "brand") return {
    trigger: "首次建立栏目或来源识别时",
    entry: "6–10帧轻淡入或短位移进入，此后保持像素稳定。",
    hold: "全片低显著度常驻，不循环漂移，不与主标题争焦点。",
    exit: "片尾或场景明确结束时6–8帧淡出。",
    sfx: "默认无音效；只有首帧栏目建立时允许一次极轻tick。",
  };
  if (category === "subtitle") return {
    trigger: "对应语义单位开始发声时",
    entry: "以音频为准在语义起点建立；普通字幕不做装饰性入场。",
    hold: "单行金陵体、无底色无描边、60%阴影，逻辑重音只改局部。",
    exit: "对应语义单位结束即替换或退出，不拖到下一镜头。",
    sfx: id.includes("emphasis") ? "只有明确逻辑重音落位时允许一次轻tick。" : "无音效。",
  };
  if (id.includes("typewriter")) return {
    trigger: "文字内容需要跟随输入或口播逐字建立时",
    entry: motionMeta.get("per_character").intent,
    hold: "完整短句出现后停稳0.6–1.2秒，光标只做低频闪烁。",
    exit: "光标先消失，文字再于6–8帧内退出，并早于下一主信息清场。",
    sfx: "逐字输入使用轻微变化的本地键盘声，句末最多一次克制确认音。",
  };
  if (id.includes("behind_subject")) return {
    trigger: "2–4字短题眼构成章节或记忆落点时",
    entry: "文字按短语从人物后景层升起或从顶部落位，人物蒙版始终在文字前。",
    hold: "字距充分，每字至少85%可读，只允许发丝边缘轻遮挡。",
    exit: "6–10帧沿原方向退出，并在下一主信息前清场。",
    sfx: "大字停稳帧使用一次中等力度tonal hit或whoosh。",
  };
  return {
    trigger: `语义确实需要“${id}”时`,
    entry: states.includes("progressive") ? "子元素按口播顺序逐项建立。" : "8–12帧克制进入并绑定语义落点。",
    hold: "峰值停稳0.8–1.5秒，只保留当前信息。",
    exit: "6–10帧清场，早于下一主信息3–5帧。",
    sfx: "只在可见落位时使用一次匹配的功能性音效。",
  };
}

function semanticFor(entry, raw) {
  let meta;
  let relationships = {};
  let requiredVisualMarkers = [];
  let motion;
  let intendedOutcome;
  let peakFrame;
  if (entry.kind === "motion") {
    meta = motionMeta.get(entry.id);
    if (!meta) throw new Error(`缺少 motion 语义：${entry.id}`);
    intendedOutcome = meta.intent;
    peakFrame = meta.intent;
    requiredVisualMarkers = [meta.visualArchetype, raw.family, meta.label];
    relationships = { family: raw.family };
    motion = {
      trigger: `当前叙事明确需要“${meta.label}”时`,
      entry: meta.intent,
      hold: "峰值帧必须能独立看出动作对象、方向和当前状态。",
      exit: /exit|clear|return|audio|speech_end/.test(entry.id) ? meta.intent : "动作完成后停稳或按反向信息层级清场。",
      sfx: /cut|none|natural|static|hold/.test(entry.id) ? "默认无音效；有明确动作峰值时才补一次短促声音。" : "音效峰值绑定动作完成帧，不覆盖人声。",
    };
  } else if (entry.kind === "layout") {
    meta = layoutMeta.get(entry.id);
    if (!meta) throw new Error(`缺少 layout 语义：${entry.id}`);
    intendedOutcome = meta.intent;
    peakFrame = `峰值帧清楚展示“${meta.label}”的几何分区、安全区和人物关系。`;
    requiredVisualMarkers = [meta.visualArchetype, meta.label, raw.template];
    relationships = { template: raw.template };
    motion = {
      trigger: `内容关系需要“${meta.label}”而非单一A-roll时`,
      entry: "8–14帧完成构图重排；移动路径避开人物头部和主字幕。",
      hold: "所有内容区都完整可读，横竖版独立排版。",
      exit: "切回主画面前3–5帧完成附加元素清场。",
      sfx: "只有可感知的分屏、PIP或尺度变化才使用匹配whoosh；禁止用统一soft-pop把构图做成网页组件。",
    };
  } else if (entry.kind === "renderer") {
    meta = rendererMeta.get(entry.id);
    if (!meta) throw new Error(`缺少 renderer 语义：${entry.id}`);
    intendedOutcome = meta.intent;
    peakFrame = `峰值帧展示该渲染器独有的输入、处理结构和${raw.outputs.join("、")}输出。`;
    requiredVisualMarkers = [meta.visualArchetype, raw.adapter, ...raw.outputs];
    relationships = { adapter: raw.adapter, outputs: raw.outputs, requiresMedia: raw.requiresMedia };
    motion = {
      trigger: `生产链路调用 ${entry.id} 渲染器时`,
      entry: "输入、处理、输出三层按依赖顺序建立。",
      hold: "只点亮当前输出，其他状态保持稳定。",
      exit: "完成态收束为渲染产物，不闪屏。",
      sfx: "每个完成态最多一次轻tick，最终产物一次tonal resolve。",
    };
  } else if (entry.kind === "scene") {
    const entryMotion = motionMeta.get(raw.entry);
    const exitMotion = motionMeta.get(raw.exit);
    intendedOutcome = `${categoryPurpose(raw.category)}；触发条件是：${raw.trigger}。`;
    peakFrame = `峰值帧必须同时体现 ${raw.components.join("、")}，并采用 ${raw.layout} 布局；不能退化成与场景无关的通用卡片。`;
    requiredVisualMarkers = [raw.layout, ...raw.components, raw.trigger];
    relationships = { components: raw.components, layout: raw.layout, entryMotion: raw.entry, exitMotion: raw.exit, fallback: raw.fallback };
    motion = {
      trigger: raw.trigger,
      entry: entryMotion?.intent ?? `执行 ${raw.entry}`,
      hold: `峰值只保留“${entry.label}”所需组件，并让当前信息可读。`,
      exit: exitMotion?.intent ?? `执行 ${raw.exit}`,
      sfx: `${entryMotion?.label ?? raw.entry}的可见落位使用匹配功能音；退出默认不抢人声。`,
    };
    meta = { label: entry.label, visualArchetype: `${raw.category}:${raw.layout}` };
  } else {
    intendedOutcome = `${categoryPurpose(raw.category)}；“${entry.label}”只表达其注册槽位和状态。`;
    peakFrame = `峰值帧必须可辨识 ${raw.slots.join("、")} 槽位，并呈现 ${raw.states.join("、")} 中的峰值状态。`;
    requiredVisualMarkers = [raw.category, ...raw.slots, ...raw.states];
    relationships = {
      renderer: raw.renderer,
      fallback: raw.fallback,
      tokenRefs: raw.tokenRefs,
      presentation: raw.presentation,
    };
    motion = baseMotion(raw.category, entry.id, raw.states);
    meta = { label: entry.label, visualArchetype: `${raw.category}:${entry.id}` };
  }

  const equivalenceGroup = visualEquivalenceGroups.get(`${entry.kind}:${entry.id}`);
  if (equivalenceGroup) {
    relationships = { ...relationships, visualEquivalenceGroup: equivalenceGroup };
  }

  const semantic = {
    specId: `light-overlay.${entry.kind}.${entry.id}`,
    kind: entry.kind,
    id: entry.id,
    label: meta.label ?? entry.label,
    category: entry.category ?? raw.category ?? raw.family ?? raw.adapter,
    visualArchetype: meta.visualArchetype,
    expected: {
      intendedOutcome,
      peakFrame,
      requiredVisualMarkers,
      forbiddenVisualMarkers: [
        "与语义无关的通用白色网页弹窗",
        "遮挡人物头部、眼镜、主字幕或平台控件",
        "整屏闪烁或非当前区域同步变化",
        "未经说明的重复峰值构图",
      ],
    },
    relationships,
    motion,
    typography: {
      subtitle: "方正粗金陵简体",
      display: "青鸟华光标题黑体",
      supporting: "思源黑体 CN Light",
      cover: "Aa封神榜书",
      silentFallback: "forbidden",
    },
  };
  semantic.semanticDigest = digest(semantic);
  return semantic;
}

const items = gallery.entries.map((entry) => {
  const raw = registries[entry.kind].get(entry.id);
  if (!raw) throw new Error(`注册表缺少 ${entry.kind}:${entry.id}`);
  return semanticFor(entry, raw);
});

const output = {
  schemaVersion: "1.0",
  kind: "kacha_light_overlay_reference_semantics",
  style: "xingzhe-light-overlay",
  sourceGalleryDigest: gallery.digest,
  policy: {
    antiWebId: antiWeb.id,
    antiWebVersion: antiWeb.version,
    antiWebDigest: digest(antiWeb),
    triadMustMatch: ["expected", "peakFrameAsset", "motionContract"],
    duplicatePolicy: "只有 relationships 明确声明继承或场景复用时允许构图近似；否则视为异常。",
    cinematicSelectionOrder: antiWeb.selectionOrder,
    forbiddenPatterns: antiWeb.forbiddenPatterns,
    fontPolicy: "四套项目授权字体均可用于最终视频与图片发布；缺字、缺文件或哈希变化必须阻断，禁止静默回退。",
  },
  counts: Object.fromEntries(["component","scene","renderer","layout","motion"].map((kind) => [kind, items.filter((item) => item.kind === kind).length])),
  items,
};
output.counts.total = items.length;
output.digest = digest(output);

const destination = path.join(repoRoot, "config/effects/reference-semantics/light-overlay.json");
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ status: "pass", destination, counts: output.counts, digest: output.digest }, null, 2));
