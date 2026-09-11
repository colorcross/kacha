#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function audit(args) {
  const result = spawnSync("npm", ["audit", "--json", ...args], {
    cwd: new URL("..", import.meta.url), encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
  });
  if (result.error || !result.stdout.trim()) throw new Error(`npm audit 未完成：${result.error?.message ?? result.stderr}`);
  const report = JSON.parse(result.stdout);
  const total = report.metadata?.vulnerabilities?.total;
  if (report.error || !Number.isInteger(total) || total < 0 || (result.status !== 0 && total === 0)) {
    throw new Error(`npm audit 返回无效或不完整结果：${JSON.stringify(report.error ?? { exitCode: result.status, total })}`);
  }
  if (total !== 0) {
    const details = Object.values(report.vulnerabilities ?? {}).map((entry) => `${entry.name} (${entry.severity})`).join(", ");
    throw new Error(`依赖漏洞尚未修复：${details || total}`);
  }
  return total;
}

console.log(JSON.stringify({
  status: "pass",
  productionVulnerabilities: audit(["--omit=dev"]),
  allDependencyVulnerabilities: audit([]),
  developmentExceptions: [],
  checkedAt: new Date().toISOString(),
}, null, 2));
