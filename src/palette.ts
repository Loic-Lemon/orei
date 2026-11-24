/** Locate a single, complete top-level .pele rule without interpreting incomplete CSS. */
function inspectPalette(css:string): {start:number; end:number; bodyStart:number; bodyEnd:number} | null | undefined {
  let quote='', comment=false, depth=0, start=0, blockStart=-1;
  const matches:{start:number;end:number;bodyStart:number;bodyEnd:number}[]=[];
  for(let i=0;i<css.length;i++){
    const c=css[i], next=css[i+1];
    if(comment){if(c==='*'&&next==='/'){comment=false;i++;}continue;}
    if(quote){if(c==='\\'){i++;continue;}if(c===quote)quote='';continue;}
    if(c==='/'&&next==='*'){comment=true;i++;continue;}
    if(c==='"'||c==="'"){quote=c;continue;}
    if(c==='\\')return undefined;
    if(c==='{'){
      if(depth===0){
        const selector=css.slice(start,i).replace(/\/\*[\s\S]*?\*\//g,'').trim();
        blockStart=selector==='.pele'?i:-1;
      }
      depth++;
    }else if(c==='}'){
      if(depth===0)return undefined;
      depth--;
      if(depth===0){if(blockStart>=0)matches.push({start, end:i+1, bodyStart:blockStart+1, bodyEnd:i});start=i+1;blockStart=-1;}
    }else if(c===';'&&depth===0)start=i+1;
  }
  if(depth||quote||comment||css.slice(start).replace(/\/\*[\s\S]*?\*\//g,'').trim())return undefined;
  if(matches.length===0)return null;
  if(matches.length!==1)return undefined;
  const rule=matches[0], body=css.slice(rule.bodyStart,rule.bodyEnd);
  // Refuse ambiguous declarations rather than overwrite comments, strings, or nested syntax.
  const masked=body.replace(/\/\*[\s\S]*?\*\//g, m=>' '.repeat(m.length));
  if(/[{}"'()]/.test(masked)||masked.split(';').some(s=>s.trim()&&!/^\s*[\w-]+\s*:\s*[^:;]*$/.test(s)))return undefined;
  const names=[...masked.matchAll(/(?:^|;)\s*([\w-]+)\s*:/g)].map(m=>m[1]);
  if(new Set(names).size!==names.length)return undefined;
  return rule;
}
export function paletteRule(css:string) {
  return inspectPalette(css)??undefined;
}
export function paletteValues(css:string):Record<string,string> {
  const rule=paletteRule(css);if(!rule)return {};
  const body=css.slice(rule.bodyStart,rule.bodyEnd).replace(/\/\*[\s\S]*?\*\//g, m=>' '.repeat(m.length));
  return Object.fromEntries([...body.matchAll(/(?:^|;)\s*([\w-]+)\s*:[ \t]*([^;]*)/g)].map(([,name,value])=>[name,value.trim()]));
}
export function rewritePalette(css:string,name:string,value:string):string|undefined {
  const rule=paletteRule(css);if(!rule||!/^--pele-[\w-]+$/.test(name)||/[;{}]/.test(value))return undefined;
  const body=css.slice(rule.bodyStart,rule.bodyEnd);
  const masked=body.replace(/\/\*[\s\S]*?\*\//g, m=>' '.repeat(m.length));
  const matches=[...masked.matchAll(/(?:^|;)\s*([\w-]+)\s*:[ \t]*([^;]*)/g)].filter(m=>m[1]===name);
  if(matches.length>1)return undefined;
  if(matches.length){const m=matches[0], valueStart=rule.bodyStart+m.index!+m[0].length-m[2].length;const original=css.slice(valueStart,valueStart+m[2].length);if(original.includes('/*'))return undefined;const trailing=original.match(/\s*$/)![0];return css.slice(0,valueStart)+value+trailing+css.slice(valueStart+m[2].length);}
  const contentEnd=rule.bodyStart+body.trimEnd().length;
  const separator=body.trim()&&!body.trimEnd().endsWith(';')?';':'';
  const trailing=css.slice(contentEnd,rule.bodyEnd);
  return css.slice(0,contentEnd)+separator+`\n  ${name}: ${value};`+(trailing.includes('\n')?trailing:'\n'+trailing)+css.slice(rule.bodyEnd);
}

export function applyPalette(css:string,colors:Record<string,string>):string|undefined {
  const rule=inspectPalette(css);
  if(rule===undefined)return;
  let next=rule?css:`.pele {}\n${css}`;
  for(const [name,value] of Object.entries(colors)){
    const updated=rewritePalette(next,name,value);
    if(updated===undefined)return;
    next=updated;
  }
  return next;
}
