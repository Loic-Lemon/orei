// The local icon library: imported Iconify collections persisted in localStorage, plus
// the bundled Lucide collection. Collections stay in the library so new documents can
// browse them after a restart; a document only carries the definitions that its own
// insert actions materialized (see withIconReference), never a whole pack.
//
// Library data is untrusted after a restart or a hand edit, so every stored collection
// is revalidated for structure, names, sizes and aliases with the same parser used for
// imports; each icon body is validated again when it is previewed or inserted. A
// collection that cannot be read is skipped with a visible problem instead of crashing
// the editor; definitions used by existing documents remain in their own asset maps.
import { addAsset, type DocumentAssets } from './document-assets';
import { bundledIconCollection, BUNDLED_ICON_PREFIX } from './bundled-icons';
import { normalizeIconNamespace, IMPORTED_ASSET_LIMIT } from './icon-import';
import {
  parseIconCollection,
  parseIconCollectionValue,
  resolveCollectionIcon,
  searchIconCollection,
  type IconCollection,
  type IconSearchResult,
} from './icon-collection';

export const ICON_LIBRARY_KEY='orei-icon-library-v1';
const ICON_LIBRARY_LIMIT=12;
/** Characters of stored collection JSON; keeps the library inside a normal localStorage quota. */
const ICON_LIBRARY_TEXT_LIMIT=4*1024*1024;

const format='orei-icon-library';
const version=1;

export type IconLibrary={collections:IconCollection[]};
export type IconLibraryLoad={library:IconLibrary;problems:string[]};
export type LibraryLimits={collections:number;characters:number};

const defaultLimits:LibraryLimits={collections:ICON_LIBRARY_LIMIT,characters:ICON_LIBRARY_TEXT_LIMIT};
const resolvedBodies=new WeakMap<IconCollection,Map<string,string>>();

function plainObject(value:unknown):value is Record<string,unknown> {
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}

export function emptyIconLibrary():IconLibrary {
  return {collections:[]};
}

function collectionCharacters(collection:IconCollection):number {
  return JSON.stringify(collection).length;
}

export function collectionIconCount(collection:IconCollection):number {
  return Object.keys(collection.icons).length+Object.keys(collection.aliases).length;
}

/** Retains the upstream notice for display; absence is reported, never invented. */
export function collectionNotice(collection:IconCollection):string {
  const info=collection.info;
  if(!info)return 'No upstream author or license notice was provided by this collection.';
  const license=info.license.spdx?`${info.license.title} (${info.license.spdx})`:info.license.title;
  return `${info.name}${info.version?` ${info.version}`:''} by ${info.author.name} · ${license}`;
}

/** Reads and revalidates the stored library. Invalid entries are skipped and reported. */
export function readIconLibrary(storage:Storage=localStorage):IconLibraryLoad {
  let raw:string|null;
  try { raw=storage.getItem(ICON_LIBRARY_KEY); }
  catch { return {library:emptyIconLibrary(),problems:['The local icon library could not be read, so imported collections are unavailable for this session.']}; }
  if(raw===null)return {library:emptyIconLibrary(),problems:[]};
  let value:unknown;
  try { value=JSON.parse(raw); }
  catch { return {library:emptyIconLibrary(),problems:['Stored icon library data is not valid JSON and was ignored.']}; }
  if(!plainObject(value)||value.format!==format||value.version!==version||!Array.isArray(value.collections))
    return {library:emptyIconLibrary(),problems:['Stored icon library data has an unsupported format and was ignored.']};
  const collections:IconCollection[]=[];
  const problems:string[]=[];
  let characters=0;
  for(const [index,entry] of value.collections.entries()){
    if(collections.length>=defaultLimits.collections){
      problems.push(`Stored icon collection ${index+1} was ignored: the library holds at most ${defaultLimits.collections} imported collections.`);
      continue;
    }
    try {
      // Structure, sizes, names and aliases are revalidated here; icon bodies are
      // validated when an icon is previewed or inserted, so a full library does not
      // block startup re-parsing thousands of already-imported definitions. Import
      // itself validates every body before anything is stored.
      const collection=parseIconCollectionValue(entry,undefined,{validateBodies:false});
      if(collection.prefix===BUNDLED_ICON_PREFIX) throw new Error(`the namespace ${BUNDLED_ICON_PREFIX} is reserved by the bundled collection`);
      if(collections.some(existing=>existing.prefix===collection.prefix)) throw new Error(`the namespace ${collection.prefix} appears more than once`);
      const size=collectionCharacters(collection);
      if(characters+size>defaultLimits.characters) throw new Error(`it would exceed the ${defaultLimits.characters}-character library limit`);
      characters+=size;
      collections.push(collection);
    } catch(error) {
      problems.push(`Stored icon collection ${index+1} could not be read and was skipped: ${(error as Error).message}.`);
    }
  }
  return {library:{collections},problems};
}

/** Writes the library; returns an explanation instead of throwing when storage refuses it. */
export function storeIconLibrary(library:IconLibrary, storage:Storage=localStorage):string|undefined {
  try {
    storage.setItem(ICON_LIBRARY_KEY,JSON.stringify({format,version,collections:library.collections}));
    return undefined;
  } catch(error) {
    return `The icon library could not be saved locally: ${String(error)}. Nothing was imported.`;
  }
}

/** Parses and adds a pack. Collisions, reserved names and capacity are refused before any change. */
export function importIconCollection(library:IconLibrary, text:string, options:{namespace?:string;limits?:Partial<LibraryLimits>}={}):{library:IconLibrary;collection:IconCollection} {
  const limits={...defaultLimits,...options.limits};
  const requested=options.namespace?.trim();
  // The namespace input shares the icon namespace rules, so a collection cannot take the
  // bundled namespace or a name individual SVG imports could not use.
  const namespace=requested?normalizeIconNamespace(requested):undefined;
  const collection=parseIconCollection(text,namespace);
  if(collection.prefix===BUNDLED_ICON_PREFIX) throw new Error(`The namespace "${BUNDLED_ICON_PREFIX}" is reserved by the bundled icon collection; choose another collection namespace`);
  if(library.collections.some(existing=>existing.prefix===collection.prefix))
    throw new Error(`An icon collection named ${collection.prefix} is already imported. Remove it before importing a replacement; nothing was changed.`);
  if(library.collections.length>=limits.collections)
    throw new Error(`The local icon library already holds the maximum of ${limits.collections} imported collections. Remove a collection before importing ${collection.prefix}; nothing was changed.`);
  const total=library.collections.reduce((sum,existing)=>sum+collectionCharacters(existing),0)+collectionCharacters(collection);
  if(total>limits.characters)
    throw new Error(`Importing ${collection.prefix} would exceed the local icon library limit of ${limits.characters} characters. Remove a collection or use a smaller pack; nothing was changed.`);
  return {library:{collections:[...library.collections,collection]},collection};
}

export function removeIconCollection(library:IconLibrary, prefix:string):IconLibrary {
  if(!library.collections.some(collection=>collection.prefix===prefix))return library;
  return {collections:library.collections.filter(collection=>collection.prefix!==prefix)};
}

/** Every searchable icon: imported collections first, then the bundled collection. */
export function searchIcons(library:IconLibrary, query:string, limit=24):IconSearchResult[] {
  const imported=library.collections.flatMap(collection=>searchIconCollection(collection,query,limit));
  const bundled=searchIconCollection(bundledIconCollection(),query,limit);
  return [...imported,...bundled].slice(0,Math.max(0,limit));
}

/** Finds a reference in the imported library or the bundled collection. */
export function findIcon(library:IconLibrary, reference:string):{collection:IconCollection;name:string}|undefined {
  const separator=reference.indexOf(':');
  if(separator<=0||separator===reference.length-1)return undefined;
  const prefix=reference.slice(0,separator);
  const name=reference.slice(separator+1);
  const collection=prefix===BUNDLED_ICON_PREFIX?bundledIconCollection():library.collections.find(candidate=>candidate.prefix===prefix);
  if(!collection)return undefined;
  if(!Object.hasOwn(collection.icons,name)&&!Object.hasOwn(collection.aliases,name))return undefined;
  return {collection,name};
}

function cachedBody(collection:IconCollection, name:string):string {
  // Collections are immutable once imported, so a resolved body can be reused across
  // previews and insert actions without re-parsing the same definition.
  let cache=resolvedBodies.get(collection);
  if(!cache){cache=new Map();resolvedBodies.set(collection,cache);}
  const cached=cache.get(name);
  if(cached!==undefined)return cached;
  const body=resolveCollectionIcon(collection,name).body;
  cache.set(name,body);
  return body;
}

/** The safe body for previews or insertion; throws for a missing or unsupported icon. */
export function resolveIconReference(library:IconLibrary, reference:string):string {
  const found=findIcon(library,reference);
  if(!found) throw new Error(`Icon ${reference} is not in the local icon library or the bundled collection`);
  return cachedBody(found.collection,found.name);
}

/**
 * Adds the definition a document needs for a reference. Bundled icons need no document
 * copy; an imported collection's resolved body is stored under its `prefix:name` key so
 * the document reopens without the original pack. Only used definitions are stored.
 */
export function withIconReference(assets:DocumentAssets, library:IconLibrary, reference:string, limit=IMPORTED_ASSET_LIMIT):DocumentAssets {
  const found=findIcon(library,reference);
  if(!found) throw new Error(`Icon ${reference} is not in the local icon library or the bundled collection`);
  if(found.collection===bundledIconCollection())return assets;
  if(Object.hasOwn(assets,reference))return assets;
  if(Object.keys(assets).length>=limit)
    throw new Error(`This document already carries the maximum of ${limit} assets, so ${reference} cannot be added. Remove an asset or save the document as a pair first; nothing was changed.`);
  return addAsset(assets,reference,cachedBody(found.collection,found.name));
}
