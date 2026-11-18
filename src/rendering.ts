import { render } from 'pele';
import { bundledIconMarkup } from './bundled-icons';
import { validateIconBody } from './icon-safety';
import { imageDataProblem, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE } from './image-import';

export interface DiagramDocument { source:string; css:string; assets:Record<string,string> }
export interface RenderSettings { mode:'fixed'|'responsive'; width:number }
export interface Snapshot { svg:string; width:number; height:number }

/**
 * Resolves one rendered `img:` reference against the document's stored images. Remote,
 * inline-data and missing references are refused with a diagnostic instead of being left
 * for the webview to fetch or silently rendering blank.
 */
export function localImageData(assets:Record<string,string>, reference:string):string {
  const shown=reference||'(no reference)';
  if(/^data:/i.test(reference)) throw new Error(`Inline image data is not supported in diagram source. Import the PNG so the document carries it as a local image.`);
  if(/^[a-z][a-z0-9+.-]*:|^\/\//i.test(reference)) throw new Error(`Remote image blocked: ${shown}. orei does not load images over the network; import a local PNG into the document instead.`);
  if(!Object.hasOwn(assets,reference)) {
    if(reference && !/\.png$/i.test(reference)) throw new Error(`Unsupported local image type: ${shown}. Only PNG images are supported.`);
    throw new Error(`Missing local image: ${shown}. Import it into this document, or keep the file beside a paired .mmd and reopen it.`);
  }
  const problem=imageDataProblem(reference,assets[reference]);
  if(problem) throw new Error(problem);
  return assets[reference];
}

// Pele's image-node syntax. Anchoring on `@{` keeps ordinary label text containing
// `img:` from being mistaken for a document image reference.
const declaredImage = /@\{[^}\r\n]*\bimg\s*:\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)')/g;

/**
 * Pele may drop an inline `data:` URL instead of emitting an `<image>` element, which would
 * leave a silently blank node. Diagnose non-local and inline references from the source
 * before rendering; relative local paths are resolved from the stored images afterwards.
 */
function rejectUnsupportedImageSources(source:string):void {
  for(const match of source.matchAll(declaredImage)){
    const reference=(match[1]??match[2]).trim();
    if(/^data:/i.test(reference)) throw new Error(`Inline image data is not supported in diagram source. Import the PNG so the document carries it as a local image.`);
    if(/^[a-z][a-z0-9+.-]*:|^\/\//i.test(reference)) throw new Error(`Remote image blocked: ${reference}. orei does not load images over the network; import a local PNG into the document instead.`);
  }
}

/**
 * Pele can emit duplicate ids for repeated node names or parallel edges under the native
 * canvas measurer. SVG resolves url(#id) to the first occurrence in document order, so
 * renaming later duplicates keeps every internal reference working while making the
 * exported document valid.
 */
export function dedupeSvgIds(root:Element):void {
  const seen=new Set<string>();
  let duplicate=0;
  for(const element of root.querySelectorAll('[id]')){
    const id=element.getAttribute('id')!;
    if(seen.has(id)) element.setAttribute('id',`${id}-orei-${++duplicate}`);
    else seen.add(id);
  }
}

export async function renderDiagram(doc:DiagramDocument, settings:RenderSettings):Promise<Snapshot> {
  if(doc.css.length>50000 || /\\|@(?:import|font-face|namespace)|url\s*\(/i.test(doc.css)) throw new Error('Offline stylesheet: imports, font downloads, URL resources and escapes are unavailable in this fixture slice');
  rejectUnsupportedImageSources(doc.source);
  const {math}=await import('./math');
  const icons=(name:string)=> {
    const body=name.startsWith('lucide:') ? bundledIconMarkup(name.slice(7)) : doc.assets[name];
    if(!body) throw new Error(`Missing icon: ${name}. Import it into this document or use the bundled lucide namespace.`);
    return validateIconBody(name, body);
  };
  const frame=document.createElement('iframe');
  frame.setAttribute('aria-hidden','true');frame.tabIndex=-1;
  frame.style.cssText='position:fixed;left:-100000px;width:1000px;height:1000px;visibility:hidden';
  document.body.append(frame);
  try {
  const scope=frame.contentDocument!;
  scope.head.innerHTML='<meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; style-src &apos;unsafe-inline&apos;; img-src data:">';
  const sheet=scope.createElement('style');sheet.textContent=doc.css;scope.head.append(sheet);
  const probe=scope.createElementNS('http://www.w3.org/2000/svg','svg');probe.classList.add('pele');scope.body.append(probe);
  await scope.fonts?.ready;
  const computed=frame.contentWindow!.getComputedStyle(probe);
  const fontFamily=computed.getPropertyValue('--pele-font').trim() || computed.fontFamily || 'sans-serif';
  const fontFamilyMono=computed.getPropertyValue('--pele-font-mono').trim() || 'monospace';
  const result = render(doc.source,{math,icons,fontFamily,fontFamilyMono,responsive:false,...(settings.mode==='responsive'?{maxWidth:settings.width}:{}),links:false});
  const svg = new DOMParser().parseFromString(result.svg,'image/svg+xml').documentElement;
  const imageSources:string[]=[];
  for(const image of svg.querySelectorAll('image')) {
    const ref=image.getAttribute('href') ?? image.getAttributeNS('http://www.w3.org/1999/xlink','href') ?? '';
    const data=localImageData(doc.assets,ref);
    imageSources.push(ref);
    image.removeAttributeNS('http://www.w3.org/1999/xlink','href');
    image.setAttribute('href',data);
  }
  const style = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg','style');
  style.textContent = doc.css;
  svg.prepend(style);
  const mounted=scope.importNode(svg,true) as unknown as SVGSVGElement;
  scope.body.replaceChildren(mounted);
  dedupeSvgIds(mounted);
  await scope.fonts?.ready;
  const properties=['color','fill','fill-opacity','fill-rule','stroke','stroke-width','stroke-opacity','stroke-dasharray','stroke-dashoffset','stroke-linecap','stroke-linejoin','stroke-miterlimit','font-family','font-size','font-weight','font-style','text-anchor','dominant-baseline','opacity','visibility','display','paint-order','letter-spacing','word-spacing','rx','ry'];
  const nodes=[mounted,...mounted.querySelectorAll<SVGElement>('*')].filter(e=>e.localName!=='style');
  const values=nodes.map(el=>{const computed=frame.contentWindow!.getComputedStyle(el);return properties.map(p=>[p,computed.getPropertyValue(p)] as const).filter(([,v])=>v&&!v.includes('var('));});
  // jsdom cannot resolve SVG variables; native checks exercise the fully materialized path.
  const canFreeze=typeof CSS!=='undefined' && typeof CSS.supports==='function' && CSS.supports('color','var(--x)');
  const bg=frame.contentWindow!.getComputedStyle(mounted).getPropertyValue('--pele-bg').trim()||'#ffffff';
  nodes.forEach((el,i)=>{if(canFreeze)el.removeAttribute('style');for(const [property,value] of values[i]){el.style.setProperty(property,value);if(canFreeze)el.removeAttribute(property);}});
  if(canFreeze){
    mounted.querySelectorAll('style').forEach(e=>e.remove());
    const background=scope.createElementNS('http://www.w3.org/2000/svg','rect');
    background.setAttribute('data-orei-canvas','');background.setAttribute('width',String(result.width));background.setAttribute('height',String(result.height));background.setAttribute('fill',bg);mounted.prepend(background);
    mounted.setAttribute('data-orei-background',bg);
  }
  for(const [index,image] of [...mounted.querySelectorAll('image')].entries()) {
    if(typeof Image.prototype.decode==='function'){
      const decoded=new Image();decoded.src=image.getAttribute('href')!;
      try { await decoded.decode(); }
      catch { throw new Error(`Local image ${imageSources[index]||'(no reference)'} could not be decoded as a PNG; the file may be corrupt or truncated despite a readable header.`); }
      const pixels=decoded.naturalWidth*decoded.naturalHeight;
      if(pixels>MAX_IMAGE_PIXELS || Math.max(decoded.naturalWidth,decoded.naturalHeight)>MAX_IMAGE_SIDE)throw new Error(`Local image ${imageSources[index]||'(no reference)'} is ${decoded.naturalWidth} × ${decoded.naturalHeight} px; the supported limit is ${MAX_IMAGE_SIDE} px per side and ${MAX_IMAGE_PIXELS.toLocaleString('en-US')} pixels in total.`);
    }
  }
  return {svg:new XMLSerializer().serializeToString(mounted),width:result.width,height:result.height};
  }finally{frame.remove();}
}
