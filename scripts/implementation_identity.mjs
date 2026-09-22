import fs from 'node:fs';
import path from 'node:path';
import {sha256File,sha256Value} from './kacha_utils.mjs';
// Implementation identity follows the distributable source, not writable
// interpreter caches or a developer's virtual environment. External tools and
// models are bound separately by their runtime/asset contracts.
export function implementationIdentity(root){
 const entries=[];
 const ignored=new Set(['.venv','venv','__pycache__','node_modules','.git','.DS_Store']);
 function visit(directory){
  for(const item of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
   if(ignored.has(item.name)||item.name.endsWith('.pyc'))continue;
   const file=path.join(directory,item.name),relative=path.relative(root,file);
   if(item.isDirectory())visit(file);
   else if(item.isFile())entries.push({path:relative,sha256:sha256File(file)});
   else throw new Error(`实现目录含不支持的链接或文件：${relative}`);
  }
 }
 visit(root);return {path:path.resolve(root),files:entries.length,sha256:sha256Value(entries)};
}
