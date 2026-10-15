#!/usr/bin/env node
// Retired command: do not silently accept old projects or render with another backend.
console.error('咔嚓内置 Beauty v2 美颜已移除。请关闭旧工程的 beauty.enabled，或使用 pro-tools 的剪映增强工作流；不会自动修改旧工程。');
process.exitCode = 1;
