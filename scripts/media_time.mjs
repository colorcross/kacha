export const DEFAULT_TICKS_PER_SECOND = 120000;

const STANDARD_RATES = [
  { numerator: 24000, denominator: 1001 },
  { numerator: 24, denominator: 1 },
  { numerator: 25, denominator: 1 },
  { numerator: 30000, denominator: 1001 },
  { numerator: 30, denominator: 1 },
  { numerator: 50, denominator: 1 },
  { numerator: 60000, denominator: 1001 },
  { numerator: 60, denominator: 1 },
];

function gcd(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a || 1;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} 必须是正安全整数`);
  }
  return parsed;
}

export function normalizeFrameRate(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const numerator = positiveInteger(value.numerator, "frameRate.numerator");
    const denominator = positiveInteger(value.denominator, "frameRate.denominator");
    const divisor = gcd(numerator, denominator);
    return { numerator: numerator / divisor, denominator: denominator / divisor };
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new Error("frameRate 必须为正数或有理数对象");
  const standard = STANDARD_RATES.find(
    (candidate) => Math.abs(candidate.numerator / candidate.denominator - numeric) < 0.0005,
  );
  if (standard) return { ...standard };
  const denominator = 1000000;
  const numerator = Math.round(numeric * denominator);
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

export function normalizeTimebase(value = {}, fallbackFrameRate = 25) {
  const ticksPerSecond = positiveInteger(
    value?.ticksPerSecond ?? DEFAULT_TICKS_PER_SECOND,
    "timebase.ticksPerSecond",
  );
  const frameRate = normalizeFrameRate(value?.frameRate ?? fallbackFrameRate);
  const tickNumerator = ticksPerSecond * frameRate.denominator;
  if (tickNumerator % frameRate.numerator !== 0) {
    throw new Error(
      `timebase ${ticksPerSecond} ticks/s 无法精确表达 `
        + `${frameRate.numerator}/${frameRate.denominator} fps`,
    );
  }
  return {
    schemaVersion: "2.0",
    ticksPerSecond,
    frameRate,
    ticksPerFrame: tickNumerator / frameRate.numerator,
  };
}

export function secondsToTicks(seconds, timebase) {
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric)) throw new Error("seconds 必须是有限数值");
  const ticks = Math.round(numeric * timebase.ticksPerSecond);
  if (!Number.isSafeInteger(ticks)) throw new Error("seconds 超出安全 tick 范围");
  return ticks;
}

export function ticksToSeconds(ticks, timebase) {
  const numeric = Number(ticks);
  if (!Number.isSafeInteger(numeric)) throw new Error("ticks 必须是安全整数");
  return numeric / timebase.ticksPerSecond;
}

export function framesToTicks(frames, timebase) {
  const numeric = Number(frames);
  if (!Number.isSafeInteger(numeric)) throw new Error("frames 必须是安全整数");
  const ticks = numeric * timebase.ticksPerFrame;
  if (!Number.isSafeInteger(ticks)) throw new Error("frames 超出安全 tick 范围");
  return ticks;
}

export function ticksToFrames(ticks, timebase, { exact = true } = {}) {
  const numeric = Number(ticks);
  if (!Number.isSafeInteger(numeric)) throw new Error("ticks 必须是安全整数");
  if (exact && numeric % timebase.ticksPerFrame !== 0) {
    throw new Error("tick 不在整帧边界");
  }
  return exact ? numeric / timebase.ticksPerFrame : numeric / timebase.ticksPerFrame;
}

function canonicalField(owner, secondsField, tickField, timebase, errors, label) {
  const hasTicks = owner?.[tickField] !== undefined;
  const hasSeconds = owner?.[secondsField] !== undefined;
  if (!hasTicks && !hasSeconds) return;
  let ticks;
  if (hasTicks) {
    ticks = Number(owner[tickField]);
    if (!Number.isSafeInteger(ticks)) {
      errors.push(`${label}.${tickField} 必须是安全整数`);
      return;
    }
  } else {
    try {
      ticks = secondsToTicks(owner[secondsField], timebase);
    } catch (error) {
      errors.push(`${label}.${secondsField} ${error.message}`);
      return;
    }
  }
  const seconds = ticksToSeconds(ticks, timebase);
  if (hasSeconds) {
    const supplied = Number(owner[secondsField]);
    const halfFrame = timebase.ticksPerFrame / timebase.ticksPerSecond / 2;
    if (!Number.isFinite(supplied) || Math.abs(supplied - seconds) > halfFrame + 1e-9) {
      errors.push(`${label}.${secondsField} 与 ${tickField} 相差超过半帧`);
    }
  }
  owner[tickField] = ticks;
  owner[secondsField] = seconds;
}

export function canonicalizeTimelineTime(input, fallbackFrameRate = 25) {
  const plan = structuredClone(input);
  const errors = [];
  let timebase;
  try {
    timebase = normalizeTimebase(plan.timebase, fallbackFrameRate);
  } catch (error) {
    return { plan, timebase: null, errors: [error.message] };
  }
  plan.timebase = timebase;
  (plan.edl ?? []).forEach((entry, index) => {
    canonicalField(entry, "sourceStart", "sourceStartTick", timebase, errors, `edl[${index}]`);
    canonicalField(entry, "sourceEnd", "sourceEndTick", timebase, errors, `edl[${index}]`);
  });
  (plan.visual?.breathing ?? []).forEach((entry, index) => {
    canonicalField(entry, "start", "startTick", timebase, errors, `visual.breathing[${index}]`);
    canonicalField(entry, "end", "endTick", timebase, errors, `visual.breathing[${index}]`);
  });
  (plan.visual?.overlays ?? []).forEach((entry, index) => {
    canonicalField(entry, "start", "startTick", timebase, errors, `visual.overlays[${index}]`);
    canonicalField(entry, "end", "endTick", timebase, errors, `visual.overlays[${index}]`);
  });
  (plan.audio?.bgm?.segments ?? []).forEach((entry, index) => {
    canonicalField(entry, "start", "startTick", timebase, errors, `audio.bgm.segments[${index}]`);
    canonicalField(entry, "end", "endTick", timebase, errors, `audio.bgm.segments[${index}]`);
    canonicalField(entry, "sourceStart", "sourceStartTick", timebase, errors, `audio.bgm.segments[${index}]`);
  });
  (plan.audio?.sfx ?? []).forEach((entry, index) => {
    canonicalField(entry, "time", "timeTick", timebase, errors, `audio.sfx[${index}]`);
    canonicalField(entry, "targetLandingSeconds", "targetLandingTick", timebase, errors, `audio.sfx[${index}]`);
  });
  return { plan, timebase, errors };
}

export function timebaseSummary(timebase) {
  return {
    ticksPerSecond: timebase.ticksPerSecond,
    frameRate: `${timebase.frameRate.numerator}/${timebase.frameRate.denominator}`,
    framesPerSecond: timebase.frameRate.numerator / timebase.frameRate.denominator,
    ticksPerFrame: timebase.ticksPerFrame,
  };
}
