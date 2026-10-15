import fs from 'node:fs';
import { fileIdentity, sha256Value } from './kacha_utils.mjs';

// These are task contracts, not claims that an installed version/account supports them.
export const jianyingCapabilities = Object.freeze([
  { id: 'beauty', name: '自然美颜', phase: 'source', trigger: '明确要求自然修饰人物', review: ['同帧开关对比', '说话转头眨眼无闪烁', '身份、五官和肤色保持'] },
  { id: 'denoise', name: '音频降噪', phase: 'source', trigger: '底噪确实影响可懂度', review: ['同响度盲听', '尾音、呼吸和真实环境声保留', '无水声和抽吸'] },
  { id: 'voice-enhance', name: '人声美化', phase: 'source', trigger: '人声闷、薄或不清楚', review: ['保持本人音色和表达', '无齿音放大、削波和金属声', '不要重复降噪或母带处理'] },
  { id: 'image-enhance', name: '画质提升', phase: 'source', trigger: '压缩、噪点或清晰度问题', review: ['同尺寸前后对比', '细字、面部和边缘无伪细节', '无锐化白边或时域闪烁'] },
  { id: 'stabilize', name: '视频防抖', phase: 'source', trigger: '无意抖动影响观看', review: ['裁切不损失重要内容', '无果冻、变形和边缘拉伸'] },
  { id: 'deflicker', name: '视频去闪烁', phase: 'source', trigger: '照明或显示屏出现闪烁', review: ['曝光和颜色稳定', '真实屏幕内容与运动保持'] },
  { id: 'cutout', name: '抠像与背景处理', phase: 'source', trigger: '明确需要主体分离', review: ['头发、眼镜和手部边缘', '快速运动与遮挡不穿帮', '背景来源许可'] },
  { id: 'color-match', name: '调色与镜头匹配', phase: 'source', trigger: '镜头间白平衡或曝光不一致', review: ['肤色自然', '高光阴影不丢失', '保持 SDR 和源尺寸'] },
  { id: 'transition', name: '转场', phase: 'assembly', trigger: '时间、地点或叙事阶段发生切换', review: ['切点与声音同步', '不吞字和改变总时长', '相邻镜头需要的 handles 已准备'] },
  { id: 'effect', name: '画面与人物特效', phase: 'assembly', trigger: '明确叙事动作需要对应效果', review: ['同屏单一主焦点', '不挡字幕、人物或证据', '有声音效不意外进入混音'] },
  { id: 'keyframe', name: '关键帧与跟踪', phase: 'assembly', trigger: '局部强调或目标跟随', review: ['运动连续、目标不漂移', '阅读时间与安全区', '无意外缩放裁切'] },
]);
const text = (v, label) => { if (typeof v !== 'string' || !v.trim()) throw Error(`${label} 必填`); return v; };
const digest = v => { const c = structuredClone(v); delete c.digest; return sha256Value(c); };
const identity = v => {
  if (!v?.path || !v.sha256 || fileIdentity(v.path).sha256 !== v.sha256) throw Error('增强证据文件身份变化');
  return v;
};
export function buildJianyingEnhancementPlan(manifest, requests) {
  if (manifest.tool !== 'jianying') throw Error('增强计划只适用于 jianying 素材包');
  if (!Array.isArray(requests) || !requests.length) throw Error('operations 必须是非空数组');
  const seen = new Set();
  const operations = requests.map((r, index) => {
    const capability = jianyingCapabilities.find(x => x.id === r.capability);
    if (!capability) throw Error(`未知增强能力：${r.capability}`);
    if (!Array.isArray(r.clipIds) || !r.clipIds.length || new Set(r.clipIds).size !== r.clipIds.length || r.clipIds.some(id => !manifest.clips.some(c => c.id === id))) throw Error('clipIds 必须准确引用素材包片段');
    if (['denoise', 'voice-enhance'].includes(r.capability) && !manifest.media.audio) throw Error('无音轨素材不能请求人声处理');
    if (r.capability === 'transition') {
      const positions = r.clipIds.map(id => manifest.clips.findIndex(c => c.id === id));
      if (positions.length !== 2 || positions[1] !== positions[0] + 1) throw Error('转场必须指定按时间顺序相邻的两个片段');
    }
    // Transitions belong to cut boundaries; adjacent cuts legitimately share a clip.
    const keys = r.capability === 'transition'
      ? [JSON.stringify([r.capability, ...r.clipIds])]
      : r.clipIds.map(id => JSON.stringify([r.capability, id]));
    for (const key of keys) { if (seen.has(key)) throw Error('同一片段或切点重复请求同种处理'); seen.add(key); }
    return { id: `op-${index + 1}`, capability: r.capability, name: capability.name, reason: text(r.reason, '处理原因'), clipIds: r.clipIds, phase: capability.phase, review: capability.review, status: 'requires_live_ui_check' };
  });
  const plan = { schemaVersion: '1.0', kind: 'kacha-jianying-enhancements', packageDigest: manifest.digest, originalTimeline: manifest.timeline, output: manifest.output, operations,
    execution: 'agent_observed_ui', status: 'planned_not_executed', membership: 'unknown',
    requirements: ['核验当前安装、登录、会员和具体功能权益', '当前界面观察后逐步操作，不使用固定坐标宏', '源处理在字幕、配乐和包装前完成；同类处理不可叠加', '先做代表短段 A/B，保留源片和独立剪映工程', '出现额外费用、云端上传或新协议时按实际授权处理', '导出保持素材包几何、帧率、总帧数和音轨；receive 后审阅当前候选'],
  };
  plan.digest = digest(plan); return plan;
}
export function validateJianyingEnhancementRecord(manifest, plan, record, outputIdentity) {
  if (manifest.tool !== 'jianying' || plan?.kind !== 'kacha-jianying-enhancements' || plan.digest !== digest(plan) || plan.packageDigest !== manifest.digest) throw Error('增强计划与当前素材包不匹配');
  // Rebuild semantic checks as well as verifying the digest: a checksum is not validation.
  if (buildJianyingEnhancementPlan(manifest, plan.operations).digest !== plan.digest) throw Error('增强计划内容不符合当前合同');
  if (record?.planDigest !== plan.digest || record.exportSha256 !== outputIdentity.sha256) throw Error('增强记录与计划或本次导出不匹配');
  text(record.applicationVersion, '剪映版本'); text(record.projectName, '独立工程名称');
  if (!['active', 'inactive', 'unknown'].includes(record.membership)) throw Error('会员状态无效');
  if (!Array.isArray(record.operations) || record.operations.length !== plan.operations.length || new Set(record.operations.map(x => x.id)).size !== plan.operations.length) throw Error('增强操作记录缺失或重复');
  for (const op of plan.operations) {
    const done = record.operations.find(x => x.id === op.id);
    if (!done || done.status !== 'applied' || !['free', 'included'].includes(done.entitlement)) throw Error('操作未应用或权益未核验；付费处理需独立授权流程');
    if (done.entitlement === 'included' && record.membership !== 'active') throw Error('会员权益需要当前有效会员证据');
    text(done.settings, '实际参数');
    if (!Array.isArray(done.evidence) || !done.evidence.length) throw Error('缺少实际操作证据');
    done.evidence.forEach(identity);
  }
  if (record.membership === 'active') identity(record.membershipEvidence);
  return { planDigest: plan.digest, applicationVersion: record.applicationVersion, operations: record.operations, status: 'operator_recorded_requires_review', qualityVerified: false };
}
export function writeEnhancementPlan(file, plan) { fs.writeFileSync(file, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' }); return fileIdentity(file); }
