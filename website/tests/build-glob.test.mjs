import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pluginRequire = createRequire(require.resolve('vite-plugin-dynamic-import'));
const glob = pluginRequire('fast-glob');

test('dynamic-import build glob preserves extension expansion, deduplication and relative paths', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'kacha-build-glob-'));
 try {
  for(const file of ['one.js','two.ts','nested/index.js','.hidden.js','unused.txt']){
   fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),'');
  }
  const matches=glob.sync(['./**/*.{js,ts}','./one.js'],{cwd:root}).sort();
  assert.deepEqual(matches,['nested/index.js','one.js','two.ts']);
  assert.deepEqual(glob.sync('./absent/*.js',{cwd:root}),[]);
  assert.throws(()=>glob.sync('*.js',{cwd:root,unknown:true}),/Unsupported/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
