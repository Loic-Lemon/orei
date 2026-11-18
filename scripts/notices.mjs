import {readFileSync,readdirSync,existsSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname,join} from 'node:path';
let text='# Third-party notices\n\nGenerated from package-lock.json and Cargo.lock via `node scripts/notices.mjs`. Includes runtime packages and their upstream license/notice files; development-only npm packages are excluded.\n';
function append(name,dir,license){
  text+=`\n## ${name}\n\nLicense metadata: ${license??'see upstream license'}\n`;
  for(const file of readdirSync(dir).filter(n=>/^(licen[sc]e|copying|notice)([.-]|$)/i.test(n)))try{
    const content=readFileSync(join(dir,file),'utf8');if(content.length<200000)text+=`\n### ${file}\n\n\x60\x60\x60text\n${content}\n\x60\x60\x60\n`;
  }catch{}
}
const lock=JSON.parse(readFileSync('package-lock.json','utf8'));
for(const [path,pkg] of Object.entries(lock.packages))if(path&&!pkg.dev&&existsSync(join(path,'package.json'))){const meta=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));append(`${meta.name} ${meta.version}`,path,meta.license);}
const cargo=JSON.parse(execFileSync('cargo',['metadata','--filter-platform','aarch64-apple-darwin','--offline','--locked','--format-version','1','--manifest-path','src-tauri/Cargo.toml'],{encoding:'utf8',maxBuffer:20*1024*1024}));
for(const pkg of cargo.packages)if(pkg.name!=='orei')append(`${pkg.name} ${pkg.version}`,dirname(pkg.manifest_path),pkg.license);
writeFileSync('THIRD_PARTY_NOTICES.md',text);
