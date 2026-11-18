import {invoke} from '@tauri-apps/api/core';
import {fixtures} from './fixtures';
import {renderDiagram,type Snapshot} from './rendering';
import {png} from './output';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const frame=()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())));
const event=(value:object)=>invoke('evidence_event',{event:value});
function assert(ok:unknown,message:string):asserts ok {if(!ok)throw new Error(message);}
async function until(fn:()=>unknown,message:string){const start=performance.now();while(!fn()){if(performance.now()-start>30000)throw new Error(message);await delay(25);}await frame();}
function button(name:string){const el=[...document.querySelectorAll<HTMLButtonElement>('button')].find(e=>(()=>{const clone=e.cloneNode(true) as HTMLElement;clone.querySelectorAll('[aria-hidden=true]').forEach(n=>n.remove());return clone.textContent?.trim()===name;})() || e.getAttribute('aria-label')===name);assert(el,`Missing control ${name}`);return el;}
function input(label:string,value:string){const el=document.querySelector<HTMLInputElement|HTMLTextAreaElement>(`[aria-label="${label}"]`)!;assert(el,`Missing input ${label}`);const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
function preview(){return document.querySelector('[data-testid="preview"]')?.shadowRoot?.querySelector('svg');}
function previewStatus(){return document.querySelector('.editor-diagnostic-status')?.textContent||document.querySelector('.render-status')?.textContent;}
async function current(){await frame();await until(()=>previewStatus()==='Current preview','Preview never became current');}
async function artifact(name:string,bytes:Uint8Array){await invoke('evidence_artifact',{name,bytes:Array.from(bytes)});}
async function image(blob:Blob){const url=URL.createObjectURL(blob);try{const img=new Image();img.src=url;await img.decode();return img;}finally{URL.revokeObjectURL(url);}}
async function outputProof(){
  const fontDoc={source:'flowchart LR\n A[iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii]',css:'',assets:{}};
  const normal=await renderDiagram(fontDoc,{mode:'fixed',width:900});
  const mono=await renderDiagram({...fontDoc,css:'.pele { --pele-font: monospace; }'},{mode:'fixed',width:900});
  assert(mono.width-normal.width>50,'Global font not measured before layout');
  await event({type:'assertion',name:'global-font-measurement',pass:true,normalWidth:normal.width,monoWidth:mono.width});
  const snapshot=await renderDiagram(fixtures.small,{mode:'fixed',width:900});
  const svg=new DOMParser().parseFromString(snapshot.svg,'image/svg+xml');
  assert([...svg.querySelectorAll('text')].some(e=>e.textContent==='Ordinary label'),'Normal labels lost');
  assert(svg.querySelector('[data-mml-node] path'),'Math has no vector paths');
  assert(!svg.querySelector('use,foreignObject'),'Output depends on external glyph cache/HTML');
  for(const icon of ['lucide:house','fixture:star','fixture:diamond'])assert(svg.querySelector(`[data-icon="${icon}"] path`),`Missing icon ${icon}`);
  assert(svg.querySelector('image')?.getAttribute('href')?.startsWith('data:image/png;base64,'),'Local image is not embedded');
  const raster=await png(snapshot,2);
  const decoded=await image(raster);
  assert(decoded.naturalWidth===snapshot.width*2&&decoded.naturalHeight===snapshot.height*2,'PNG dimensions do not follow scale');
  await artifact('small.svg',new TextEncoder().encode(snapshot.svg));await artifact('small-2x.png',new Uint8Array(await raster.arrayBuffer()));
  const transparent=await png(snapshot,1,true);const transparentImage=await image(transparent);
  const canvas=document.createElement('canvas');canvas.width=transparentImage.naturalWidth;canvas.height=transparentImage.naturalHeight;const ctx=canvas.getContext('2d')!;ctx.drawImage(transparentImage,0,0);
  assert(ctx.getImageData(0,0,1,1).data[3]===0,'Transparent canvas is opaque');
  assert(ctx.getImageData(0,0,canvas.width,canvas.height).data.some((n,i)=>i%4===3&&n===255),'Opaque diagram shapes disappeared');
  await event({type:'assertion',name:'standalone-vector-assets-scaled-PNG-transparency',pass:true,width:snapshot.width,height:snapshot.height,pngBytes:raster.size});
}
async function interactionProof(source:HTMLTextAreaElement){
  const before=source.value;
  const key=(element:HTMLElement,key:string,extra:KeyboardEventInit={})=>element.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));
  source.focus();source.setSelectionRange(0,0);key(source,'Tab');await frame();
  assert(source.value==='  '+before&&document.activeElement===source&&source.selectionStart===2,'Tab did not indent at the caret');
  key(source,'z',{metaKey:true});await frame();
  assert(source.value===before&&Number(source.selectionStart)===0&&Number(source.selectionEnd)===0,'Shortcut Undo did not restore text and caret');
  key(source,'z',{metaKey:true,shiftKey:true});await frame();
  assert(source.value==='  '+before&&Number(source.selectionStart)===2,'Shortcut Redo did not restore text and caret');
  button('Undo').click();await frame();assert(source.value===before,'Toolbar Undo disagrees with keyboard history');
  const divider=document.querySelector<HTMLElement>('[role=separator][aria-label="Editor pane width"]')!;
  const editor=document.querySelector('.editor')!;const width=editor.getBoundingClientRect().width;
  divider.focus();key(divider,'ArrowRight');await frame();
  assert(editor.getBoundingClientRect().width>width,'Divider keyboard command did not resize actual layout');
  key(divider,'ArrowLeft');await frame();assert(Math.abs(editor.getBoundingClientRect().width-width)<1,'Divider keyboard resize did not restore layout');
  await event({type:'assertion',name:'programmatic-Tab-shortcut-Undo-Redo-toolbar-caret-keyboard-divider',pass:true,physicalKeyboard:false,pointerDrag:false});
}
async function smoke(){
  await outputProof();
  const before=preview()!.outerHTML;
  const appearance=document.querySelector<HTMLButtonElement>('[aria-label="App appearance"]')!;
  for(const name of ['Light','Dark']) {appearance.click();await until(()=>document.querySelector('[role=option]'),'Appearance options unavailable');[...document.querySelectorAll<HTMLElement>('[role=option]')].find(e=>e.textContent===name)!.click();await frame();assert(preview()!.outerHTML===before,'App appearance changed the diagram');await event({type:'assertion',name:`${name}-appearance-isolation`,pass:true});}
  const source=document.querySelector<HTMLTextAreaElement>('[aria-label="Diagram source"]')!;
  source.focus();assert(document.activeElement===source,'Source cannot receive focus');
  input('Diagram source','flowchart LR\n A[Native workflow label] --> B[Output]');await current();assert(preview()!.textContent?.includes('Native workflow label'),'Edited source not visible');
  await interactionProof(source);
  button('Styling').click();await frame();input('--pele-surface value','#fef3c7');await current();assert((document.querySelector('[aria-label="Diagram stylesheet"]') as HTMLTextAreaElement).value.includes('#fef3c7'),'Palette did not edit CSS');
  button('Diagram').click();await frame();
  input('Diagram source',fixtures.small.source);await current();
  const fixed=preview()!.getAttribute('viewBox');const fixedWidth=Number(preview()!.getAttribute('width'));
  await invoke('evidence_resize',{width:760});await delay(250);assert(preview()!.getAttribute('viewBox')===fixed,'Fixed composition reflowed');
  button('Responsive').click();await current();
  const narrow={viewBox:preview()!.getAttribute('viewBox'),viewport:innerWidth,pane:document.querySelector('.preview-pane')!.clientWidth};
  await invoke('evidence_resize',{width:1600});await delay(500);await current();
  const wide={viewBox:preview()!.getAttribute('viewBox'),viewport:innerWidth,pane:document.querySelector('.preview-pane')!.clientWidth};
  await event({type:'resize-proof',narrow,wide,fixedWidth});
  // A reflow assertion requires actual widths on opposite sides of the fixture's natural width.
  if(narrow.pane-32<fixedWidth&&wide.pane-32>=fixedWidth){
    assert(wide.viewBox!==narrow.viewBox,'Responsive composition did not adapt to native window width');
    await event({type:'assertion',name:'responsive-cross-width-layout',pass:true});
  }else await event({type:'limitation',name:'native-resize',detail:'Requested 760 and 1600 px did not produce preview widths across the natural diagram width. Cross-width reflow remains unverified.',narrow,wide});
  const exporter=button('Export');exporter.focus();exporter.click();await until(()=>document.querySelector('[role=dialog]'),'Export dialog unavailable');
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));await until(()=>!document.querySelector('[role=dialog]'),'Escape did not dismiss export');assert(document.activeElement===exporter,'Export focus not restored');
  input('Diagram source','not a diagram');await until(()=>previewStatus()?.includes('Preview out of date'),'Invalid source not reported');assert(exporter.disabled,'Invalid source can export');assert(preview()!.textContent?.includes('Ordinary label'),'Last valid preview lost');
  await event({type:'assertion',name:'editing-palette-fixed-focus-Escape-stale-output',pass:true});
}
async function seedSamples(){
  // Samples are requested explicitly so a normal launch starts from the restored or clean
  // workspace, and the evidence workspace is never persisted over the user's drafts.
  const names=Object.keys(fixtures);
  if(!names.length)return;
  window.dispatchEvent(new CustomEvent('orei-evidence-samples',{detail:{documents:fixtures,active:'small'}}));
  await until(()=>document.querySelectorAll('[role=tab]').length===names.length,'Evidence samples did not load');
}
let started=false;
export async function startRunner(effectMs?:number){
  if(started)return;started=true;
  const runnerMs=performance.now();
  let context: {scenario?:string;run?:string};
  try{context=await invoke('evidence_context');}
  catch(error){
    try{await event({type:'failure',error:String(error),stage:'evidence_context'});}
    catch(reportError){console.error('Could not report evidence context failure',error,reportError);}
    return;
  }
  if(!context.scenario)return;
  try{
    if(effectMs!==undefined)await event({type:'boundary',name:'app-effect',web_ms:effectMs});
    await event({type:'boundary',name:'runner-start',web_ms:runnerMs});
    await event({type:'boundary',name:'context-received',web_ms:performance.now()});
    const scenario=context.scenario;
    await seedSamples();
    if(scenario in fixtures && scenario!=='small'){button(scenario).click();}
    await event({type:'boundary',name:'before-current',web_ms:performance.now(),status:previewStatus()});
    await current();await event({type:'boundary',name:'after-current',web_ms:performance.now()});await event({type:'ready',scenario,run:context.run,userAgent:navigator.userAgent,resources:performance.getEntriesByType('resource').map(e=>e.name)});
    if(scenario==='smoke'){await smoke();await event({type:'done',scenario,resources:performance.getEntriesByType('resource').map(e=>e.name)});return;}
    if(scenario==='multiple'){button('Multiple documents').click();await until(()=>document.querySelectorAll('.held-document').length===4,'Multiple-document fixtures failed');await Promise.all([...document.querySelectorAll<HTMLImageElement>('.held-document')].map(e=>e.decode()));}
    await event({type:'phase',phase:'idle'});await delay(2000);
    const source=document.querySelector<HTMLTextAreaElement>('[aria-label="Diagram source"]')!.value;
    await event({type:'phase',phase:'editing'});
    const edits=[];
    for(let i=0;i<10;i++){const start=performance.now();input('Diagram source',source+`\n X[Edited ${i}]`);await until(()=>preview()?.textContent?.includes(`Edited ${i}`)&&previewStatus()==='Current preview','Edit did not paint');edits.push(performance.now()-start);}
    await event({type:'editing',milliseconds:edits});
    await event({type:'phase',phase:'export'});
    const svg=preview()!;const snapshot:Snapshot={svg:svg.outerHTML,width:Number(svg.getAttribute('width')),height:Number(svg.getAttribute('height'))};
    const scale=scenario==='stress'?2:4;const times=[];
    for(let i=0;i<3;i++){const start=performance.now();const result=await png(snapshot,scale);times.push(performance.now()-start);if(i===0){await artifact(`${scenario}.svg`,new TextEncoder().encode(snapshot.svg));await artifact(`${scenario}-${scale}x.png`,new Uint8Array(await result.arrayBuffer()));}}
    await event({type:'export',scale,milliseconds:times,width:snapshot.width,height:snapshot.height,sourceBytes:source.length});
    await delay(500);await event({type:'done',scenario});
  }catch(error){
    try{await event({type:'failure',error:String(error),status:previewStatus()});}
    catch(reportError){console.error('Could not report evidence runner failure',error,reportError);}
  }
}
