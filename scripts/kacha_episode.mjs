#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { episodeTemplate, validateEpisode } from './episode_editorial.mjs';
import { loadProductionPack } from './production_pack.mjs';
import { readJson, sha256File, writeJsonAtomic } from './kacha_utils.mjs';
const args = process.argv.slice(2);
const option = (name, fallback = null) => args.includes(name) ? args[args.indexOf(name)+1] : fallback;
try {
  if (args[0] === 'list') {
    const pack = loadProductionPack('dahui-ai', 'ai-practice');
    console.log(JSON.stringify(pack.supportedShows.map(show => ({show, ...loadProductionPack('dahui-ai',show).policies.episode})),null,2));
  } else if (args[0] === 'template') {
    const file = option('--output'), projectId = option('--project-id'), show = option('--show');
    if (!file || !projectId || !show) throw new Error('需要 --project-id、--show、--output');
    if (fs.existsSync(file)) throw new Error('拒绝覆盖已有节目合同');
    writeJsonAtomic(file, episodeTemplate(projectId, show));
    console.log(JSON.stringify({status:'draft', output:path.resolve(file), note:'填写实际证据后检查；此模板不代表验收通过。'}));
  } else if (args[0] === 'bind') {
    const episode = option('--episode'), contractFile = option('--contract');
    if (!episode || !contractFile) throw new Error('需要 --episode 和 --contract');
    const contract = readJson(contractFile), profile = contract.policies?.productionProfile;
    if (contract.kind !== 'kacha-production-quality-contract' || profile?.packId !== 'dahui-ai') throw new Error('只能绑定大灰AI生产合同');
    const report = validateEpisode(path.resolve(episode), {expectedProjectId:contract.projectId,expectedShowId:profile.showId});
    if (report.status !== 'pass') throw new Error(report.errors.join('\n'));
    contract.episodeEditorial={path:path.resolve(episode),sha256:sha256File(episode)};
    if(option('--requirements')) contract.editorialPolicy.requirements={path:path.resolve(option('--requirements')),sha256:sha256File(option('--requirements'))};
    writeJsonAtomic(contractFile,contract);
    console.log(JSON.stringify({status:'bound',contract:path.resolve(contractFile),note:'只更新证据绑定；需重新执行相应质量检查。'}));
  } else if (args[0] === 'validate') {
    const file = option('--episode');
    if (!file) throw new Error('需要 --episode FILE');
    const result = validateEpisode(path.resolve(file), {stage:option('--stage','plan'), timeline:option('--timeline')});
    console.log(JSON.stringify(result,null,2));process.exitCode = result.status === 'pass' ? 0 : 1;
  } else throw new Error('用法：kacha episode list|template|bind|validate');
} catch (error) { console.error(error.message); process.exitCode=1; }
