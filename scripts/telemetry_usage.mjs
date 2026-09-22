export function firstFinite(...values) {
  for (const value of values) {
    if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

export function extractUsage(value) {
  const candidates = [
    value?.usage,
    value?.result?.usage,
    value?.response?.usage,
    value?.metrics?.usage,
  ].filter((candidate) => candidate && typeof candidate === "object");
  const usage = { input: null, output: null, references: null };
  for (const candidate of candidates) {
    usage.input ??= firstFinite(candidate.input_tokens, candidate.inputTokens, candidate.prompt_tokens, candidate.promptTokens);
    usage.output ??= firstFinite(candidate.output_tokens, candidate.outputTokens, candidate.completion_tokens, candidate.completionTokens);
    usage.references ??= firstFinite(candidate.reference_tokens, candidate.referenceTokens);
  }
  return Object.values(usage).some(value => value !== null) ? usage : null;
}


export function tokenEvidence({ explicit = {}, usage = null, estimate = null, usageSource = "child_result_usage", usageSources = {} } = {}) {
  const values = {}, fields = {};
  for (const key of ["input", "output", "references"]) {
    const actual = firstFinite(explicit[key], usage?.[key]);
    const estimated = key === "references" ? firstFinite(estimate) : null;
    values[key] = actual ?? estimated;
    fields[key] = { measurement: actual !== null ? "measured" : estimated !== null ? "estimated" : "unavailable",
      source: firstFinite(explicit[key]) !== null ? "cli_or_runtime_environment" : actual !== null ? (usageSources[key] ?? usageSource) : estimated !== null ? "agent_packet_estimate" : "unavailable" };
  }
  const kinds = new Set(Object.values(fields).map(x => x.measurement).filter(x => x !== "unavailable"));
  return { ...values, fields, measurement: kinds.size > 1 ? "mixed" : kinds.has("measured") ? "actual" : kinds.has("estimated") ? "estimated" : "unavailable" };
}

export function accountingEvents(input) {
  const seen = new Set();
  const events = input.filter(event => {
    if (!event.eventId) return true;
    if (seen.has(event.eventId)) return false;
    seen.add(event.eventId); return true;
  });
  const parents = new Set(events.map(e => e.parentEventId).filter(Boolean));
  const work = events.filter(e => !parents.has(e.eventId));
  const usage = events.filter(e => !parents.has(e.eventId) || e.accounting?.usageScope === "self");
  const starts = events.map(e => Date.parse(e.timing?.startedAt)).filter(Number.isFinite);
  const ends = events.map(e => Date.parse(e.timing?.endedAt)).filter(Number.isFinite);
  return { events, work, usage, duplicateEvents: input.length - events.length,
    timing: { elapsedSeconds: starts.length && ends.length ? Math.max(0, (Math.max(...ends) - Math.min(...starts)) / 1000) : null,
      taskSeconds: work.reduce((n,e)=>n + (firstFinite(e.timing?.wallSeconds) ?? 0),0),
      wrapperSeconds: events.filter(e=>parents.has(e.eventId)).reduce((n,e)=>n+(firstFinite(e.timing?.wallSeconds)??0),0),
      interpretation: "elapsed includes recorded gaps; taskSeconds excludes enclosing wrappers and may overlap" } };
}

export function ledgerAccounting(events, readLedger) {
  const entries = [], seen = new Set(), totals = {}, errors = [];
  for (const event of events) for (const id of event.cost?.entries ?? []) {
    const file = event.cost.ledger, key = `${file}:${id}`;
    if (seen.has(key)) continue; seen.add(key);
    try {
      if (!file) throw new Error("missing ledger");
      const ledger = readLedger(file);
      if (ledger.kind !== "kacha-cost-ledger" || !/^[A-Z]{3}$/.test(ledger.currency ?? "")) throw new Error("invalid ledger");
      const entry = ledger.entries.find(item => item.id === id);
      if (!entry) throw new Error("missing entry");
      const measured = ["reconciled", "refunded"].includes(entry.status) && firstFinite(entry.actualAmount) !== null;
      const refund = entry.status === "refunded" ? firstFinite(entry.refundAmount) : 0;
      if (entry.status === "refunded" && (refund === null || refund > entry.actualAmount)) throw new Error("invalid refund");
      const amount = measured ? entry.actualAmount - refund : null;
      entries.push({ ledger: file, id, status: entry.status, currency: ledger.currency, amount, measurement: measured ? "measured" : "unavailable" });
      if (measured) totals[ledger.currency] = (totals[ledger.currency] ?? 0) + amount;
    } catch (error) { errors.push({ ledger: file, id, error: error.message }); }
  }
  return { authority: "cost_ledger_reconciliation", entries, reconciledTotalsByCurrency: totals, complete: entries.length > 0 && !errors.length && entries.every(e => e.measurement === "measured"), errors };
}
