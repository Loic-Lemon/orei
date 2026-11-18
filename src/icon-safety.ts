// Shared icon-content safety rules: the single validation path for icon bodies.
// Import (icon-import.ts), rendering (rendering.ts), and the paired asset codec
// (paired-document.ts, on both read and write) must enforce identical rules because
// Pele embeds the icon resolver's result as trusted markup in the output SVG:
// nothing active or external may pass, and unbounded resources are rejected clearly.

export const ICON_BODY_LIMIT=100000;
/** Characters for the source file. The native picker caps the same resource at 512 KiB in bytes. */
export const ICON_FILE_LIMIT=524288;
export const ICON_ELEMENT_LIMIT=2000;

const SVG_NS='http://www.w3.org/2000/svg';
// Safe drawing and internal-definition elements only. In particular there is no
// <script>, <style>, <foreignObject>, <image>, <a>, <filter> or animation.
const ICON_ELEMENTS=new Set(['svg','g','path','circle','ellipse','rect','line','polyline','polygon','defs','linearGradient','radialGradient','stop','clipPath','mask','symbol','use','title','desc']);

function inspectAttribute(name:string, attribute:Attr, ids:Set<string>){
  const attributeName=attribute.name.toLowerCase();
  const value=attribute.value.trim();
  if(attributeName.startsWith('on')) throw new Error(`Active content is not supported in icons: ${name}`);
  const local=attribute.localName.toLowerCase();
  if(local==='href'||local==='src'){
    if(!/^#[A-Za-z_][\w:.-]*$/.test(value)) throw new Error(`External or active icon reference is not supported: ${name}`);
    if(!ids.has(value.slice(1))) throw new Error(`Icon ${name} references a missing internal definition: ${value}`);
  }
  // url(#id) is the only resource reference allowed anywhere, including style attributes.
  for(const match of value.matchAll(/url\s*\(([^)]*)\)/gi)) {
    const target=match[1].trim();
    if(!/^#[A-Za-z_][\w:.-]*$/.test(target)) throw new Error(`External or active icon resource is not supported: ${name}`);
    if(!ids.has(target.slice(1))) throw new Error(`Icon ${name} references a missing internal definition: ${target}`);
  }
  if(/(?:^|[;\s"'(])(?:javascript|vbscript|data|file):/i.test(value)) throw new Error(`External or active icon resource is not supported: ${name}`);
}

function inspectIconDocument(name:string,parsed:Document){
  const root=parsed.documentElement;
  // The wrapper already carries the SVG namespace; a nested full <svg> must declare it too.
  if(root&&root.namespaceURI!==SVG_NS) throw new Error(`Unsupported icon content: ${name}`);
  const elements=[...parsed.querySelectorAll('*')];
  const ids=new Set<string>();
  for(const el of elements) {
    if(el.namespaceURI!==SVG_NS || !ICON_ELEMENTS.has(el.localName)) throw new Error(`Unsupported icon content: ${name}`);
    const id=el.getAttribute('id');
    if(id&&/^[A-Za-z_][\w:.-]*$/.test(id)) ids.add(id);
  }
  for(const el of elements) for(const attribute of el.attributes) inspectAttribute(name,attribute,ids);
}

function parseIconDocument(name:string,text:string){
  if(/<!DOCTYPE/i.test(text)) throw new Error(`Unsupported icon content: ${name}`);
  const parsed=new DOMParser().parseFromString(text,'image/svg+xml');
  if(parsed.querySelector('parsererror')) throw new Error(`Icon ${name} is not well-formed XML`);
  return parsed;
}

export function validateIconBody(name:string, body:string):string {
  if(body.length>ICON_BODY_LIMIT) throw new Error(`Icon ${name} exceeds the ${ICON_BODY_LIMIT}-character limit`);
  if(!body.trim()) throw new Error(`Icon ${name} is empty`);
  const parsed=parseIconDocument(name,`<svg xmlns="${SVG_NS}">${body}</svg>`);
  inspectIconDocument(name,parsed);
  return body;
}

// Imported files may carry any viewBox aspect ratio. Removing numeric width/height
// lets the nested <svg> fill Pele's 24px icon box while its own viewBox preserves
// the artwork's proportions; a missing viewBox cannot scale and is rejected.
function makeScalable(name:string,root:Element){
  const viewBox=root.getAttribute('viewBox')?.trim();
  if(viewBox){
    const parts=viewBox.split(/[\s,]+/).map(Number);
    if(parts.length!==4||!parts.every(Number.isFinite)||parts[2]<=0||parts[3]<=0) throw new Error(`Icon ${name} has an invalid viewBox`);
  } else {
    const dimension=(attribute:string)=>{
      const value=root.getAttribute(attribute)?.trim();
      const match=value?/^(\d+(?:\.\d+)?)(?:px)?$/i.exec(value):null;
      return match?Number(match[1]):undefined;
    };
    const width=dimension('width'),height=dimension('height');
    if(!width||!height) throw new Error(`Icon ${name} needs a viewBox, or numeric width and height, so it can scale inside a diagram`);
    root.setAttribute('viewBox',`0 0 ${width} ${height}`);
  }
  root.removeAttribute('width');
  root.removeAttribute('height');
}

// Pele places the body inside its own <svg fill="none" stroke="currentColor"
// stroke-width="2">. Those presentation attributes inherit, so a filled icon
// without explicit paint would render invisible and a plain icon would gain an
// unintended outline. Restore the SVG root defaults on the imported root; any
// paint the artwork sets for itself still wins.
function makeSelfContained(root:Element){
  if(!root.hasAttribute('fill')) root.setAttribute('fill','currentColor');
  if(!root.hasAttribute('stroke')) root.setAttribute('stroke','none');
  if(!root.hasAttribute('stroke-width')) root.setAttribute('stroke-width','1');
}

export function parseImportedIconSvg(name:string, text:string):string {
  if(text.length>ICON_FILE_LIMIT) throw new Error(`Icon ${name} is too large: the file exceeds ${ICON_FILE_LIMIT} characters`);
  const parsed=parseIconDocument(name,text);
  const root=parsed.documentElement;
  if(!root || root.localName!=='svg') throw new Error(`Icon ${name} must have a root <svg> element`);
  if(root.namespaceURI!==SVG_NS) throw new Error(`Icon ${name} must declare the SVG namespace xmlns="http://www.w3.org/2000/svg"`);
  if(1+root.querySelectorAll('*').length>ICON_ELEMENT_LIMIT) throw new Error(`Icon ${name} has too many elements: the limit is ${ICON_ELEMENT_LIMIT}`);
  inspectIconDocument(name,parsed);
  makeScalable(name,root);
  makeSelfContained(root);
  return validateIconBody(name,new XMLSerializer().serializeToString(root));
}
