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
async function openSettings(){
  // The development harness uses the same native event the app menu emits; there is no
  // production toolbar control to click.
  const {emit}=await import('@tauri-apps/api/event');
  await emit('settings-request');
  await until(()=>document.querySelector('[role=dialog]'),'Settings dialog did not open');
}
async function chooseTheme(name:string){
  await openSettings();
  const dialog=document.querySelector<HTMLElement>('[role=dialog]')!;
  const option=[...dialog.querySelectorAll<HTMLElement>('[role=radio]')].find(element=>element.textContent?.includes(name));
  assert(option,`Missing appearance ${name}`);
  option.click();await frame();
  const done=[...dialog.querySelectorAll<HTMLButtonElement>('button')].find(element=>element.textContent?.trim()==='Done');
  assert(done,'Settings Done unavailable');done.click();
  await until(()=>!document.querySelector('[role=dialog]'),'Settings did not close');
}
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
  const probe={...fixtures.small,css:`${fixtures.small.css}\n@media (prefers-color-scheme: dark) { .pele { --pele-bg: #101820; } }`};
  const renderSettings={mode:'fixed',width:900} as const;
  const baseline=await renderDiagram(probe,renderSettings);
  const canvas=document.querySelector('.preview-scroll')!;
  const darkBackdrops=new Set<string>();
  for(const name of ['Light','Slate Dark','Ink Dark','Warm Dark']) {
    await chooseTheme(name);
    assert(preview()!.outerHTML===before,'App appearance changed the mounted diagram');
    const rerendered=await renderDiagram(probe,renderSettings);
    assert(rerendered.svg===baseline.svg,'App appearance changed a fresh diagram snapshot');
    if(name.endsWith('Dark'))darkBackdrops.add(getComputedStyle(canvas).backgroundColor);
    await event({type:'assertion',name:`${name.replace(' ','-')}-appearance-isolation`,pass:true});
  }
  assert(darkBackdrops.size===3,'Match app did not use each dark theme’s backdrop');
  const source=document.querySelector<HTMLTextAreaElement>('[aria-label="Diagram source"]')!;
  source.focus();assert(document.activeElement===source,'Source cannot receive focus');
  input('Diagram source','flowchart LR\n A[Native workflow label] --> B[Output]');await current();assert(preview()!.textContent?.includes('Native workflow label'),'Edited source not visible');
  await interactionProof(source);
  button('Styling').click();await frame();input('--pele-surface value','#fef3c7');await current();assert((document.querySelector('[aria-label="Diagram stylesheet"]') as HTMLTextAreaElement).value.includes('#fef3c7'),'Palette did not edit CSS');
  button('Diagram').click();await frame();
  assert(button('Responsive').getAttribute('aria-checked')==='true','Responsive preview is not the default');
  button('Fixed').click();
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
  // Fit-to-width: responsive zoom follows the pane until a manual zoom takes over.
  const zoomValue=()=>Number((document.querySelector('#preview-zoom') as HTMLInputElement).value);
  const paneContent=()=>document.querySelector('.preview-pane')!.clientWidth-32;
  const stageWidth=()=>document.querySelector('.preview-stage')!.getBoundingClientRect().width;
  const fitExpected=()=>Math.min(100,Math.round(paneContent()/Number(preview()!.getAttribute('width'))*100));
  const fitsPane=()=>stageWidth()<=paneContent()+Math.min(4,Number(preview()!.getAttribute('width'))/100);
  await invoke('evidence_resize',{width:760});await delay(500);await current();
  assert(fitsPane()&&zoomValue()===fitExpected(),'Responsive fit did not match the pane width');
  await event({type:'assertion',name:'responsive-fit-width',pass:true,zoom:zoomValue(),stage:stageWidth(),pane:paneContent()});
  await invoke('evidence_resize',{width:1600});await delay(500);await current();
  assert(fitsPane()&&zoomValue()===fitExpected(),'Responsive fit did not follow the pane resize');
  await event({type:'assertion',name:'responsive-fit-refit-on-resize',pass:true,zoom:zoomValue()});
  const fittedZoom=zoomValue();
  button('Zoom in').click();await frame();
  const manualZoom=zoomValue();
  assert(manualZoom>fittedZoom,'Zoom in did not increase the preview scale');
  await invoke('evidence_resize',{width:760});await delay(500);await current();
  assert(zoomValue()===manualZoom,'Manual zoom was overwritten by auto-fit');
  await event({type:'assertion',name:'responsive-fit-manual-override',pass:true});
  await invoke('evidence_resize',{width:1600});await delay(500);await current();
  button('Fit preview to pane width').click();await frame();await current();
  assert(fitsPane(),'Fit control did not re-engage fit');
  await event({type:'assertion',name:'responsive-fit-button',pass:true,zoom:zoomValue()});
  button('Fixed').click();await current();
  assert(preview()!.getAttribute('viewBox')===fixed,'Responsive fit changed the fixed composition');
  await event({type:'assertion',name:'responsive-fit-fixed-untouched',pass:true});
  button('Responsive').click();await current();
  // Overscroll: no rubber-band at the edges, native scrolling inside them.
  const scrollPane=document.querySelector<HTMLElement>('.preview-scroll')!;
  const nativeOverscroll=CSS.supports('overscroll-behavior','none');
  if(nativeOverscroll)assert(getComputedStyle(scrollPane).overscrollBehavior==='none','Preview canvas still allows overscroll bounce');
  const zoomInput=document.querySelector<HTMLInputElement>('#preview-zoom')!;
  zoomInput.focus();input('Preview zoom','200');await frame();zoomInput.blur();await frame();
  scrollPane.scrollTop=scrollPane.scrollHeight;await frame();
  const past=new WheelEvent('wheel',{deltaY:400,cancelable:true,bubbles:true});scrollPane.dispatchEvent(past);
  assert(past.defaultPrevented===!nativeOverscroll,'Overscroll did not use the expected native or fallback handling');
  scrollPane.scrollTop=Math.max(0,Math.round((scrollPane.scrollHeight-scrollPane.clientHeight)/2));await frame();
  const inside=new WheelEvent('wheel',{deltaY:-Math.min(50,scrollPane.scrollTop),cancelable:true,bubbles:true});scrollPane.dispatchEvent(inside);
  assert(!inside.defaultPrevented,'Wheel guard blocked scrolling inside the limits');
  await event({type:'assertion',name:'preview-no-overscroll-bounce',pass:true});
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
