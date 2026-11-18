import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
const app=resolve(process.env.OREI_APP??'artifacts/installed/orei.app');
const scenarios=(process.env.OREI_CASES??'small,medium,stress,math-heavy,multiple').split(',');
const runs=Number(process.env.OREI_RUNS??3);
const root=resolve(process.env.OREI_RESULTS??'artifacts/measurements');mkdirSync(root,{recursive:true});
function ps(){return execFileSync('/bin/ps',['-axo','pid=,ppid=,rss=,command=','-ww'],{encoding:'utf8'});}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
for(const scenario of scenarios)for(let run=1;run<=runs;run++){
  const dir=resolve(root,`${scenario}-${run}`);mkdirSync(dir,{recursive:true});
  if(existsSync(resolve(dir,'events.jsonl')))throw Error(`Refusing to overwrite ${dir}`);
  const before=ps();writeFileSync(resolve(dir,'processes-before.txt'),before);
  const preexisting=new Set(before.split('\n').map(l=>Number(l.trim().split(/\s+/)[0])));
  const start=performance.now();
  const child=spawn(resolve(app,'Contents/MacOS/orei'),[],{env:{...process.env,OREI_SCENARIO:scenario,OREI_RUN:String(run),OREI_EVIDENCE_DIR:dir},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  const samples=[];let ready;let phase='startup';let done=false;let lastEvents='';const candidates=new Set([child.pid]);const captured=new Set();const footprintJobs=[];let lastAttribution=0;const attributed=new Set([child.pid]);
  try{
    while(performance.now()-start<120000){
      if(performance.now()-lastAttribution>400){
        for(const pid of [...attributed])try{
          const domain=execFileSync('/bin/launchctl',['print',`pid/${pid}`],{encoding:'utf8',timeout:2000});
          writeFileSync(resolve(dir,`launchctl-pid-${pid}.txt`),domain.replace(/\n\tenvironment = \{[\s\S]*?\n\t\}/,'\n\tenvironment = { redacted }'));
          const services=domain.match(/\n\tservices = \{([\s\S]*?)\n\t\}/)?.[1]??'';
          for(const match of services.matchAll(/\n\s+(\d+)\s+[-\d]+\s+(.+)/g)){const helper=Number(match[1]);if(helper>0)attributed.add(helper);}
        }catch{}
        lastAttribution=performance.now();
      }
      const inventory=ps();
      const processes=inventory.split('\n').flatMap(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);if(!m)return [];const [pid,ppid,rss]=m.slice(1,4).map(Number);const command=m[4];if(attributed.has(pid)||(!preexisting.has(pid)&&/WebKit|orei\.app/.test(command))){candidates.add(pid);return [{pid,ppid,rssKiB:rss,command}];}return [];});
      const eventPath=resolve(dir,'events.jsonl');
      if(existsSync(eventPath)){lastEvents=readFileSync(eventPath,'utf8');for(const line of lastEvents.trim().split('\n')){let e;try{e=JSON.parse(line).event}catch{continue;}if(e.type==='ready'&&ready===undefined)ready=performance.now()-start;if(e.type==='phase')phase=e.phase;if(e.type==='failure'||e.type==='done')done=true;}}
      samples.push({ms:performance.now()-start,phase,processes});
      if(!captured.has(phase)&&phase!=='startup'){
        captured.add(phase);
        const footprintArgs=[...attributed].flatMap(pid=>['-p',String(pid)]);
        footprintJobs.push(new Promise(resolveJob=>{
          const proc=spawn('/usr/bin/footprint',['-f','bytes',...footprintArgs]);let result='';proc.stdout.on('data',d=>result+=d);proc.stderr.on('data',d=>result+=d);proc.on('close',()=>{writeFileSync(resolve(dir,`footprint-${phase}.txt`),result);resolveJob();});
        }));writeFileSync(resolve(dir,`processes-${phase}.txt`),inventory);
        try{writeFileSync(resolve(dir,`launchctl-${phase}.txt`),execFileSync('/bin/launchctl',['print',`pid/${child.pid}`],{encoding:'utf8',timeout:5000}));}catch(e){writeFileSync(resolve(dir,`launchctl-${phase}.txt`),String(e));}
      }
      if(done)break;
      if(child.exitCode!==null)throw Error(`App exited ${child.exitCode}`);
      await delay(100);
    }
    if(!done)throw Error('Evidence runner timed out');
    if(lastEvents.includes('\"type\":\"failure\"'))process.exitCode=1;
    for(const pid of candidates)try{writeFileSync(resolve(dir,`launchctl-pid-${pid}.txt`),execFileSync('/bin/launchctl',['print',`pid/${pid}`],{encoding:'utf8',timeout:5000}));}catch(e){writeFileSync(resolve(dir,`launchctl-pid-${pid}.txt`),String(e));}
    await Promise.all(footprintJobs);
    const args=[...attributed].flatMap(pid=>['-p',String(pid)]);
    try{writeFileSync(resolve(dir,'footprint-candidates.txt'),execFileSync('/usr/bin/footprint',['-f','bytes',...args],{encoding:'utf8',timeout:20000}));}catch(e){writeFileSync(resolve(dir,'footprint-candidates.txt'),String(e)+String(e.stdout??'')+String(e.stderr??''));}
  }catch(e){writeFileSync(resolve(dir,'runner-error.txt'),String(e));process.exitCode=1;}
  finally{
    writeFileSync(resolve(dir,'samples.json'),JSON.stringify(samples));
    writeFileSync(resolve(dir,'launch.json'),JSON.stringify({scenario,run,pid:child.pid,readyAcknowledgedMs:ready,candidatePids:[...candidates],attributedPids:[...attributed],app,definition:'direct installed bundle executable spawn to polling acknowledgement; two rAF readiness proxy, not visible TTFR'},null,2));
    writeFileSync(resolve(dir,'stdio.txt'),output);
    child.kill('SIGTERM');await delay(700);
    writeFileSync(resolve(dir,'processes-after.txt'),ps());
  }
  console.log(JSON.stringify({scenario,run,readyAcknowledgedMs:ready,events:lastEvents.trim().split('\n').length,failed:lastEvents.includes('"failure"')}));
}
