// Iconify JSON collection packs: parsing, validation and the exact SVG body that
// Pele's icon resolver embeds in a diagram. Pele wraps every resolved body in its own
// 24px <svg fill="none" stroke="currentColor">, so this module resolves the collection's
// own dimensions, aliases and transforms the way Iconify does and returns a complete,
// inner <svg> that carries its viewBox. The resolved body goes through icon-safety.ts,
// the single validation path shared by import, render and the paired asset codec.
//
// Supported: collection defaults (width/height/left/top), per-icon dimensions,
// rotate/hFlip/vFlip, aliases (parent chains, merged transforms), hidden entries and
// the upstream `info` notice. Unsupported metadata (`chars`, `categories`, themes,
// font prefixes/suffixes, `not_found`) is recorded in `unsupported` instead of being
// guessed at; definitions are validated on import, so an unsupported body is refused
// rather than misrendered.

import { ICON_BODY_LIMIT, parseImportedIconSvg, validateIconBody } from './icon-safety';

/** Characters of collection JSON. The native picker caps the same file at 2 MiB. */
export const COLLECTION_TEXT_LIMIT=2*1024*1024;
/** Icons plus aliases in one collection; the bundled lucide pack has ~2,400. */
export const COLLECTION_ENTRY_LIMIT=4096;

const PREFIX_PATTERN=/^[a-z][a-z0-9-]{0,31}$/;
const NAME_PATTERN=/^[a-z0-9][a-z0-9_-]{0,63}$/;
const ICON_KEYS=new Set(['body','left','top','width','height','rotate','hFlip','vFlip','hidden']);
const ALIAS_KEYS=new Set(['parent','left','top','width','height','rotate','hFlip','vFlip','hidden']);
const ROOT_KEYS=new Set(['prefix','icons','aliases','left','top','width','height','info','lastModified','unsupported']);

export type IconNotice={
  name:string;version?:string;
  author:{name:string;url?:string};
  license:{title:string;spdx?:string;url?:string};
};

export type CollectionIconEntry={
  body:string;left?:number;top?:number;width?:number;height?:number;
  rotate?:number;hFlip?:boolean;vFlip?:boolean;hidden?:boolean;
};
export type CollectionAliasEntry={
  parent:string;left?:number;top?:number;width?:number;height?:number;
  rotate?:number;hFlip?:boolean;vFlip?:boolean;hidden?:boolean;
};

/** A validated Iconify collection, normalized to the fields the resolver uses. */
export type IconCollection={
  prefix:string;left:number;top:number;width:number;height:number;
  icons:Record<string,CollectionIconEntry>;
  aliases:Record<string,CollectionAliasEntry>;
  info?:IconNotice;
  lastModified?:number;
  /** Notes about input that was accepted but is not used, so it cannot be misread as applied. */
  unsupported:string[];
};

export type CollectionIconData={
  body:string;left:number;top:number;width:number;height:number;
  rotate:number;hFlip:boolean;vFlip:boolean;hidden:boolean;
};

export type IconSearchResult={prefix:string;name:string;reference:string;collection:IconCollection};
export type ResolvedIcon={reference:string;body:string;hidden:boolean};

type RawIcon=Partial<CollectionIconEntry>;
type RawAlias=Partial<CollectionAliasEntry>;

export function normalizeCollectionPrefix(value:string):string {
  const prefix=value.trim().toLowerCase();
  if(!PREFIX_PATTERN.test(prefix)) throw new Error(`Invalid icon collection namespace ${JSON.stringify(value)}: use 1-32 lowercase letters, digits or dashes starting with a letter`);
  return prefix;
}

function plainObject(value:unknown):value is Record<string,unknown> {
  return value!==null && typeof value==='object' && !Array.isArray(value);
}

function record(value:unknown,what:string):Record<string,unknown> {
  if(!plainObject(value)) throw new Error(`Invalid Iconify collection: ${what} must be an object`);
  return value;
}

function text(value:unknown,what:string):string {
  if(typeof value!=='string'||!value.trim()) throw new Error(`Invalid Iconify collection: ${what} must be a non-empty string`);
  return value;
}

function optionalText(value:unknown,what:string):string|undefined {
  if(value===undefined)return undefined;
  return text(value,what);
}

function numberField(value:unknown,what:string):number|undefined {
  if(value===undefined)return undefined;
  if(typeof value!=='number'||!Number.isFinite(value)) throw new Error(`Invalid Iconify collection: ${what} must be a finite number`);
  return value;
}

function dimensions(raw:Record<string,unknown>,label:string):Pick<CollectionIconEntry,'left'|'top'|'width'|'height'> {
  const left=numberField(raw.left,`${label} left`);
  const top=numberField(raw.top,`${label} top`);
  const width=numberField(raw.width,`${label} width`);
  const height=numberField(raw.height,`${label} height`);
  if(width!==undefined&&width<=0) throw new Error(`Invalid Iconify collection: ${label} width must be greater than zero`);
  if(height!==undefined&&height<=0) throw new Error(`Invalid Iconify collection: ${label} height must be greater than zero`);
  return {left,top,width,height};
}

function transformations(raw:Record<string,unknown>,label:string):Pick<CollectionIconEntry,'rotate'|'hFlip'|'vFlip'> {
  let rotate=numberField(raw.rotate,`${label} rotate`);
  if(rotate!==undefined){
    if(!Number.isInteger(rotate)) throw new Error(`Invalid Iconify collection: ${label} rotate must be a whole number of 90-degree steps`);
    rotate=((rotate%4)+4)%4;
  }
  const flip=(key:'hFlip'|'vFlip',name:string)=>{
    const value=raw[key];
    if(value===undefined)return undefined;
    if(typeof value!=='boolean') throw new Error(`Invalid Iconify collection: ${label} ${name} must be true or false`);
    return value;
  };
  return {rotate,hFlip:flip('hFlip','hFlip'),vFlip:flip('vFlip','vFlip')};
}

function hidden(raw:Record<string,unknown>,label:string):boolean|undefined {
  const value=raw.hidden;
  if(value===undefined)return undefined;
  if(typeof value!=='boolean') throw new Error(`Invalid Iconify collection: ${label} hidden must be true or false`);
  return value;
}

/** Retains the upstream notice verbatim enough to display it: name, author and license. */
function parseNotice(value:unknown):IconNotice|undefined {
  if(value===undefined)return undefined;
  const info=record(value,'collection info');
  const author=record(info.author,'collection info author');
  const license=record(info.license,'collection info license');
  return {
    name:text(info.name,'collection info name'),
    version:optionalText(info.version,'collection info version'),
    author:{name:text(author.name,'collection info author name'),url:optionalText(author.url,'collection info author url')},
    license:{title:text(license.title,'collection info license title'),spdx:optionalText(license.spdx,'collection info license spdx'),url:optionalText(license.url,'collection info license url')},
  };
}

function assertKnownKeys(raw:Record<string,unknown>,known:Set<string>,note:(key:string)=>void):void {
  for(const key of Object.keys(raw)) if(!known.has(key)) note(key);
}

/** Parses and validates one collection value; used for imported text and stored data. */
export function parseIconCollectionValue(value:unknown, namespace?:string, options:{validateBodies?:boolean}={}):IconCollection {
  const validateBodies=options.validateBodies!==false;
  const root=record(value,'the collection');
  const declaredPrefix=text(root.prefix,'the collection prefix');
  if(!PREFIX_PATTERN.test(declaredPrefix)) throw new Error(`Invalid Iconify collection: the prefix ${JSON.stringify(declaredPrefix)} must use lowercase letters, digits or dashes starting with a letter`);
  const prefix=normalizeCollectionPrefix(namespace??declaredPrefix);
  const defaults=dimensions(root,'the collection');
  const iconsRaw=record(root.icons,'the collection icons');
  const aliasesRaw=root.aliases===undefined?{}:record(root.aliases,'the collection aliases');
  const total=Object.keys(iconsRaw).length+Object.keys(aliasesRaw).length;
  if(total>COLLECTION_ENTRY_LIMIT) throw new Error(`Invalid Iconify collection: ${total} icons and aliases exceed the limit of ${COLLECTION_ENTRY_LIMIT}`);
  const notes=new Set<string>();
  const note=(message:string)=>void notes.add(message);
  const icons:Record<string,CollectionIconEntry>={};
  const aliases:Record<string,CollectionAliasEntry>={};
  for(const [name,raw] of Object.entries(iconsRaw)){
    if(!NAME_PATTERN.test(name)) throw new Error(`Invalid Iconify collection: ${JSON.stringify(name)} is not a valid icon name`);
    const entry=record(raw,`icon ${prefix}:${name}`);
    const label=`${prefix}:${name}`;
    assertKnownKeys(entry,ICON_KEYS,key=>note(`Ignored icon property "${key}" (${label}); it has no effect on the rendered SVG.`));
    const body=text(entry.body,`icon ${label} body`);
    if(body.length>ICON_BODY_LIMIT) throw new Error(`Icon ${label} exceeds the ${ICON_BODY_LIMIT}-character body limit`);
    // Same rules as imported SVGs: an unsupported definition is refused at import,
    // instead of entering the library and being misrendered or embedded later.
    if(validateBodies) validateIconBody(label,body);
    icons[name]={body,...dimensions(entry,label),...transformations(entry,label),hidden:hidden(entry,label)};
  }
  for(const [name,raw] of Object.entries(aliasesRaw)){
    if(!NAME_PATTERN.test(name)) throw new Error(`Invalid Iconify collection: ${JSON.stringify(name)} is not a valid alias name`);
    if(Object.hasOwn(icons,name)) throw new Error(`Invalid Iconify collection: ${JSON.stringify(name)} is defined as both an icon and an alias`);
    const entry=record(raw,`alias ${prefix}:${name}`);
    const label=`${prefix}:${name}`;
    assertKnownKeys(entry,ALIAS_KEYS,key=>note(`Ignored alias property "${key}" (${label}); it has no effect on the rendered SVG.`));
    if(Object.hasOwn(entry,'body')) throw new Error(`Invalid Iconify collection: alias ${label} must not define a body; alias bodies are unsupported`);
    const parent=text(entry.parent,`alias ${label} parent`);
    if(!NAME_PATTERN.test(parent)) throw new Error(`Invalid Iconify collection: alias ${label} has an invalid parent name`);
    if(!Object.hasOwn(icons,parent)&&!Object.hasOwn(aliasesRaw,parent)) throw new Error(`Invalid Iconify collection: alias ${label} refers to a missing icon or alias ${JSON.stringify(parent)}`);
    aliases[name]={parent,...dimensions(entry,label),...transformations(entry,label),hidden:hidden(entry,label)};
  }
  // Alias chains are resolved at render time; reject cycles once, with the path, so a
  // collection can never make resolution loop.
  const state=new Map<string,'visiting'|'done'>();
  const visit=(name:string,path:string[])=>{
    if(Object.hasOwn(icons,name)){state.set(name,'done');return;}
    if(state.get(name)==='done')return;
    if(state.get(name)==='visiting') throw new Error(`Invalid Iconify collection: alias cycle ${[...path,name].join(' -> ')}`);
    const alias=aliases[name];
    if(!alias) throw new Error(`Invalid Iconify collection: alias ${prefix}:${name} is missing`);
    state.set(name,'visiting');
    visit(alias.parent,[...path,name]);
    state.set(name,'done');
  };
  for(const name of Object.keys(aliases)) visit(name,[]);
  assertKnownKeys(root,ROOT_KEYS,key=>{
    const explanation=key==='chars'?'font character mappings are not used: orei renders SVG bodies, not icon fonts'
      :key==='categories'?'icon grouping is not used by orei'
      :key==='themes'||key==='prefixes'||key==='suffixes'?'themes and font prefixes/suffixes are not used by orei'
      :key==='not_found'?'the provider missing-icon list is not used'
      :key==='provider'?'the provider name is not used'
      :'it has no effect on the rendered SVG';
    note(`Ignored collection property "${key}": ${explanation}.`);
  });
  const lastModified=numberField(root.lastModified,'the collection lastModified');
  if(lastModified!==undefined&&lastModified<0) throw new Error('Invalid Iconify collection: lastModified must not be negative');
  if(root.unsupported!==undefined){
    if(!Array.isArray(root.unsupported)||root.unsupported.some(item=>typeof item!=='string')) throw new Error('Invalid Iconify collection: unsupported notes must be a list of strings');
    for(const item of root.unsupported) note(item);
  }
  return {
    prefix,
    left:defaults.left??0,
    top:defaults.top??0,
    width:defaults.width??16,
    height:defaults.height??16,
    icons,
    aliases,
    info:parseNotice(root.info),
    lastModified,
    unsupported:[...notes],
  };
}

/** Parses collection JSON text with its size cap, then validates the value. */
export function parseIconCollection(text:string, namespace?:string, options:{validateBodies?:boolean}={}):IconCollection {
  if(text.length>COLLECTION_TEXT_LIMIT) throw new Error(`The icon collection is too large: the file exceeds ${COLLECTION_TEXT_LIMIT} characters`);
  let value:unknown;
  try { value=JSON.parse(text); }
  catch { throw new Error('The icon collection is not valid JSON'); }
  return parseIconCollectionValue(value,namespace,options);
}

function mergeUnder(child:RawIcon,parent:RawIcon):RawIcon {
  // Iconify merges transformations across alias levels (rotate adds, flips XOR) and lets
  // the more specific level override dimensions; missing values fall back to the parent.
  return {
    body:child.body??parent.body,
    left:child.left??parent.left,
    top:child.top??parent.top,
    width:child.width??parent.width,
    height:child.height??parent.height,
    hidden:child.hidden??parent.hidden,
    rotate:(((child.rotate??0)+(parent.rotate??0))%4+4)%4,
    hFlip:Boolean(child.hFlip)!==Boolean(parent.hFlip),
    vFlip:Boolean(child.vFlip)!==Boolean(parent.vFlip),
  };
}

/** Resolves an icon's alias chain and collection defaults into complete icon data. */
export function collectionIconData(collection:IconCollection, name:string):CollectionIconData {
  const chain:RawIcon[]=[];
  const seen=new Set<string>();
  let current=name;
  for(;;){
    if(seen.has(current)) throw new Error(`Icon alias cycle: ${[...seen,current].join(' -> ')}`);
    seen.add(current);
    if(Object.hasOwn(collection.icons,current)){chain.push(collection.icons[current]);break;}
    if(!Object.hasOwn(collection.aliases,current)) throw new Error(`Icon ${collection.prefix}:${name} is not in this collection`);
    chain.push(collection.aliases[current]);
    current=collection.aliases[current].parent;
  }
  let merged:RawIcon=chain[0];
  for(const parent of chain.slice(1)) merged=mergeUnder(merged,parent);
  merged=mergeUnder(merged,{left:collection.left,top:collection.top,width:collection.width,height:collection.height});
  if(!merged.body) throw new Error(`Icon ${collection.prefix}:${name} has no definition`);
  return {
    body:merged.body,
    left:merged.left??0,
    top:merged.top??0,
    width:merged.width??16,
    height:merged.height??16,
    rotate:merged.rotate??0,
    hFlip:Boolean(merged.hFlip),
    vFlip:Boolean(merged.vFlip),
    hidden:Boolean(merged.hidden),
  };
}

const format=(value:number)=>String(Number(value.toFixed(4)));

/** Iconify keeps definitions outside the transform wrapper, so gradients and clips keep their own coordinates. */
function splitDefs(body:string):{defs:string;content:string} {
  let defs='';let content=body;
  for(;;){
    const index=content.indexOf('<defs');
    if(index<0)break;
    const start=content.indexOf('>',index);
    const end=content.indexOf('</defs',index);
    const endEnd=end<0?-1:content.indexOf('>',end);
    if(start<0||end<0||endEnd<0)break;
    defs+=content.slice(start+1,end).trim();
    content=content.slice(0,index).trim()+content.slice(endEnd+1);
  }
  return {defs,content};
}

/**
 * Applies Iconify's transform semantics to the artwork and returns a complete nested
 * <svg> with the matching viewBox. Iconify flips first and then rotates, and an odd
 * rotation swaps the visible width and height.
 */
export function collectionIconMarkup(data:CollectionIconData):string {
  let {left,top,width,height}=data;
  let rotate=data.rotate%4;
  const transformations:string[]=[];
  if(data.hFlip&&data.vFlip) rotate=(rotate+2)%4;
  else if(data.hFlip){
    transformations.push(`translate(${format(left+width)} ${format(-top)})`,'scale(-1 1)');
    left=0;top=0;
  } else if(data.vFlip){
    transformations.push(`translate(${format(-left)} ${format(height+top)})`,'scale(1 -1)');
    left=0;top=0;
  }
  switch(rotate){
    case 1: {
      const value=format(height/2+top);
      transformations.unshift(`rotate(90 ${value} ${value})`);
      break;
    }
    case 2: transformations.unshift(`rotate(180 ${format(width/2+left)} ${format(height/2+top)})`);break;
    case 3: {
      const value=format(width/2+left);
      transformations.unshift(`rotate(-90 ${value} ${value})`);
      break;
    }
  }
  if(rotate%2===1){
    const swappedLeft=left;left=top;top=swappedLeft;
    const swappedWidth=width;width=height;height=swappedWidth;
  }
  const wrap=(content:string)=>{
    if(!transformations.length)return content;
    const split=splitDefs(content);
    const wrapped=`<g transform="${transformations.join(' ')}">${split.content}</g>`;
    return split.defs?`<defs>${split.defs}</defs>${wrapped}`:wrapped;
  };
  const body=wrap(data.body);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${format(left)} ${format(top)} ${format(width)} ${format(height)}">${body}</svg>`;
}

/** A collection icon as a document-safe, self-contained SVG body. */
export function resolveCollectionIcon(collection:IconCollection,name:string):ResolvedIcon {
  const reference=`${collection.prefix}:${name}`;
  const data=collectionIconData(collection,name);
  // parseImportedIconSvg applies the same SVG rules and paint defaults as ticket 09.
  return {reference,body:parseImportedIconSvg(reference,collectionIconMarkup(data)),hidden:data.hidden};
}

/**
 * Searches one collection by name or reference. Hidden entries stay resolvable but are
 * not listed, matching Iconify's meaning for `hidden`.
 */
export function searchIconCollection(collection:IconCollection, query:string, limit=24):IconSearchResult[] {
  const tokens=query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const results:IconSearchResult[]=[];
  const add=(name:string,isHidden:boolean|undefined)=>{
    if(isHidden)return;
    const reference=`${collection.prefix}:${name}`;
    const haystack=`${reference} ${name}`.toLowerCase();
    if(tokens.every(token=>haystack.includes(token))) results.push({prefix:collection.prefix,name,reference,collection});
  };
  for(const name of Object.keys(collection.icons)) add(name,collection.icons[name].hidden);
  for(const name of Object.keys(collection.aliases)) add(name,collection.aliases[name].hidden);
  return results.slice(0,Math.max(0,limit));
}
