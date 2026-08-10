const state = {
  catalog: null,
  selectedStyleId: null,
  selectedVisualLanguageMode: "automatic",
  selectedVisualLanguageId: null,
  selectedOpeningId: null,
  selectedAudioPresetId: null,
  selectedBgmPresetId: null,
  selectedEffectDensity: "balanced",
  media: null,
  effects: [],
  generatedProjectPath: null,
  preflight: null,
  preflightSignature: null,
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Kacha-Studio": "1",
      ...(options.headers ?? {}),
    },
  });
  const value = await response.json();
  if (!response.ok || value.status === "blocked") {
    throw new Error(value.error || `请求失败：${response.status}`);
  }
  return value;
}

function toast(message, isError = false) {
  const element = $("toast");
  element.textContent = message;
  element.classList.toggle("is-error", isError);
  element.classList.add("is-visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("is-visible"), 3600);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function selectedStyle() {
  return state.catalog?.styles.find((style) => style.id === state.selectedStyleId);
}

function selectedVisualLanguage() {
  return state.catalog?.visualLanguages.find(
    (language) => language.id === state.selectedVisualLanguageId,
  ) ?? null;
}

function visualLanguageSummary() {
  return state.selectedVisualLanguageMode === "automatic"
    ? "自动按语义"
    : `${selectedVisualLanguage()?.label ?? "未选择"}优先`;
}

function audioPresetName(id) {
  return state.catalog?.audioPresets.find((preset) => preset.id === id)?.name ?? id;
}

function bgmPresetName(id) {
  return state.catalog?.bgmPresets.find((preset) => preset.id === id)?.name ?? id;
}

function showLabel(id) {
  return {
    "tool-share": "工具分享",
    "book-talk": "解读好书",
    "infinite-game": "有限的无限游戏",
    "very-ai": "灰常AI",
    "casual-chat": "闲聊",
  }[id] ?? id;
}

function platformLabel(id) {
  return {
    general: "通用",
    douyin: "抖音",
    xiaohongshu: "小红书",
    "wechat-channels": "视频号",
    bilibili: "Bilibili",
    youtube: "YouTube",
  }[id] ?? id;
}

function outputLabel(id) {
  return state.catalog?.outputPresets.find((entry) => entry.id === id)?.name ?? id;
}

function markContractDirty() {
  state.preflight = null;
  state.preflightSignature = null;
  state.generatedProjectPath = null;
  $("preflightPanel").hidden = true;
  $("resultPanel").hidden = true;
  updateReadiness();
}

function renderStyles() {
  $("styleList").innerHTML = state.catalog.styles.map((style) => `
    <button
      type="button"
      class="style-choice${style.id === state.selectedStyleId ? " is-selected" : ""}"
      data-style-id="${escapeHtml(style.id)}"
      aria-pressed="${style.id === state.selectedStyleId}"
      style="--choice-accent:${escapeHtml(style.design.overrides?.palette?.accent || style.caption.emphasisColor)}"
    >
      <small>${style.builtIn ? "BUILT-IN" : "CUSTOM"}</small>
      <h3>${escapeHtml(style.name)}</h3>
      <strong>${escapeHtml(style.tagline)}</strong>
      <p>${escapeHtml(style.description)}</p>
    </button>
  `).join("");
  document.querySelectorAll("[data-style-id]").forEach((button) => {
    button.addEventListener("click", () => selectStyle(button.dataset.styleId));
  });
}

function renderVisualLanguages() {
  const automaticSelected = state.selectedVisualLanguageMode === "automatic";
  const automatic = `
    <button
      type="button"
      class="visual-language-choice visual-language-choice--automatic${automaticSelected ? " is-selected" : ""}"
      data-visual-language-mode="automatic"
      aria-pressed="${automaticSelected}"
    >
      <small>RECOMMENDED</small>
      <h3>自动按语义</h3>
      <strong>五套语言并列路由</strong>
      <p>逐个语义拍匹配真实触发；没有合适信号时保持干净画面或普通字幕。</p>
      <span>内容 → 匹配 → 合同 → 回退</span>
    </button>
  `;
  const languages = state.catalog.visualLanguages.map((language) => {
    const selected = state.selectedVisualLanguageMode === "preferred"
      && state.selectedVisualLanguageId === language.id;
    const modifier = language.id.replace("xingzhe-", "");
    return `
      <button
        type="button"
        class="visual-language-choice visual-language-choice--${escapeHtml(modifier)}${selected ? " is-selected" : ""}"
        data-visual-language-mode="preferred"
        data-visual-language-id="${escapeHtml(language.id)}"
        aria-pressed="${selected}"
      >
        <small>PRIORITY GRAMMAR</small>
        <h3>${escapeHtml(language.label)}</h3>
        <strong>${escapeHtml(language.selectionRule)}</strong>
        <p>${escapeHtml(language.intent)}</p>
        <span>不适用：${escapeHtml(language.fallback)}</span>
      </button>
    `;
  }).join("");
  $("visualLanguageList").innerHTML = automatic + languages;
  $("visualLanguageList").querySelectorAll("[data-visual-language-mode]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        state.selectedVisualLanguageMode = button.dataset.visualLanguageMode;
        state.selectedVisualLanguageId = button.dataset.visualLanguageId || null;
        renderVisualLanguages();
        markContractDirty();
        updateSummary();
      });
    });
}

function renderOpenings() {
  $("openingList").innerHTML = state.catalog.openings.map((opening) => `
    <button
      type="button"
      class="opening-choice${opening.id === state.selectedOpeningId ? " is-selected" : ""}"
      data-opening-id="${escapeHtml(opening.id)}"
      aria-pressed="${opening.id === state.selectedOpeningId}"
    >
      <strong>${escapeHtml(opening.label)}</strong>
      <span>${escapeHtml(opening.trigger || "按开场语义使用")}</span>
    </button>
  `).join("");
  document.querySelectorAll("[data-opening-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedOpeningId = button.dataset.openingId;
      renderOpenings();
      markContractDirty();
      updateSummary();
    });
  });
}

function effectByKey(key) {
  return state.catalog.assignableEffects.find(
    (effect) => `${effect.kind}:${effect.id}` === key,
  );
}

function renderEffectLibrary() {
  const query = $("effectSearch").value.trim().toLowerCase();
  const group = $("effectGroup").value;
  const matches = state.catalog.assignableEffects.filter((effect) => {
    if (group && effect.group !== group) return false;
    if (!query) return true;
    return [effect.label, effect.group, effect.trigger, effect.id]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });
  const visible = matches.slice(0, 30);
  $("effectLibrary").innerHTML = visible.map((effect) => {
    const key = `${effect.kind}:${effect.id}`;
    return `
      <button type="button" class="effect-choice" data-effect-key="${escapeHtml(key)}">
        <small>${escapeHtml(effect.group)}</small>
        <strong>${escapeHtml(effect.label)}</strong>
        <span>${escapeHtml(effect.trigger || "按已注册条件使用")}</span>
      </button>
    `;
  }).join("");
  $("effectLibraryCount").textContent = matches.length > visible.length
    ? `找到 ${matches.length} 项，当前显示前 ${visible.length} 项；继续输入关键词可收窄范围。`
    : `找到 ${matches.length} 项生产可用效果。点击后再描述它应该出现的位置。`;
  $("effectLibrary").querySelectorAll("[data-effect-key]").forEach((button) => {
    button.addEventListener("click", () => {
      state.effects.push({
        positionDescription: "",
        key: button.dataset.effectKey,
      });
      renderEffects();
      const rows = $("effectAssignments").querySelectorAll(".effect-row input");
      rows[rows.length - 1]?.focus();
      markContractDirty();
    });
  });
}

function renderEffects() {
  const container = $("effectAssignments");
  container.innerHTML = state.effects.length
    ? state.effects.map((effect, index) => {
        const selected = effectByKey(effect.key);
        return `
          <div class="effect-row" data-effect-index="${index}">
            <div class="assigned-effect">
              <small>${escapeHtml(selected?.group || effect.key)}</small>
              <strong>${escapeHtml(selected?.label || effect.key)}</strong>
            </div>
            <input
              type="text"
              aria-label="第 ${index + 1} 个效果的自然语言位置"
              placeholder="例如：说到“品味决定上限”的时候"
              value="${escapeHtml(effect.positionDescription)}"
            />
            <button type="button" aria-label="删除第 ${index + 1} 组效果">×</button>
          </div>
        `;
      }).join("")
    : '<p class="empty-assignment">还没有指定效果。上方所有选项都来自咔嚓已注册的生产能力。</p>';
  container.querySelectorAll(".effect-row").forEach((row) => {
    const index = Number(row.dataset.effectIndex);
    const input = row.querySelector("input");
    input.addEventListener("input", () => {
      state.effects[index].positionDescription = input.value;
      markContractDirty();
    });
    row.querySelector("button").addEventListener("click", () => {
      state.effects.splice(index, 1);
      renderEffects();
      markContractDirty();
      updateSummary();
    });
  });
  updateSummary();
}

function applyPreview(style) {
  const palette = {
    canvas: style.design.overrides?.palette?.canvas || "#F7E8C9",
    surface: style.design.overrides?.palette?.surface || "#FFF8EA",
    ink: style.design.overrides?.palette?.ink || "#24150F",
    accent: style.design.overrides?.palette?.accent || style.caption.emphasisColor,
  };
  const preview = $("stylePreview");
  preview.style.setProperty("--preview-canvas", palette.canvas);
  preview.style.setProperty("--preview-surface", palette.surface);
  preview.style.setProperty("--preview-ink", palette.ink);
  preview.style.setProperty("--preview-accent", palette.accent);
  preview.querySelector(".preview-caption").style.fontSize =
    `${Math.max(10, style.caption.fontSizeRatio * 260)}px`;
  preview.querySelector(".preview-caption").style.textShadow =
    `0 2px 8px rgb(0 0 0 / ${style.caption.shadowOpacity})`;
  $("previewLabel").textContent = showLabel($("show").value || style.design.modes.show);
  preview.dataset.visualLanguage = state.selectedVisualLanguageMode === "automatic"
    ? "automatic"
    : state.selectedVisualLanguageId.replace("xingzhe-", "");
  $("previewLanguage").textContent = visualLanguageSummary();
}

function setRangeValue(inputId, outputId, value) {
  $(inputId).value = String(value);
  $(outputId).value = String(value);
  $(outputId).textContent = String(value);
}

function renderProjectAudioPresets() {
  $("projectAudioPresets").innerHTML = state.catalog.audioPresets.map((preset) => `
    <button
      type="button"
      class="preset-choice${preset.id === state.selectedAudioPresetId ? " is-selected" : ""}"
      data-audio-preset="${escapeHtml(preset.id)}"
      aria-pressed="${preset.id === state.selectedAudioPresetId}"
    >
      <strong>${escapeHtml(preset.name)}</strong>
      <span>${escapeHtml(preset.description)}</span>
    </button>
  `).join("");
  $("projectAudioPresets").querySelectorAll("[data-audio-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedAudioPresetId = button.dataset.audioPreset;
      renderProjectAudioPresets();
      markContractDirty();
      updateSummary();
    });
  });
}

function syncProjectTuningFromStyle(style) {
  state.selectedAudioPresetId = style.audio.presetId;
  state.selectedBgmPresetId = style.bgm.presetId;
  state.selectedEffectDensity = style.direction.effectDensity;
  renderProjectAudioPresets();
  $("projectBgmPreset").value = style.bgm.presetId;
  $("bgmEnabled").checked = style.bgm.enabled;
  $("projectBeautyEnabled").checked = style.beauty.enabled;
  setRangeValue(
    "projectSmoothing",
    "projectSmoothingOutput",
    style.beauty.tuning.smoothing,
  );
  setRangeValue(
    "projectWhitening",
    "projectWhiteningOutput",
    style.beauty.tuning.whitening,
  );
  setRangeValue(
    "projectTone",
    "projectToneOutput",
    style.beauty.tuning.toneEvening,
  );
  setRangeValue(
    "projectNasolabial",
    "projectNasolabialOutput",
    style.beauty.tuning.nasolabialSoftening,
  );
  document.querySelectorAll('input[name="effectDensity"]').forEach((input) => {
    input.checked = input.value === style.direction.effectDensity;
  });
  toggleProjectBeauty();
}

function toggleProjectBeauty() {
  $("projectBeautyControls").classList.toggle(
    "is-enabled",
    $("projectBeautyEnabled").checked,
  );
}

function selectStyle(styleId) {
  const style = state.catalog.styles.find((entry) => entry.id === styleId);
  if (!style) return;
  state.selectedStyleId = styleId;
  state.selectedOpeningId = style.direction.openingId;
  $("show").value = style.design.modes.show;
  syncProjectTuningFromStyle(style);
  renderStyles();
  renderOpenings();
  applyPreview(style);
  markContractDirty();
  updateSummary();
}

function updateReadiness() {
  const ready = {
    source: Boolean(state.media),
    style: Boolean(
      selectedStyle()
      && (state.selectedVisualLanguageMode === "automatic" || selectedVisualLanguage()),
    ),
    delivery: Boolean(state.preflight?.readiness?.outputWritable),
    contract: Boolean(state.preflight && state.preflightSignature),
  };
  $("readinessPanel").querySelectorAll("[data-ready]").forEach((row) => {
    row.classList.toggle("is-ready", ready[row.dataset.ready] === true);
  });
  const stepReady = {
    source: ready.source,
    style: ready.style,
    sound: ready.style,
    direction: Boolean(state.selectedOpeningId),
    delivery: ready.delivery || Boolean($("outputDirectory").value.trim()),
  };
  document.querySelectorAll("[data-step-link]").forEach((link) => {
    link.classList.toggle("is-complete", stepReady[link.dataset.stepLink] === true);
  });
}

function updateSummary() {
  const style = selectedStyle();
  if (!style) return;
  $("summarySource").textContent = state.media?.fileName || "未选择";
  $("summaryStyle").textContent = style.name;
  $("summaryVisualLanguage").textContent = visualLanguageSummary();
  $("summaryFont").textContent =
    `${style.caption.preferredFontFamily}${style.id === "xingzhe" ? " · 默认" : ""}`;
  $("summaryAudio").textContent = audioPresetName(state.selectedAudioPresetId);
  $("summaryBgm").textContent = $("bgmEnabled").checked
    ? bgmPresetName(state.selectedBgmPresetId)
    : "关闭";
  const beautyMaximum = Math.max(
    Number($("projectSmoothing").value),
    Number($("projectWhitening").value),
    Number($("projectTone").value),
    Number($("projectNasolabial").value),
  );
  $("summaryBeauty").textContent = $("projectBeautyEnabled").checked
    ? `${beautyMaximum > 55 ? "明显" : "自然"} · 已开启`
    : "关闭";
  $("summaryEffects").textContent = `${state.effects.length} 组`;
  $("summaryDelivery").textContent =
    `${platformLabel($("platform").value)} · ${outputLabel($("outputPreset").value)}`;
  const auto = $("autoDirector").checked;
  $("autoNote").classList.toggle("is-off", !auto);
  $("autoNote").querySelector("strong").textContent =
    auto ? "专业自动判断已开启" : "专业自动判断已关闭";
  applyPreview(style);
  updateReadiness();
}

function populateSelect(select, values, { selected = null } = {}) {
  select.innerHTML = values.map((value) => `
    <option value="${escapeHtml(value.id)}"${value.id === selected ? " selected" : ""}>
      ${escapeHtml(value.name || value.label)}
    </option>
  `).join("");
}

function setupStyleEditor() {
  const builtIns = state.catalog.styles.filter((style) => style.builtIn);
  populateSelect($("customBaseStyle"), builtIns, { selected: state.catalog.defaultStyleId });
  populateSelect($("customCaptionTemplate"), state.catalog.captionTemplates, {
    selected: "editorial-readable",
  });
  populateSelect($("customAudioPreset"), state.catalog.audioPresets, {
    selected: "warm-soft",
  });
  populateSelect($("customBgmPreset"), state.catalog.bgmPresets, {
    selected: "quiet-knowledge",
  });
  $("customOpening").innerHTML = state.catalog.openings.map((opening) => `
    <option value="${escapeHtml(opening.id)}">${escapeHtml(opening.label)}</option>
  `).join("");
  const ranges = [
    ["customFontSize", "fontSizeOutput", (value) => `${value}%`],
    ["customBaseline", "baselineOutput", (value) => `${value}%`],
    ["customShadow", "shadowOutput", (value) => `${value}%`],
    ["customSmoothing", "smoothingOutput", String],
    ["customWhitening", "whiteningOutput", String],
    ["customTone", "toneOutput", String],
    ["customNasolabial", "nasolabialOutput", String],
  ];
  ranges.forEach(([inputId, outputId, format]) => {
    const input = $(inputId);
    const output = $(outputId);
    const update = () => {
      output.value = format(input.value);
      output.textContent = format(input.value);
    };
    input.addEventListener("input", update);
    update();
  });
  const toggleBeauty = () => {
    $("beautyControls").classList.toggle("is-enabled", $("customBeautyEnabled").checked);
  };
  $("customBeautyEnabled").addEventListener("change", toggleBeauty);
  toggleBeauty();
  $("customBaseStyle").addEventListener("change", () => {
    hydrateStyleEditor($("customBaseStyle").value);
  });
}

function hydrateStyleEditor(styleId = state.catalog.defaultStyleId) {
  const style = state.catalog.styles.find(
    (entry) => entry.id === styleId && entry.builtIn,
  ) || state.catalog.styles.find((entry) => entry.id === state.catalog.defaultStyleId);
  $("customBaseStyle").value = style.id;
  $("customCaptionTemplate").value = style.caption.templateId;
  $("customAccent").value =
    style.design.overrides?.palette?.accent || style.caption.emphasisColor;
  $("customSurface").value = style.design.overrides?.palette?.surface || "#FFF8EA";
  $("customInk").value = style.design.overrides?.palette?.ink || "#24150F";
  $("customAudioPreset").value = style.audio.presetId;
  $("customBgmPreset").value = style.bgm.presetId;
  $("customOpening").value = style.direction.openingId;
  $("customDensity").value = style.direction.effectDensity;
  $("customFontSize").value = String(style.caption.fontSizeRatio * 100);
  $("customBaseline").value = String(style.caption.baselineYRatio * 100);
  $("customShadow").value = String(style.caption.shadowOpacity * 100);
  $("customBeautyEnabled").checked = style.beauty.enabled;
  $("customSmoothing").value = String(style.beauty.tuning.smoothing);
  $("customWhitening").value = String(style.beauty.tuning.whitening);
  $("customTone").value = String(style.beauty.tuning.toneEvening);
  $("customNasolabial").value = String(style.beauty.tuning.nasolabialSoftening);
  [
    "customFontSize",
    "customBaseline",
    "customShadow",
    "customSmoothing",
    "customWhitening",
    "customTone",
    "customNasolabial",
  ].forEach((id) => $(id).dispatchEvent(new Event("input")));
  $("customBeautyEnabled").dispatchEvent(new Event("change"));
}

function setupProjectTuning() {
  populateSelect($("projectBgmPreset"), state.catalog.bgmPresets, {
    selected: selectedStyle().bgm.presetId,
  });
  $("projectBgmPreset").addEventListener("change", () => {
    state.selectedBgmPresetId = $("projectBgmPreset").value;
    $("bgmEnabled").checked = state.selectedBgmPresetId !== "none";
    markContractDirty();
    updateSummary();
  });
  $("projectBeautyEnabled").addEventListener("change", () => {
    toggleProjectBeauty();
    markContractDirty();
    updateSummary();
  });
  [
    ["projectSmoothing", "projectSmoothingOutput"],
    ["projectWhitening", "projectWhiteningOutput"],
    ["projectTone", "projectToneOutput"],
    ["projectNasolabial", "projectNasolabialOutput"],
  ].forEach(([inputId, outputId]) => {
    $(inputId).addEventListener("input", () => {
      $(outputId).value = $(inputId).value;
      $(outputId).textContent = $(inputId).value;
      markContractDirty();
      updateSummary();
    });
  });
  document.querySelectorAll('input[name="effectDensity"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      state.selectedEffectDensity = input.value;
      markContractDirty();
    });
  });
}

function editorValue(id) {
  return $(id).value.trim();
}

function captionTemplate(id) {
  return state.catalog.captionTemplates.find((entry) => entry.id === id);
}

function customStylePayload() {
  const base = state.catalog.styles.find(
    (style) => style.id === $("customBaseStyle").value,
  );
  const template = captionTemplate($("customCaptionTemplate").value);
  const audio = state.catalog.audioPresets.find(
    (preset) => preset.id === $("customAudioPreset").value,
  );
  const bgm = state.catalog.bgmPresets.find(
    (preset) => preset.id === $("customBgmPreset").value,
  );
  if (!editorValue("customStyleName")) throw new Error("请填写风格名称");
  if (!editorValue("customStyleTagline")) throw new Error("请填写一句话气质");
  return {
    schemaVersion: "1.0",
    name: editorValue("customStyleName"),
    tagline: editorValue("customStyleTagline"),
    description: `基于“${base.name}”创建的本地自定义视频风格。`,
    baseStyleId: base.id,
    design: {
      ...base.design,
      overrides: {
        ...base.design.overrides,
        palette: {
          ...(base.design.overrides?.palette ?? {}),
          accent: $("customAccent").value.toUpperCase(),
          surface: $("customSurface").value.toUpperCase(),
          ink: $("customInk").value.toUpperCase(),
        },
      },
    },
    caption: {
      ...base.caption,
      templateId: template.id,
      fontRole: template.fontRole,
      preferredFontFamily:
        template.preferredFontFamily || base.caption.preferredFontFamily,
      fontSizeRatio: Number($("customFontSize").value) / 100,
      baselineYRatio: Number($("customBaseline").value) / 100,
      shadowOpacity: Number($("customShadow").value) / 100,
      emphasisColor: $("customAccent").value.toUpperCase(),
    },
    audio: {
      ...base.audio,
      presetId: audio.id,
      denoise: audio.denoise,
      targetLufs: audio.targetLufs,
      truePeakDbtp: audio.truePeakDbtp,
    },
    bgm: {
      ...base.bgm,
      enabled: bgm.id !== "none",
      presetId: bgm.id,
    },
    beauty: {
      enabled: $("customBeautyEnabled").checked,
      engine: "beauty-v2",
      profile: Math.max(
        Number($("customSmoothing").value),
        Number($("customWhitening").value),
        Number($("customTone").value),
        Number($("customNasolabial").value),
      ) > 55 ? "visible" : "natural",
      tuning: {
        smoothing: Number($("customSmoothing").value),
        whitening: Number($("customWhitening").value),
        toneEvening: Number($("customTone").value),
        nasolabialSoftening: Number($("customNasolabial").value),
      },
    },
    direction: {
      ...base.direction,
      openingId: $("customOpening").value,
      effectDensity: $("customDensity").value,
    },
  };
}

async function saveCustomStyle() {
  const button = $("saveStyle");
  button.disabled = true;
  $("styleSaveStatus").textContent = "正在校验字体、设计系统与参数…";
  try {
    const result = await api("/api/styles", {
      method: "POST",
      body: JSON.stringify(customStylePayload()),
    });
    const bootstrap = await api("/api/bootstrap");
    state.catalog = bootstrap;
    state.selectedStyleId = result.style.id;
    state.selectedOpeningId = result.style.direction.openingId;
    renderStyles();
    renderVisualLanguages();
    renderOpenings();
    selectStyle(result.style.id);
    $("styleEditor").hidden = true;
    toast(`已保存并启用“${result.style.name}”`);
  } catch (error) {
    $("styleSaveStatus").textContent = error.message;
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function pickVideo() {
  const button = $("chooseVideo");
  button.disabled = true;
  try {
    const result = await api("/api/pick-video", {
      method: "POST",
      body: "{}",
    });
    if (!result.cancelled && result.path) {
      $("videoPath").value = result.path;
      await probeVideo();
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function probeVideo() {
  const videoPath = $("videoPath").value.trim();
  if (!videoPath) {
    toast("请先选择或粘贴视频路径", true);
    return;
  }
  const button = $("probeVideo");
  button.disabled = true;
  $("sourceState").textContent = "正在读取";
  try {
    const result = await api("/api/probe-video", {
      method: "POST",
      body: JSON.stringify({ videoPath }),
    });
    state.media = result.media;
    $("mediaGeometry").textContent = `${result.media.width} × ${result.media.height}`;
    $("mediaFps").textContent = `${result.media.fps.toFixed(3)} fps`;
    $("mediaDuration").textContent = formatDuration(result.media.durationSeconds);
    $("mediaCodecs").textContent =
      `${result.media.videoCodec || "—"} / ${result.media.audioCodec || "无音轨"}`;
    $("mediaStrip").classList.remove("is-empty");
    $("sourceState").textContent = "已读取";
    $("summarySource").textContent = result.media.fileName;
    if (!$("projectName").value.trim()) {
      $("projectName").value = result.media.fileName.replace(/\.[^.]+$/, "");
    }
    if (!$("outputDirectory").value.trim()) {
      $("outputDirectory").value = videoPath.slice(0, videoPath.lastIndexOf("/"));
    }
    markContractDirty();
    toast("视频规格读取完成");
  } catch (error) {
    state.media = null;
    $("sourceState").textContent = "读取失败";
    toast(error.message, true);
  } finally {
    button.disabled = false;
    updateSummary();
  }
}

async function pickOutput() {
  const button = $("chooseOutput");
  button.disabled = true;
  try {
    const result = await api("/api/pick-output", {
      method: "POST",
      body: "{}",
    });
    if (!result.cancelled && result.path) {
      $("outputDirectory").value = result.path;
      markContractDirty();
      updateSummary();
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function requestPayload() {
  if (!state.media) throw new Error("请先读取视频规格");
  const assignments = state.effects.map((entry, index) => {
    if (!entry.positionDescription.trim()) {
      throw new Error(`第 ${index + 1} 组指定效果缺少自然语言位置`);
    }
    const [effectKind, effectId] = entry.key.split(":");
    return {
      positionDescription: entry.positionDescription.trim(),
      effectKind,
      effectId,
      notes: "",
    };
  });
  return {
    schemaVersion: "1.0",
    videoPath: $("videoPath").value.trim(),
    projectName: $("projectName").value.trim() || state.media.fileName.replace(/\.[^.]+$/, ""),
    outputDirectory: $("outputDirectory").value.trim(),
    task: $("task").value,
    platform: $("platform").value,
    show: $("show").value,
    language: $("language").value,
    outputPresetId: $("outputPreset").value,
    targetDuration: $("targetDuration").value.trim(),
    preserveSource: $("preserveSource").checked,
    backgroundMusicEnabled:
      $("bgmEnabled").checked && state.selectedBgmPresetId !== "none",
    styleId: state.selectedStyleId,
    visualLanguageSelection: state.selectedVisualLanguageMode === "automatic"
      ? { mode: "automatic" }
      : {
          mode: "preferred",
          preferredId: state.selectedVisualLanguageId,
        },
    openingId: state.selectedOpeningId,
    automaticProfessionalJudgment: $("autoDirector").checked,
    projectOverrides: {
      audioPresetId: state.selectedAudioPresetId,
      bgmPresetId: state.selectedBgmPresetId,
      effectDensity: state.selectedEffectDensity,
      beauty: {
        enabled: $("projectBeautyEnabled").checked,
        engine: "beauty-v2",
        profile: Math.max(
          Number($("projectSmoothing").value),
          Number($("projectWhitening").value),
          Number($("projectTone").value),
          Number($("projectNasolabial").value),
        ) > 55 ? "visible" : "natural",
        tuning: {
          smoothing: Number($("projectSmoothing").value),
          whitening: Number($("projectWhitening").value),
          toneEvening: Number($("projectTone").value),
          nasolabialSoftening: Number($("projectNasolabial").value),
        },
      },
    },
    effectAssignments: assignments,
    notes: $("notes").value.trim(),
  };
}

function payloadSignature(payload) {
  return JSON.stringify(payload);
}

async function validateProject({ announce = true } = {}) {
  const button = $("validateProject");
  button.disabled = true;
  button.textContent = "正在检查…";
  try {
    const payload = requestPayload();
    const result = await api("/api/preview-request", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.preflight = result;
    state.preflightSignature = payloadSignature(payload);
    $("preflightSummary").textContent =
      `视频、输出目录、${result.brief.style.captionFontEvidence.resolvedFamily}、`
        + `${visualLanguageSummary()}、`
        + `设计系统和 ${result.readiness.effectsResolved} 组指定效果均已解析。`;
    $("preflightPanel").hidden = false;
    updateReadiness();
    if (announce) toast("配置检查通过，可以生成剪辑项目");
    return result;
  } catch (error) {
    markContractDirty();
    toast(error.message, true);
    throw error;
  } finally {
    button.disabled = false;
    button.textContent = "检查配置";
  }
}

async function generateProject() {
  const button = $("generateProject");
  button.disabled = true;
  button.textContent = "正在冻结配置与素材身份…";
  $("resultPanel").hidden = true;
  try {
    const payload = requestPayload();
    if (state.preflightSignature !== payloadSignature(payload)) {
      await validateProject({ announce: false });
    }
    const result = await api("/api/compile", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.generatedProjectPath = result.projectDirectory;
    $("resultPath").textContent = result.projectDirectory;
    $("openGeneratedProject").href = `/project?path=${encodeURIComponent(result.projectDirectory)}`;
    $("resultPanel").hidden = false;
    toast("剪辑项目配置已生成，可以交给咔嚓执行");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "生成剪辑项目";
  }
}

function observeSections() {
  const links = [...document.querySelectorAll(".step-rail nav a")];
  const sections = links
    .map((link) => document.querySelector(link.getAttribute("href")))
    .filter(Boolean);
  const observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    links.forEach((link) => {
      link.classList.toggle(
        "is-active",
        link.getAttribute("href") === `#${visible.target.id}`,
      );
    });
  }, { rootMargin: "-20% 0px -60%", threshold: [0.1, 0.35] });
  sections.forEach((section) => observer.observe(section));
}

function setupEffectLibrary() {
  const groups = [...new Set(
    state.catalog.assignableEffects.map((effect) => effect.group),
  )];
  $("effectGroup").innerHTML = [
    '<option value="">全部类别</option>',
    ...groups.map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`),
  ].join("");
  $("effectSearch").addEventListener("input", renderEffectLibrary);
  $("effectGroup").addEventListener("change", renderEffectLibrary);
  renderEffectLibrary();
  renderEffects();
}

async function bootstrap() {
  try {
    const catalog = await api("/api/bootstrap");
    state.catalog = catalog;
    state.selectedStyleId = catalog.defaultStyleId;
    state.selectedVisualLanguageMode =
      catalog.visualLanguagePolicy.defaultSelectionMode;
    state.selectedVisualLanguageId = null;
    const style = selectedStyle();
    state.selectedOpeningId = style.direction.openingId;
    $("runtimeStatus").classList.add("is-ready");
    $("runtimeStatus").innerHTML =
      '<span class="runtime-dot"></span>本地引擎已连接 · 不上传素材';
    populateSelect($("outputPreset"), catalog.outputPresets, {
      selected: "preserve-source",
    });
    setupProjectTuning();
    setupEffectLibrary();
    renderStyles();
    renderVisualLanguages();
    renderOpenings();
    setupStyleEditor();
    hydrateStyleEditor(style.id);
    selectStyle(style.id);
  } catch (error) {
    $("runtimeStatus").textContent = "本地引擎连接失败";
    toast(error.message, true);
  }
}

$("chooseVideo").addEventListener("click", pickVideo);
$("probeVideo").addEventListener("click", probeVideo);
$("chooseOutput").addEventListener("click", pickOutput);
$("openStyleEditor").addEventListener("click", () => {
  const baseStyle = selectedStyle()?.builtIn
    ? selectedStyle().id
    : selectedStyle()?.baseStyleId || state.catalog.defaultStyleId;
  hydrateStyleEditor(baseStyle);
  $("styleSaveStatus").textContent = "";
  $("styleEditor").hidden = false;
  $("styleEditor").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("closeStyleEditor").addEventListener("click", () => {
  $("styleEditor").hidden = true;
});
$("saveStyle").addEventListener("click", saveCustomStyle);
$("autoDirector").addEventListener("change", () => {
  markContractDirty();
  updateSummary();
});
$("bgmEnabled").addEventListener("change", () => {
  markContractDirty();
  updateSummary();
});
$("show").addEventListener("change", () => {
  markContractDirty();
  updateSummary();
});
$("platform").addEventListener("change", () => {
  markContractDirty();
  updateSummary();
});
$("outputPreset").addEventListener("change", () => {
  markContractDirty();
  updateSummary();
});
$("validateProject").addEventListener("click", () => {
  validateProject().catch(() => {});
});
$("generateProject").addEventListener("click", generateProject);
$("videoPath").addEventListener("input", () => {
  if (state.media?.path !== $("videoPath").value.trim()) {
    state.media = null;
    $("mediaStrip").classList.add("is-empty");
    $("sourceState").textContent = $("videoPath").value.trim()
      ? "规格待读取"
      : "等待选择";
    markContractDirty();
    updateSummary();
  }
});
[
  "projectName",
  "task",
  "language",
  "targetDuration",
  "outputDirectory",
  "preserveSource",
  "notes",
].forEach((id) => {
  $(id).addEventListener("input", markContractDirty);
  $(id).addEventListener("change", markContractDirty);
});
$("copyResultPath").addEventListener("click", async () => {
  if (!state.generatedProjectPath) return;
  await navigator.clipboard.writeText(state.generatedProjectPath);
  toast("项目路径已复制");
});

observeSections();
await bootstrap();
