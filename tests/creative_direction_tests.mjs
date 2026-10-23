import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { directionCatalog, planCreativeDirection, directionInstruction, directionForBeat } from '../scripts/creative_direction.mjs';
import { loadProductionCatalog } from '../scripts/kacha_studio.mjs';
import { initializeProject, ensureContentPackage, handoffContentProject } from '../scripts/project_orchestrator.mjs';
import { buildDirectorPlan, validateDirectorPlan } from '../scripts/kacha_intelligence.mjs';
import { inspectMaterial, composeMaterialProject } from '../scripts/material_project.mjs';

test('open direction decouples appearance, meaning and execution without assuming availability', () => {
  const plan = planCreativeDirection({ intent: 'explain', artDirection: '白纸手绘，不要光路', providerPreference: 'huashu-design' });
  assert.equal(plan.status, 'proposal');
  assert.equal(plan.appearance.direction, '白纸手绘，不要光路');
  assert.equal(plan.execution.availability, 'not-checked');
  assert.equal(plan.execution.automaticRender, false);
  assert.equal(plan.execution.paidGenerationAuthorized, false);
  assert.ok(plan.proposedProviders.includes('huashu-design'));
  assert.match(directionInstruction(plan, 'source_edit').text, /白纸手绘/);
  assert.equal(planCreativeDirection().methods[0].id, 'continuity');
  assert.equal(planCreativeDirection({ providerPreference: 'lemo-opuscar' }).proposedProviders[0], 'lemo-opuscar');
  assert.equal(plan.digest, planCreativeDirection(plan.request).digest);
  assert.notEqual(plan.digest, planCreativeDirection({ ...plan.request, artDirection: '黑白摄影' }).digest);
});
test('custom methods work without forcing existing appearances or a fixed registry size', () => {
  const plan = planCreativeDirection({ intent: 'custom', customMethod: '用现场声匹配动作；没有匹配动作则保留连续镜头', artDirection: '定格纸艺' });
  assert.equal(plan.request.techniques[0], 'custom');
  const registry = directionCatalog();
  registry.techniques.push({ id: 'match-action', label: '动作匹配', principle: '匹配真实动作', providerCandidates: ['native'] });
  const extended = planCreativeDirection({ techniques: ['match-action'] }, registry);
  assert.equal(extended.methods[0].id, 'match-action');
  assert.notEqual(extended.registryDigest, directionCatalog().digest);
  registry.techniques.push({ ...registry.techniques[0] });
  assert.throws(() => planCreativeDirection({}, registry), /重复/);
});
test('automatic direction proposes matching methods while silence and explicit choices stay constrained', () => {
  const automatic = planCreativeDirection();
  for (const [signal, method] of [['comparison', 'comparison'], ['workflow_demo', 'demonstration'], ['causality', 'relation'], ['humor', 'comic'], ['ambient_sound', 'atmosphere']]) {
    assert.ok(directionForBeat(automatic, { signals: [signal] }).candidateMethods.some(x => x.id === method));
  }
  assert.deepEqual(directionForBeat(automatic, { signals: ['ordinary_speech'] }).candidateMethods.map(x => x.id), ['continuity']);
  const explicit = planCreativeDirection({ intent: 'auto', techniques: ['continuity'] });
  assert.deepEqual(directionForBeat(explicit, { signals: ['comparison'] }).candidateMethods.map(x => x.id), ['continuity']);
  assert.deepEqual(directionForBeat(automatic, { signals: ['humor', 'ambient_sound'] }, { protectedBeat: true }).candidateMethods.map(x => x.id), ['continuity']);
});
test('nonmatching beats do not consume the matching beat emphasis budget', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kacha-direction-budget-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cues = path.join(root, 'cues.json');
  fs.writeFileSync(cues, JSON.stringify({ cues: [
    { id: 'opening', start: 0, end: 5, text: '介绍背景', signals: [] },
    { id: 'relation', start: 5, end: 10, text: '解释原因', signals: ['causality'] },
  ] }));
  const plan = buildDirectorPlan(cues, { creativeDirection: { intent: 'explain' } });
  assert.ok(plan.beats[0].emphasisScore > plan.beats[1].emphasisScore);
  assert.equal(plan.beats[0].effectDecision, 'deliberate_none');
  assert.equal(plan.beats[1].effectDecision, 'candidate');
  assert.equal(plan.attentionBudget.selectedHighImpactDecisions, 1);
  assert.ok(plan.quality.quietRatioPass);
  assert.deepEqual(validateDirectorPlan(plan), []);
});
test('malformed requests and unsupported tools are rejected before project writes', () => {
  for (const input of [null, [], { intent: 'invented' }, { brief: 12 }, { artDirection: 'x'.repeat(4001) }, { intent: 'custom' }, { techniques: ['custom'] }, { techniques: ['state', 'state'] }, { techniques: [] }, { techniques: ['unknown'] }, { paidGenerationAuthorized: true }, { providerPreference: 'shell' }]) {
    assert.throws(() => planCreativeDirection(input));
  }
  const result = spawnSync(process.execPath, ['scripts/creative_direction.mjs', 'catalog', '--brief', 'ignored?'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /不接受/);
});
test('redundant styles leave new selection while historical IDs remain resolvable', () => {
  const catalog = loadProductionCatalog();
  for (const id of directionCatalog().retiredPresetIds) {
    assert.equal(catalog.styles.find(s => s.id === id)?.lifecycle, 'compatibility-only');
    assert.ok(!catalog.selectableStyleIds.includes(id));
  }
  assert.ok(catalog.selectableStyleIds.includes('clean-editorial'));
  assert.ok(catalog.styles.filter(s => s.design.profile === 'xingzhe').every(s => !catalog.selectableStyleIds.includes(s.id)));
  assert.equal(catalog.visualLanguages.length, 5); // only the frozen compatibility asset family
});
test('script-first projects persist direction in brief and executable project instructions', t => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kacha-direction-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'project');
  const request = { intent: 'compare', brief: '对比真实操作结果', artDirection: '分屏与手绘注释' };
  initializeProject({ topic: '两种操作的实际差异', projectRoot: root, projectId: 'direction-test', creativeDirection: request, development: true, home: tmp });
  const brief = JSON.parse(fs.readFileSync(path.join(root, 'production-brief.json')));
  const config = JSON.parse(fs.readFileSync(path.join(root, 'kacha.config.json')));
  assert.equal(brief.creativeDirection.request.artDirection, request.artDirection);
  assert.equal(config.editingDefaults.parameters.creativeDirection.digest, brief.creativeDirection.digest);
  assert.match(config.editingDefaults.instructions[0].text, /对比真实操作结果/);
  const invalidRoot = path.join(tmp, 'invalid');
  assert.throws(() => initializeProject({ topic: 'invalid', projectRoot: invalidRoot, creativeDirection: { techniques: ['invented'] }, development: true, home: tmp }));
  assert.ok(!fs.existsSync(invalidRoot));
  const conflictRoot = path.join(tmp, 'conflict');
  fs.mkdirSync(conflictRoot);
  const configPath = path.join(conflictRoot, 'kacha.config.json');
  const existing = { schemaVersion: '1.0', style: { profile: 'clean-editorial', modes: { show: 'talking-head' } }, editingDefaults: { parameters: { creativeDirection: planCreativeDirection(request) } } };
  fs.writeFileSync(configPath, JSON.stringify(existing));
  assert.throws(() => initializeProject({ topic: 'conflict', projectRoot: conflictRoot, creativeDirection: { intent: 'mood' }, development: true, home: tmp }), /创作方向不一致/);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)), existing);
  assert.ok(!fs.existsSync(path.join(conflictRoot, 'contracts')));
  const state = JSON.parse(fs.readFileSync(path.join(root, '.kacha/orchestration.json')));
  ensureContentPackage(root, state);
  for (const [relative, change] of [
    ['contracts/content-spine.json', value => { value.status = 'approved_for_recording'; value.reviewNote = 'synthetic regression fixture only'; }],
    ['contracts/fact-check-tasks.json', value => value.tasks.forEach(item => { item.status = 'waived_with_reason'; item.reason = 'synthetic fixture'; })],
    ['.kacha/asset-inbox.json', value => value.items.forEach(item => { item.status = 'waived_with_reason'; item.reason = 'synthetic fixture'; })],
  ]) {
    const file = path.join(root, relative), value = JSON.parse(fs.readFileSync(file)); change(value); fs.writeFileSync(file, JSON.stringify(value));
  }
  const source = path.join(tmp, 'synthetic.mp4');
  const ffmpeg = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=25:d=0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source], { encoding: 'utf8' });
  assert.equal(ffmpeg.status, 0, ffmpeg.stderr);
  const materialRoot = path.join(tmp, 'materials');
  initializeProject({ materials: [source], requirements: '完整展示合成蓝色画面', duration: .4 + .6, projectRoot: materialRoot, creativeDirection: request, development: true, home: tmp });
  const materialBrief = JSON.parse(fs.readFileSync(path.join(materialRoot, 'contracts/material-brief.json')));
  const materialConfig = JSON.parse(fs.readFileSync(path.join(materialRoot, 'kacha.config.json')));
  assert.equal(materialBrief.creativeDirection.digest, brief.creativeDirection.digest);
  assert.equal(materialConfig.editingDefaults.parameters.creativeDirection.digest, brief.creativeDirection.digest);
  const boardFile = path.join(materialRoot, 'contracts/storyboard-template.json');
  const board = JSON.parse(fs.readFileSync(boardFile));
  const project = JSON.parse(fs.readFileSync(path.join(materialRoot, '.kacha/material-project.json')));
  const asset = project.assets[0];
  inspectMaterial(materialRoot, asset.id, { timestamps: [.1] });
  board.interpretation = '合成素材测试，不代表已完成真实对比';
  board.segments = Array.from({ length: 5 }, (_, i) => ({ id: `shot-${i}`, assetId: asset.id, sourceIn: 0, duration: .2, fit: 'contain', audio: 'source', role: 'evidence', reason: '测试镜头绑定', observation: '合成蓝色画面', satisfies: ['creative-direction', 'requirement-1'] }));
  board.segments[0].signals = ['comparison'];
  fs.writeFileSync(boardFile, JSON.stringify({ ...board, requirements: board.requirements.filter(x => x.id !== 'creative-direction') }));
  assert.throws(() => composeMaterialProject(materialRoot, boardFile), /创作方向要求/);
  fs.writeFileSync(boardFile, JSON.stringify({ ...board, segments: board.segments.map(x => ({ ...x, satisfies: ['requirement-1'] })) }));
  assert.throws(() => composeMaterialProject(materialRoot, boardFile), /未被镜头覆盖/);
  fs.writeFileSync(boardFile, JSON.stringify(board));
  const composed = composeMaterialProject(materialRoot, boardFile);
  const director = JSON.parse(fs.readFileSync(path.join(path.dirname(composed.activePlan.path), 'director.json')));
  assert.equal(director.creativeDirection.digest, brief.creativeDirection.digest);
  assert.ok(director.beats[0].creativeDecision.candidateMethods.some(method => method.id === 'comparison'));
  assert.deepEqual(validateDirectorPlan(director), []);
  const childRoot = path.join(tmp, 'child');
  handoffContentProject(root, source, { targetRoot: childRoot, confirmContentApproved: true, development: true, home: tmp });
  const childConfig = JSON.parse(fs.readFileSync(path.join(childRoot, 'kacha.config.json')));
  assert.equal(childConfig.editingDefaults.parameters.creativeDirection.digest, brief.creativeDirection.digest);


});
test('director uses content signals and open methods without routing through a legacy appearance', t => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kacha-direction-director-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const cues = path.join(tmp, 'cues.json');
  fs.writeFileSync(cues, JSON.stringify({ cues: [
    { id: 'comparison', start: 0, end: 5, text: '对照原始结果', signals: ['comparison'], confidence: 1 },
    { id: 'plain', start: 5, end: 10, text: '普通叙述', signals: ['ordinary_speech'], confidence: 1 },
  ] }));
  const plan = buildDirectorPlan(cues, { styleId: 'brand-with-no-legacy-recipe', creativeDirection: { intent: 'compare', artDirection: '手绘线条', pacing: '充分保留对照阅读时间' } });
  assert.equal(plan.project.styleGrammar, 'open-creative-direction');
  assert.ok(plan.beats[0].creativeDecision.candidateMethods.some(x => x.id === 'comparison'));
  assert.equal(plan.beats[1].creativeDecision.candidateMethods.length, 0);
  assert.equal(plan.beats[1].effectDecision, 'deliberate_none');
  assert.match(plan.opening.contract, /不强制三秒/);
  assert.deepEqual(validateDirectorPlan(plan), []);
  const mutated = structuredClone(plan); mutated.creativeDirection.request.artDirection = '另一方向';
  assert.ok(validateDirectorPlan(mutated).length > 0);
  const cliRequest = path.join(tmp, 'direction.json'); fs.writeFileSync(cliRequest, JSON.stringify({ intent: 'compare' }));
  const cli = spawnSync(process.execPath, ['scripts/kacha_intelligence.mjs', 'director', '--cues', cues, '--creative-direction', cliRequest], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).creativeDirection.request.intent, 'compare');
  const configFile = path.join(tmp, 'kacha.config.json');
  const config = { schemaVersion: '1.0', editingDefaults: { parameters: { creativeDirection: planCreativeDirection({ intent: 'compare' }) } } };
  fs.writeFileSync(configFile, JSON.stringify(config));
  const automatic = spawnSync(process.execPath, ['scripts/kacha_intelligence.mjs', 'director', '--cues', cues], { encoding: 'utf8' });
  assert.equal(automatic.status, 0, automatic.stderr);
  assert.equal(JSON.parse(automatic.stdout).creativeDirection.request.intent, 'compare');
  config.editingDefaults.parameters.creativeDirection.request.intent = 'mood';
  fs.writeFileSync(configFile, JSON.stringify(config));
  const stale = spawnSync(process.execPath, ['scripts/kacha_intelligence.mjs', 'director', '--cues', cues], { encoding: 'utf8' });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /摘要已失效/);
});
