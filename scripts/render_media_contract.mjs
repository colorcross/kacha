// Explicitly supported final formats. Unsupported sources fail closed instead
// of silently becoming 8-bit 4:2:0. Preview reductions are reported separately.
export function renderMediaContract(video,mode,{complex=false}={}){
 const format=video.pix_fmt??'yuv420p';
 const supported=['yuv420p','yuvj420p','yuv422p','yuv444p','yuv420p10le','yuv422p10le','yuv444p10le'];
 const hdr=['smpte2084','arib-std-b67'].includes(video.color_transfer);
 if(hdr||(mode==='final'&&!supported.includes(format)))throw new Error('当前统一终编尚未验证此源位深/alpha/HDR；须显式保真渲染路径，禁止静默转换');
 const highBit=/10le$/.test(format);
 if(mode==='final'&&complex&&format!=='yuv420p'&&format!=='yuvj420p')throw new Error('高位深或非 4:2:0 的复杂滤镜组合尚未验证；禁止隐式格式退化');
 const pixelFormat=mode==='preview'?'yuv420p':format==='yuvj420p'?'yuv420p':format;
 const color={};
 for(const field of ['color_primaries','color_transfer','color_space','color_range'])if(video[field]&&video[field]!=='unknown'&&video[field]!=='unspecified')color[field]=video[field];
 return {sourcePixelFormat:format,pixelFormat,encoder:mode==='final'&&highBit?'libx265':mode==='final'&&pixelFormat!=='yuv420p'?'libx264':null,color,hdr,previewReduced:mode==='preview'&&format!==pixelFormat};
}
export function colorArguments(contract){
 const flags={color_primaries:'-color_primaries',color_transfer:'-color_trc',color_space:'-colorspace',color_range:'-color_range'};
 return Object.entries(contract.color).flatMap(([key,value])=>[flags[key],value]);
}
