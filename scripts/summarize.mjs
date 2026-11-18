import {readFileSync,readdirSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(process.argv[2]??'artifacts/final-measurements');
const output=resolve(process.argv[3]??'.scratch/orei-v1/evidence/measurements.json');
const median=a=>{a=[...a].sort((x,y)=>x-y);return a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;};
const describe=a=>({n:a.length,median:median(a),min:Math.min(...a),max:Math.max(...a)});
const rows=[];
for(const name of readdirSync(root).filter(n=>existsSync(resolve(root,n,'launch.json')))){
 const dir=resolve(root,name);const launch=JSON.parse(readFileSync(resolve(dir,'launch.json'),'utf8'));
 const events=readFileSync(resolve(dir,'events.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l).event);
 assert(!events.some(e=>e.type==='failure'),`${name} failed`);assert(events.some(e=>e.type==='done'),`${name} incomplete`);
 const editing=events.find(e=>e.type==='editing'),exp=events.find(e=>e.type==='export');assert(editing&&exp,`${name} missing workload`);
 assert.equal(editing.milliseconds.length,10);assert.equal(exp.milliseconds.length,3);
 const samples=JSON.parse(readFileSync(resolve(dir,'samples.json'),'utf8'));const owned=new Set(launch.attributedPids);
 const rss={};const footprints={};
 for(const phase of ['idle','editing','export']){
  const byProcess={};for(const sample of samples.filter(s=>s.phase===phase))for(const p of sample.processes.filter(p=>owned.has(p.pid))){const role=p.pid===launch.pid?'native':p.command.includes('WebContent')?'webContent':p.command.includes('WebKit.GPU')?'gpu':p.command.includes('WebKit.Networking')?'networking':'helper';byProcess[role]=Math.max(byProcess[role]??0,p.rssKiB*1024);}
  rss[phase]=byProcess;
  const file=resolve(dir,`footprint-${phase}.txt`);const match=existsSync(file)?readFileSync(file,'utf8').match(/Summary Footprint: (\d+) B/):null;footprints[phase]=match?Number(match[1]):null;
 }
 rows.push({...launch,editing:editing.milliseconds,exports:exp.milliseconds,scale:exp.scale,width:exp.width,height:exp.height,sourceBytes:exp.sourceBytes,rssPeaksBytes:rss,phaseFootprintBytes:footprints});
}
const summary={};for(const scenario of [...new Set(rows.map(r=>r.scenario))]){const runs=rows.filter(r=>r.scenario===scenario);summary[scenario]={runs:runs.length,startupMs:describe(runs.map(r=>r.readyAcknowledgedMs)),editingMs:describe(runs.flatMap(r=>r.editing)),exportMs:describe(runs.flatMap(r=>r.exports)),scale:runs[0].scale,width:runs[0].width,height:runs[0].height,phaseFootprintBytes:Object.fromEntries(['idle','editing','export'].map(phase=>[phase,describe(runs.map(r=>r.phaseFootprintBytes[phase]).filter(v=>v!==null))])),rssPeakBytes:Object.fromEntries(['idle','editing','export'].map(phase=>[phase,Object.fromEntries(['native','webContent','gpu','networking','helper'].map(role=>[role,Math.max(...runs.map(r=>r.rssPeaksBytes[phase][role]??0))]))]))};}
assert.equal(Object.keys(summary).length,5,'All five scenarios required');mkdirSync(resolve(output,'..'),{recursive:true});writeFileSync(output,JSON.stringify({root,method:'Per-process RSS high-water samples; no RSS sum. One multi-PID footprint snapshot per phase; deduplicated Summary Footprint.',summary,rows},null,2));console.log(JSON.stringify(summary,null,2));
