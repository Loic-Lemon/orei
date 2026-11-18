import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js';
import type { MathMarkup } from 'pele';

const adaptor=liteAdaptor();
RegisterHTMLHandler(adaptor);
const tex=new TeX({packages:['base','ams'],maxBuffer:8192,formatError:(_jax:unknown,error:Error)=>{throw error;}});
const engine=mathjax.document('',{InputJax:tex,OutputJax:new SVG({fontCache:'none'})});

export function math(texSource:string,size:number):MathMarkup {
  const node=engine.convert(texSource,{display:false,em:size,ex:size*.442,containerWidth:1000});
  const markup=adaptor.outerHTML(node);
  const svg=new DOMParser().parseFromString(markup,'text/html').querySelector('svg');
  if(!svg || svg.querySelector('[data-mml-node="merror"]')) throw new Error('Math could not be typeset');
  const width=parseFloat(svg.getAttribute('width')!)*size*.442;
  const height=parseFloat(svg.getAttribute('height')!)*size*.442;
  svg.setAttribute('width',String(width)); svg.setAttribute('height',String(height));
  svg.removeAttribute('style');
  return {svg:svg.outerHTML,width,height};
}
