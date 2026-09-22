// Select the exact clip dependency closure in OUTPUT time. Transition overlap
// belongs to both clips; preserve its phase and trim only safe outer handles.
export function previewClosure(edl,transitions,range,fps){
 if(!range)return {edl,transitions,origin:0,trim:null};
 const frame=1/fps,spans=[];let cursor=0;
 edl.forEach((clip,i)=>{spans.push({start:cursor,end:cursor+clip.duration});cursor+=clip.duration-Number(transitions[i]?.durationSeconds??0);});
 const indexes=spans.map((s,i)=>s.end>range.start+1e-8&&s.start<range.end-1e-8?i:-1).filter(i=>i>=0);
 if(!indexes.length)throw new Error('preview range misses all clips');
 const first=indexes[0],last=indexes.at(-1);
 const selected=edl.slice(first,last+1).map(c=>({...c}));
 const joins=transitions.slice(first,last).map((t,i)=>({...t,boundaryIndex:i}));
 const leftOverlap=Number(joins[0]?.durationSeconds??0);
 const trimStart=Math.max(0,Math.min(range.start-spans[first].start,selected[0].duration-leftOverlap-(selected.length>1?frame:0)));
 selected[0].sourceStart+=trimStart;selected[0].duration-=trimStart;
 const end=selected.at(-1),rightOverlap=Number(joins.at(-1)?.durationSeconds??0);
 const safeEnd=Math.max(range.end-spans[last].start,rightOverlap+(selected.length>1?frame:0));
 const trimEnd=Math.max(0,spans[last].end-spans[last].start-safeEnd);
 end.sourceEnd-=trimEnd;end.duration-=trimEnd;
 const origin=spans[first].start+trimStart;
 return {edl:selected,transitions:joins,origin,trim:{start:Math.max(0,range.start-origin),end:range.end-origin},
 evidence:{originalClips:edl.length,selectedClips:selected.length,firstClip:first,lastClip:last,origin,reason:'transition_dependency_closure'}};
}
