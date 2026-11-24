import { fixtures } from './fixtures';
import { diagramSchemes } from './diagram-presets';
import { parseMarkdownDocument } from './markdown-document';
import type { DiagramDocument } from './rendering';
import type { PairState } from './paired-document';

export type DraftDocument=DiagramDocument & { originalMarkdown?: string; pair?: PairState };
export type Workspace={documents:Record<string,DraftDocument>;active:string};

export const DRAFTS_KEY='orei-drafts-v1';
// Written next to DRAFTS_KEY. A missing version marks a workspace stored by the
// fixture-seeding release, whose untouched samples may be migrated away on launch.
export const WORKSPACE_VERSION_KEY='orei-workspace-version';
export const WORKSPACE_VERSION='2';

const BLANK_SOURCE='flowchart TD\n  A[Start] --> B[End]';
const STARTER_CSS=`.pele {
  --pele-font: sans-serif;
${Object.entries(diagramSchemes.paper.colors).map(([name,color])=>`  ${name}: ${color};`).join('\n')}
}`;

export function blankDocument(source=BLANK_SOURCE):DraftDocument {
  return {source,css:STARTER_CSS,assets:{}};
}

/** The single-document workspace a clean launch opens. Contains no fixture content or assets. */
export function freshWorkspace():Workspace {
  return {documents:{'Untitled 1':blankDocument()},active:'Untitled 1'};
}

function validPair(value:unknown):value is PairState {
  if(!value || typeof value!=='object' || Array.isArray(value))return false;
  const pair=value as PairState;
  return typeof pair.base==='string' && pair.base.length>0 && pair.base.length<=255 && typeof pair.cssCompanion==='boolean' && typeof pair.assetsCompanion==='boolean';
}

function untouchedSample(document:DraftDocument,sample:DiagramDocument):boolean {
  // A sample document is untouched only when every part of it still matches the shipped
  // sample exactly. Any edit, saved identity or file association makes the tab a user draft.
  return document.source===sample.source
    && document.css===sample.css
    && document.originalMarkdown===undefined
    && document.pair===undefined
    && Object.keys(document).length===3
    && JSON.stringify(document.assets)===JSON.stringify(sample.assets);
}

/** True only for the exact sample-only workspace the previous release auto-seeded. */
export function isUntouchedSampleWorkspace(documents:Record<string,DraftDocument>):boolean {
  const names=Object.keys(fixtures);
  return Object.keys(documents).length===names.length
    && names.every(name=>Object.hasOwn(documents,name) && untouchedSample(documents[name],fixtures[name]));
}

type StoredWorkspace={documents:Record<string,DraftDocument>;active:string};

function readWorkspace(raw:string,legacyActive:string|null):StoredWorkspace {
  const saved=JSON.parse(raw);
  if(!saved || typeof saved!=='object' || Array.isArray(saved) || !saved.documents || typeof saved.documents!=='object' || Array.isArray(saved.documents))throw new Error('Invalid recovery data');
  const entries=Object.entries(saved.documents ?? {}).filter(([,value])=>{
    if(!value || typeof value!=='object' || Array.isArray(value))return false;
    const doc=value as DraftDocument;
    const markdown=doc.originalMarkdown===undefined || (typeof doc.originalMarkdown==='string' && (()=>{try { parseMarkdownDocument(doc.originalMarkdown); return true; } catch { return false; }})());
    // The native location key is optional so older drafts still restore and can be reconnected.
    const pair=doc.pair===undefined || (validPair(doc.pair) && doc.originalMarkdown===undefined);
    return typeof doc.source==='string' && typeof doc.css==='string' && !!doc.assets && typeof doc.assets==='object' && !Array.isArray(doc.assets) && Object.values(doc.assets).every(asset=>typeof asset==='string') && markdown && pair;
  });
  if(entries.length!==Object.keys(saved.documents).length)throw new Error('Invalid recovery data');
  if(!entries.length){
    if(saved.active!=='')throw new Error('Invalid recovery data');
    return {documents:{},active:''};
  }
  if(!entries.every(([name])=>name.length>0 && !Object.hasOwn(Object.prototype,name)))throw new Error('Invalid recovery data');
  const documents=Object.fromEntries(entries) as Record<string,DraftDocument>;
  const candidate=saved.active ?? legacyActive;
  const active=typeof candidate==='string' && Object.hasOwn(documents,candidate)?candidate:entries[0][0];
  return {documents,active};
}

/**
 * Restores the last workspace. A missing or unreadable workspace falls back to a clean
 * Untitled 1 instead of shipped samples; unreadable recovery data is left on disk and
 * reported as blocked. Only the provably untouched, unversioned sample-only workspace
 * written by the previous release is migrated away.
 */
export function restoreWorkspace(storage:Pick<Storage,'getItem'> = localStorage):Workspace & {blocked?:boolean} {
  try {
    const raw=storage.getItem(DRAFTS_KEY);
    if(raw!==null){
      const saved=readWorkspace(raw,storage.getItem('orei-active-v1'));
      const versioned=storage.getItem(WORKSPACE_VERSION_KEY)===WORKSPACE_VERSION;
      if(!versioned && isUntouchedSampleWorkspace(saved.documents))return freshWorkspace();
      return saved;
    }
  } catch { return {...freshWorkspace(),blocked:true}; }
  return freshWorkspace();
}
