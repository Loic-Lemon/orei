import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type ReactNode } from 'react';
import { Theme, Flex, Text, Heading, Button, IconButton, TextField, SegmentedControl, Select, Dialog, Callout, Tooltip, DropdownMenu, Tabs, RadioCards } from '@radix-ui/themes';
import { Download, Undo2, Redo2, Copy, FilePlus2, FolderOpen, Save, X, FileImage, Sun, Moon, Monitor, LayoutTemplate, ChevronRight, CircleExclamationPoint, Cog, Maximize2, Minus, Plus, Crown } from 'lucide-react';
import { defaultCSS } from './fixtures';
import { CodeEditor } from './code-editor';
import { delimiterKeyEdit, movePairs, pairsAfterInput, type DelimiterPair } from './editor-delimiters';
import { ImageStyleDialog } from './image-style-dialog';
import { applyImageStyle, imageStyleControlLabel, imageStyleProblem, type ImageStyle } from './image-styling';
import { diagramSchemes, diagramTemplates } from './diagram-presets';
import { renderDiagram, type Snapshot } from './rendering';
import { previewSourceLine } from './preview-source';
import { saveSnapshot, copyImage, copySvg, copySource, copyText } from './output';
import { invoke } from '@tauri-apps/api/core';
import { detectType } from 'pele';
import { applyPalette, paletteValues, rewritePalette } from './palette';
import { parseMarkdownDocument, updateMarkdownDocument, createMarkdownDocument } from './markdown-document';
import { decodePairedAssets, imageReferences, pairedSnapshot, type PairedSnapshot } from './paired-document';
import { DRAFTS_KEY, WORKSPACE_VERSION, WORKSPACE_VERSION_KEY, blankDocument, restoreWorkspace, type DraftDocument, type Workspace } from './workspace';
import { SaveQueue } from './save-queue';
import { iconNameFromFilename, importSvgIcon } from './icon-import';
import { imageDataProblem, imageSnippet, importLocalImage, readClipboardPng } from './image-import';
import { addAsset, assetKind, iconAssets as documentIcons, imageAssets as documentImages, removeAsset } from './document-assets';
import { validateIconBody } from './icon-safety';
import { collectionIconCount, collectionNotice as collectionNoticeText, importIconCollection, readIconLibrary, removeIconCollection, resolveIconReference, searchIcons, storeIconLibrary, withIconReference, type IconLibrary } from './icon-library';
import { BUNDLED_ICON_PREFIX } from './bundled-icons';
import { defaultDestinationName, documentFormat, planConversion, type Conversion, type EditableFormat } from './conversion';
import { markdownAssetPaths, planMarkdownAssets, type MarkdownAssetFile } from './markdown-assets';

const canvasOptions = {
  app: { label: 'Match app', Icon: Monitor },
  light: { label: 'Light', Icon: Sun },
  dark: { label: 'Dark', Icon: Moon },
  document: { label: 'Document', Icon: FileImage },
};
type CanvasChoice = keyof typeof canvasOptions;

/** The one stable preference key for the app appearance. */
export const APP_THEME_KEY = 'orei-app-theme';
type ThemeChoice = {
  id: string;
  label: string;
  hint: string;
  appearance: 'system' | 'light' | 'dark';
  grayColor: 'slate' | 'gray' | 'sand';
  accentColor: 'blue' | 'indigo' | 'amber';
};
/** Appearance choices map onto the root Radix Theme; the ID is what storage keeps. */
export const appThemes: ThemeChoice[] = [
  { id: 'system', label: 'System', hint: 'Follows macOS', appearance: 'system', grayColor: 'slate', accentColor: 'blue' },
  { id: 'light', label: 'Light', hint: 'Light', appearance: 'light', grayColor: 'slate', accentColor: 'blue' },
  { id: 'slate-dark', label: 'Slate Dark', hint: 'Cool blue-gray', appearance: 'dark', grayColor: 'slate', accentColor: 'blue' },
  { id: 'ink-dark', label: 'Ink Dark', hint: 'Near-black charcoal', appearance: 'dark', grayColor: 'gray', accentColor: 'indigo' },
  { id: 'warm-dark', label: 'Warm Dark', hint: 'Warm brown', appearance: 'dark', grayColor: 'sand', accentColor: 'amber' },
];
/** Unknown or absent values fall back to System; a read failure is reported, not guessed at. */
function readAppTheme(): { id: string; error: string } {
  try {
    const stored = localStorage.getItem(APP_THEME_KEY);
    return { id: appThemes.some(choice => choice.id === stored) ? stored! : 'system', error: '' };
  } catch {
    return { id: 'system', error: 'Could not read the saved appearance.' };
  }
}

const peleDocsUrl = 'https://pele.run/';
const peleDocsSections = [
  ['Introduction', ''],
  ['Examples', 'examples'],
  ['API', 'api'],
  ['Theming', 'theming'],
  ['Compatibility', 'compatibility'],
  ['Security', 'security'],
] as const;

const paletteFields = [
  ['--pele-bg', 'Background'],
  ['--pele-fg', 'Text'],
  ['--pele-surface', 'Node fill'],
  ['--pele-border', 'Border'],
] as const;

function StylingDisclosure({title,initiallyOpen,children}:{title:string;initiallyOpen?:boolean;children:ReactNode}){
  return <details className="styling-section" open={initiallyOpen}>
    <summary>{title}<ChevronRight size={15} aria-hidden="true"/></summary>
    <div className="styling-section-content">{children}</div>
  </details>;
}

type Part='source'|'css';
type Caret={start:number;end:number};
type Edit={value:string;caret:Caret;pairs?:readonly DelimiterPair[]};
type History={undo:Edit[];redo:Edit[];paired?:{value:string;pairs:readonly DelimiterPair[]}};
function currentPairs(history:History,value:string){
  return history.paired?.value===value?history.paired.pairs:[];
}
function nativeTextField(){
  const focused=document.activeElement;
  return focused instanceof HTMLElement&&!focused.closest('.editor')&&(focused.matches('input,textarea')||focused.isContentEditable);
}

type PairRevisions={source:number;css:number|null;assets:number|null};
type PairedWrite={revisions:PairRevisions;written:string[];failure:{member:string;message:string}|null;retained?:RetainedVersion[];untouched_companions?:{css:string|null;assets:string|null}};
type OverwriteResult={revision:number;retained:RetainedVersion[]};
type MarkdownSnapshot={format:'markdown';text:string;files:MarkdownAssetFile[];source:string;css:string;assets:Record<string,string>};
type SaveResult=MarkdownSnapshot|PairedSnapshot;
type SaveMode='save-as'|'copy';
type QueueState='saved'|'pending'|'saving'|'failed';
type RetainedVersion={member:string;text:string|null;path:string};
type DiskMarkdown={kind:'markdown';text:string|null;missing:boolean;error?:string;retained:RetainedVersion[]};
type DiskPair={kind:'paired';source:string|null;css:string|null;assets:string|null;missing:string[];error?:string;retained:RetainedVersion[]};
type DiskSnapshot=DiskMarkdown|DiskPair;
type NativeDocumentState={revision:number;text:string|null;missing:boolean;changed:boolean;error:string|null;retained:RetainedVersion[]};
type NativePairState={revisions:PairRevisions;source:string|null;css:string|null;assets:string|null;missing:string[];changed:boolean;error:string|null;retained:RetainedVersion[]};
type SaveSession={handle:string;kind:'markdown'|'paired';revisions:number|PairRevisions;epoch:number;attachments:string;namespace:string;rootReady:boolean;queue:{readonly state:QueueState;readonly error:unknown;readonly isPaused:boolean;update(value:SaveResult):void;flush():Promise<void>;retry():Promise<void>;pause():void;resume():void;reset(expected:number|PairRevisions):void;dispose():Promise<void>};status:QueueState;blocked?:unknown;external?:DiskSnapshot;holdConflict?:boolean;snapshot(document:DraftDocument):SaveResult};
type OpenedMarkdown={handle:string;name:string;text:string;revision:number};
type OpenedPair={handle:string;base:string;source_name:string;source:string;css_name:string|null;css:string|null;assets_name:string|null;assets:string|null;revisions:PairRevisions;location_id?:string};
type OpenedFile=OpenedMarkdown|OpenedPair;
const isOpenedPair=(value:OpenedFile):value is OpenedPair=>'source_name' in value && 'revisions' in value;
const sameMarkdownContent=(left:SaveResult,right:SaveResult):boolean=>'format' in left&&left.format==='markdown'&&'format' in right&&right.format==='markdown'
  ? left.source===right.source&&left.css===right.css&&JSON.stringify(left.assets)===JSON.stringify(right.assets)
  : false;
const sameWritten=(value:SaveResult, written:SaveResult):boolean=>{
  if('format' in value&&value.format==='markdown')return sameMarkdownContent(value,written);
  return !('format' in written)&&value.source===written.source&&value.css===written.css&&value.assets===written.assets;
};
function matchesOpenedPair(draft:DraftDocument,opened:DraftDocument):boolean{
  if(!draft.pair||!opened.pair||draft.source!==opened.source)return false;
  if(draft.pair.cssCompanion!==opened.pair.cssCompanion||(draft.pair.cssCompanion&&draft.css!==opened.css))return false;
  const assets=Object.keys(draft.assets);
  // A legacy recovery snapshot can have assets but an out-of-date companion flag after
  // a successful save created the index. Compare decoded contents instead of JSON formatting.
  if(draft.pair.assetsCompanion!==opened.pair.assetsCompanion&&(draft.pair.assetsCompanion||!assets.length))return false;
  return assets.length===Object.keys(opened.assets).length&&assets.every(name=>Object.hasOwn(opened.assets,name)&&draft.assets[name]===opened.assets[name]);
}
const externalMissing=(disk:DiskSnapshot)=>disk.kind==='markdown'?disk.missing:disk.missing.includes('source');
const sameDisk=(left:DiskSnapshot|undefined,right:DiskSnapshot):boolean=>{
  if(!left||left.kind!==right.kind)return false;
  if(left.kind==='markdown'&&right.kind==='markdown')return left.text===right.text&&left.missing===right.missing&&left.error===right.error&&JSON.stringify(left.retained)===JSON.stringify(right.retained);
  if(left.kind==='paired'&&right.kind==='paired')return left.source===right.source&&left.css===right.css&&left.assets===right.assets&&left.missing.join('|')===right.missing.join('|')&&left.error===right.error&&JSON.stringify(left.retained)===JSON.stringify(right.retained);
  return false;
};
const conflictLabel=(disk:DiskSnapshot):string=>externalMissing(disk)?'File missing':disk.kind==='paired'&&disk.missing.length?'Companion missing':'Changed on disk';
function saveLabel(session:SaveSession):string {
  if(session.external)return conflictLabel(session.external);
  if(session.blocked!==undefined)return 'Save failed';
  if(session.status==='failed')return 'Save failed';
  if(session.status==='saving')return 'Saving…';
  if(session.status==='pending')return 'Pending save';
  return 'Saved';
}
type TabView={view:string;mode:'fixed'|'responsive';zoom:number;fitted:boolean;snapshot?:Snapshot};
const initialView=():TabView=>({view:'Diagram',mode:'responsive',zoom:100,fitted:true});
const minZoom=25;
const maxZoom=200;

export function App(){
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [initialTheme]=useState(readAppTheme);
  const [themeId,setThemeId]=useState(initialTheme.id);
  const [themeError,setThemeError]=useState(initialTheme.error);
  const [markdownPreferences,setMarkdownPreferences]=useState<{defaultNotesFolder:string|null;defaultAttachmentsFolder:string|null}>({defaultNotesFolder:null,defaultAttachmentsFolder:null});
  const [overrideAttachments,setOverrideAttachments]=useState(false);
  const [preferencesError,setPreferencesError]=useState('');
  const savedPreferences=useRef(markdownPreferences);
  const preferenceWrites=useRef(Promise.resolve());
  useEffect(()=>{
    if(!('__TAURI_INTERNALS__' in window))return;
    preferenceWrites.current=invoke<typeof markdownPreferences>('get_markdown_preferences').then(value=>{
      if(value){savedPreferences.current=value;setMarkdownPreferences(value);}
    }).catch(()=>setPreferencesError('Could not load settings.'));
  },[]);
  const updatePreference=(key:keyof typeof markdownPreferences,value:string|null)=>{
    // The native command replaces the preference file as a whole. Start each change
    // after the previous save so one folder update cannot overwrite the other.
    const write=preferenceWrites.current.then(async()=>{
      const next={...savedPreferences.current,[key]:value};
      try {
        await invoke('set_markdown_preferences',{preferences:next});
        savedPreferences.current=next;
        setMarkdownPreferences(next);
        setPreferencesError('');
      } catch { setPreferencesError('Could not save settings.'); }
    });
    preferenceWrites.current=write;
    return write;
  };
  const chooseFolder=async(key:'defaultNotesFolder'|'defaultAttachmentsFolder')=>{
    try { const selected=await invoke<string|null>('pick_folder');if(selected!==null)await updatePreference(key,selected); }
    catch { setPreferencesError('Could not choose a folder.'); }
  };
  const [initial]=useState(restoreWorkspace);
  const [initialLibrary]=useState(readIconLibrary);
  const [documents,setDocuments]=useState(initial.documents);
  const [active,setActive]=useState(initial.active);
  const [draftStatus,setDraftStatus]=useState('Draft recovery pending');
  const [closeTarget,setCloseTarget]=useState<string>();
  const [openError,setOpenError]=useState('');
  const [assetNotice,setAssetNotice]=useState<{name:string;message:string}>();
  const [saveError,setSaveError]=useState('');
  const [copyStatus,setCopyStatusState]=useState('');
  const copyStatusTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const setCopyStatus=(message:string)=>{
    if(!mounted.current)return;
    if(copyStatusTimer.current!==undefined)clearTimeout(copyStatusTimer.current);
    copyStatusTimer.current=undefined;
    setCopyStatusState(message);
    if(message)copyStatusTimer.current=setTimeout(()=>{setCopyStatusState('');copyStatusTimer.current=undefined;},4000);
  };
  const [copyError,setCopyError]=useState('');
  const [saveDialog,setSaveDialog]=useState<SaveMode|undefined>(undefined);
  const [saveTarget,setSaveTarget]=useState<EditableFormat>('markdown');
  const [conflictTarget,setConflictTarget]=useState<string>();
  const [conflictError,setConflictError]=useState('');
  const [conflictNotice,setConflictNotice]=useState('');
  const [conflictBusy,setConflictBusy]=useState(false);
  const [conflictMember,setConflictMember]=useState<'source'|'css'|'assets'>('source');
  const conflictFocus=useRef<HTMLElement|null>(null);
  const inspecting=useRef<Record<string,boolean>>({});
  const inspectExternal=useRef<(name:string,session:SaveSession)=>Promise<void>>(async()=>{});
  const verifyWriteConflict=useRef<(session:SaveSession)=>Promise<void>>(async()=>{});
  const opening=useRef(false);
  const openedSessions=useRef<Record<string,SaveSession>>({});
  const restoringPairs=useRef(new Map<string,Promise<void>>());
  const nextDocumentId=useRef(Object.keys(initial.documents).length);
  const emptyNewButton=useRef<HTMLButtonElement>(null);
  const settingsFirst=useRef<HTMLButtonElement>(null);
  const settingsFocus=useRef<{element:HTMLElement|null;start:number|null;end:number|null}>({element:null,start:null,end:null});
  const settingsOpenRef=useRef(settingsOpen);
  settingsOpenRef.current=settingsOpen;
  const documentIds=useRef<Record<string,string>>(Object.fromEntries(Object.keys(initial.documents).map((name,index)=>[name,`doc-${index+1}`])));
  const firstSaving=useRef<string|undefined>(undefined);
  const firstSavePending=useRef<Promise<void>|undefined>(undefined);
  const closingTabs=useRef(new Set<string>());
  const mounted=useRef(true);
  const [,refreshSaveState]=useState(0);
  const destinationPending=useRef(false);
  const saveDialogFocus=useRef<HTMLElement|null>(null);
  const [closeFailure,setCloseFailure]=useState(false);
  const [windowFailure,setWindowFailure]=useState(false);
  const [exitFailure,setExitFailure]=useState(false);
  const [closeRequested,setCloseRequested]=useState(false);
  const latest=useRef({documents,active});
  latest.current={documents,active};
  const evidenceSamples=useRef(false);
  const writeDrafts=(workspace:Workspace)=>{
    // Evidence scenarios replace the in-memory workspace with shipped samples. Persisting
    // those would overwrite the drafts a normal launch restores on the same machine.
    if(evidenceSamples.current)return true;
    try {
      if(initial.blocked)throw new Error('Existing recovery data could not be read');
      localStorage.setItem(WORKSPACE_VERSION_KEY,WORKSPACE_VERSION);
      localStorage.setItem(DRAFTS_KEY,JSON.stringify(workspace));
      setDraftStatus('Drafts saved locally');
      return true;
    }
    catch { setDraftStatus('Draft recovery failed'); return false; }
  };
  const flush=useRef<()=>boolean>(()=>false);
  flush.current=()=>writeDrafts(latest.current);
  const flushNamed=useRef<(retry?:boolean)=>Promise<boolean>>(async()=>false);
  flushNamed.current=async(retry=false)=>{
    if(!flush.current())return false;
    try {
      if(firstSavePending.current)await firstSavePending.current;
      await Promise.all(restoringPairs.current.values());
      // Re-checked after the await: saveFirst can set blocked while the picker is open.
      if(Object.values(openedSessions.current).some(session=>session.blocked||session.external))return false;
      await Promise.all(Object.values(openedSessions.current).map(session=>retry&&session.queue.state==='failed'?session.queue.retry():session.queue.flush()));
      return flush.current();
    } catch { return false; }
  };
  useLayoutEffect(()=>{
    if(flush.current()){
      // Recovery succeeded again: re-serialize each blocked session's current content and
      // unblock it, so a transient recovery failure does not leave a tab refused to close
      // for a condition that no longer holds.
      for(const [name,session] of Object.entries(openedSessions.current)){
        if(session.blocked===undefined||session.external)continue;
        try { session.queue.update(session.snapshot(latest.current.documents[name])); session.blocked=undefined; refreshSaveState(n=>n+1); }
        catch { /* Content still cannot be serialized; the block stands until Save or an edit resolves it. */ }
      }
    }
  },[documents,active]);
  useEffect(()=>{
    mounted.current=true;
    return()=>{
      mounted.current=false;
      if(copyStatusTimer.current!==undefined)clearTimeout(copyStatusTimer.current);
      for(const session of Object.values(openedSessions.current)){
        void session.queue.dispose().catch(()=>{});
        if('__TAURI_INTERNALS__' in window)void invoke(session.kind==='markdown'?'release_named_document':'release_paired_document',{handle:session.handle}).catch(()=>{});
      }
    };
  },[]);
  useEffect(()=>{
    const beforeUnload=(event:BeforeUnloadEvent)=>{if(!flush.current()||firstSavePending.current||Object.values(openedSessions.current).some(session=>session.blocked||session.external||session.queue.state!=='saved')){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',beforeUnload);
    return()=>window.removeEventListener('beforeunload',beforeUnload);
  },[]);
  useEffect(()=>{
    if(!('__TAURI_INTERNALS__' in window))return;
    let disposed=false;let unlisten:(()=>void)|undefined;
    const close=()=>{
      if(disposed)return;
      setCloseRequested(true);
      setExitFailure(false);
      void flushNamed.current().then(saved=>{
        if(disposed)return;
        if(!saved)setWindowFailure(true);
        else void invoke('exit_after_recovery').catch(()=>{setExitFailure(true);setWindowFailure(true);});
      });
    };
    void import('@tauri-apps/api/event').then(({listen})=>listen('window-close-request',close)).then(async fn=>{if(disposed){fn();return;}unlisten=fn;if(await invoke<boolean>('close_listener_ready'))close();}).catch(()=>{if(!disposed)setWindowFailure(true);});
    return()=>{disposed=true;unlisten?.();};
  },[]);
  const doc=active?documents[active]:undefined;
  const hasDocument=!!doc;
  const [views,setViews]=useState<Record<string,TabView>>({});
  const tabView=views[active]??initialView();
  const updateView=(patch:Partial<TabView>)=>setViews(v=>({...v,[active]:{...(v[active]??initialView()),...patch}}));
  const view=tabView.view;
  const setView=(view:string)=>updateView({view});
  const [findOpen,setFindOpen]=useState(false);
  const [findText,setFindText]=useState('');
  const findInput=useRef<HTMLInputElement>(null);
  const paletteGesture=useRef({active:false,changed:false});
  const pan=useRef<{pointer:number;x:number;y:number;left:number;top:number;captured:boolean}|undefined>(undefined);
  useEffect(()=>{const stop=()=>{pan.current=undefined;};window.addEventListener('blur',stop);return()=>window.removeEventListener('blur',stop);},[]);
  const [canvasChoice,setCanvasChoice]=useState<CanvasChoice>('app');
  const [previewTab,setPreviewTab]=useState('preview');
  const showDocs=previewTab==='docs';
  const [docsOpened,setDocsOpened]=useState(false);
  const docsFrame=useRef<HTMLIFrameElement>(null);
  const mode=tabView.mode;
  const setMode=(mode:'fixed'|'responsive')=>{
    // Entering responsive re-fits while auto-fit is engaged; the current snapshot is the pre-switch composition.
    const snapshot=tabView.snapshot;
    updateView(mode==='responsive'&&tabView.fitted&&snapshot?{mode,zoom:Math.min(100,Math.round(width/snapshot.width*100))}:{mode});
  };
  const [width,setWidth]=useState(800);
  const [split,setSplit]=useState(50);
  const drag=useRef<{pointer:number;x:number;split:number;width:number;snapped:boolean}|undefined>(undefined);
  const zoom=tabView.zoom;
  // Number inputs clamp while the user is still typing when bound to the committed value
  // (typing "15" would jump to 25). Keep raw text locally and clamp on commit instead.
  const [zoomDraft,setZoomDraft]=useState(String(zoom));
  useEffect(()=>setZoomDraft(String(zoom)),[active,zoom]);
  const setManualZoom=(percent:number)=>{
    const next=Math.max(minZoom,Math.min(maxZoom,Math.round(percent)));
    setZoomDraft(String(next));
    updateView({zoom:next,fitted:false});
  };
  const commitZoom=()=>{
    if(zoomDraft===String(zoom))return;
    const parsed=Number(zoomDraft);
    if(zoomDraft.trim()!==''&&Number.isFinite(parsed))setManualZoom(parsed);
    else setZoomDraft(String(zoom));
  };
  const stepZoom=(change:number)=>{
    const parsed=Number(zoomDraft);
    const base=zoomDraft.trim()!==''&&Number.isFinite(parsed)?parsed:zoom;
    setManualZoom(base+change);
  };
  const zoomKeyDown=(event:React.KeyboardEvent<HTMLInputElement>)=>{
    if(event.key==='Enter'){event.preventDefault();commitZoom();}
    else if(event.key==='Escape'){event.preventDefault();setZoomDraft(String(zoom));}
    else if(event.key==='ArrowUp'){event.preventDefault();stepZoom(5);}
    else if(event.key==='ArrowDown'){event.preventDefault();stepZoom(-5);}
  };
  const snapshot=tabView.snapshot;
  const [error,setError]=useState('');
  const [errorLine,setErrorLine]=useState(0);
  const [diagnostic,setDiagnostic]=useState(false);
  const [diagnosticDetailsOpen,setDiagnosticDetailsOpen]=useState(false);
  const showDiagnostic=Boolean(error&&diagnostic);
  const [pending,setPending]=useState(true);
  const [exportOpen,setExportOpen]=useState(false);
  const [scale,setScale]=useState('1');
  const [background,setBackground]=useState('document');
  const [outputError,setOutputError]=useState('');
  const [iconNamespace,setIconNamespace]=useState('custom');
  const [iconName,setIconName]=useState('');
  const [iconError,setIconError]=useState('');
  const [iconNotice,setIconNotice]=useState('');
  const [iconBusy,setIconBusy]=useState(false);
  const [imageReference,setImageReference]=useState('');
  const [imageError,setImageError]=useState('');
  const [imageNotice,setImageNotice]=useState('');
  const [imageBusy,setImageBusy]=useState(false);
  const imagePending=useRef(false);
  const [imageStyleTarget,setImageStyleTarget]=useState<{documentId:string;reference:string;data:string}>();
  const [imageStyleFailure,setImageStyleFailure]=useState('');
  const imageStyleOpenRef=useRef(false);
  imageStyleOpenRef.current=imageStyleTarget!==undefined;
  const imageStyleFocus=useRef<HTMLElement|null>(null);
  const imageCogs=useRef<Record<string,HTMLButtonElement|null>>({});
  const [iconLibrary,setIconLibrary]=useState<IconLibrary>(initialLibrary.library);
  const [libraryProblems,setLibraryProblems]=useState(initialLibrary.problems);
  const [collectionNamespace,setCollectionNamespace]=useState('');
  const [collectionError,setCollectionError]=useState('');
  const [collectionMessage,setCollectionMessage]=useState('');
  const [collectionBusy,setCollectionBusy]=useState(false);
  const [iconQuery,setIconQuery]=useState('');
  const collectionButton=useRef<HTMLButtonElement>(null);
  const [multiple,setMultiple]=useState(false);
  const [held,setHeld]=useState<Snapshot[]>([]);
  const [systemDark,setSystemDark]=useState(false);
  const panel=useRef<HTMLDivElement>(null);
  const previewToolbar=useRef<HTMLDivElement>(null);
  const exportButton=useRef<HTMLButtonElement>(null);
  const preview=useRef<HTMLDivElement>(null);
  const previewScroll=useRef<HTMLDivElement>(null);
  const scrollPositions=useRef<Record<string,{left:number;top:number}>>({});
  useLayoutEffect(()=>{
    const element=previewScroll.current;if(!element)return;
    const position=scrollPositions.current[active];element.scrollLeft=position?.left??0;element.scrollTop=position?.top??0;
    return()=>{
      if(Object.hasOwn(documentIds.current,active))scrollPositions.current[active]={left:element.scrollLeft,top:element.scrollTop};
    };
  },[active]);
  const generation=useRef(0);
  const sourceEditor=useRef<HTMLTextAreaElement>(null);
  const requestedSourceLine=useRef(0);
  const cssEditor=useRef<HTMLTextAreaElement>(null);
  const selection=useRef<{editor:HTMLTextAreaElement;start:number;end:number}|undefined>(undefined);
  const sourceTouched=useRef(false);
  const escapeTab=useRef(false);
  const histories=useRef<Record<string,Record<Part,History>>>(Object.fromEntries(Object.keys(documents).map(name=>[name,{source:{undo:[],redo:[]},css:{undo:[],redo:[]}}])));
  const carets=useRef<Record<string,Record<Part,Caret>>>(Object.fromEntries(Object.keys(documents).map(name=>[name,{source:{start:0,end:0},css:{start:0,end:0}}])));
  const part:Part=view==='Diagram'?'source':'css';
  const history=histories.current[active]?.[part];
  useLayoutEffect(()=>{const next=selection.current;if(next){next.editor.setSelectionRange(next.start,next.end);selection.current=undefined;}},[documents]);
  function selectSourceLine(line:number){
    const editor=sourceEditor.current;if(!editor||!carets.current[active])return;
    const lines=editor.value.split('\n');
    const text=lines[line-1];
    if(text===undefined)return;
    const start=lines.slice(0,line-1).reduce((offset,text)=>offset+text.length+1,0);
    const end=start+text.length;
    editor.focus({preventScroll:true});
    editor.setSelectionRange(start,end);
    sourceTouched.current=true;
    carets.current[active].source={start,end};

    const style=getComputedStyle(editor);
    const lineHeight=Number.parseFloat(style.lineHeight);
    const top=(line-1)*lineHeight+(Number.parseFloat(style.paddingTop)||0);
    if(top<editor.scrollTop||top+lineHeight>editor.scrollTop+editor.clientHeight){
      editor.scrollTop=Math.max(0,top-(editor.clientHeight-lineHeight)/2);
    }
    editor.scrollLeft=0;
  }
  function goToSourceLine(line:number){
    if(view==='Diagram')selectSourceLine(line);
    else{requestedSourceLine.current=line;setView('Diagram');}
  }
  useLayoutEffect(()=>{
    if(view==='Diagram'&&requestedSourceLine.current){
      selectSourceLine(requestedSourceLine.current);
      requestedSourceLine.current=0;
    }
  },[view]);
  function jumpFromPreview(event:React.MouseEvent<HTMLDivElement>){
    if(!doc||!snapshot||pending||error)return;
    const root=preview.current?.shadowRoot;
    const target=event.nativeEvent.composedPath().find(entry=>entry instanceof Element && entry.getRootNode()===root);
    if(!(target instanceof Element))return;
    const line=previewSourceLine(doc.source,target);
    if(line!==undefined)goToSourceLine(line);
  }
  function startPan(event:React.PointerEvent<HTMLDivElement>){
    if(event.button!==0||pan.current)return;
    const {scrollLeft:left,scrollTop:top}=event.currentTarget;
    pan.current={pointer:event.pointerId,x:event.clientX,y:event.clientY,left,top,captured:false};
  }
  function movePan(event:React.PointerEvent<HTMLDivElement>){
    const start=pan.current;
    if(!start||start.pointer!==event.pointerId)return;
    const dx=start.x-event.clientX, dy=start.y-event.clientY;
    const canvas=event.currentTarget;
    // Capturing on pointerdown would retarget the ensuing double-click to the canvas.
    if(!start.captured){
      if(Math.hypot(dx,dy)<4)return;
      canvas.setPointerCapture(event.pointerId);
      start.captured=true;
    }
    canvas.scrollLeft=start.left+dx;
    canvas.scrollTop=start.top+dy;
  }
  function stopPan(event:React.PointerEvent<HTMLDivElement>){
    const start=pan.current;
    if(!start||start.pointer!==event.pointerId)return;
    pan.current=undefined;
    if(start.captured)event.currentTarget.releasePointerCapture(event.pointerId);
  }
  const canExport=Boolean(snapshot&&!pending&&!error);
  const requestExport=useRef(()=>{});
  requestExport.current=()=>{if(canExport&&!settingsOpenRef.current&&!imageStyleOpenRef.current)setExportOpen(true);};
  // Diagram-output copy: image and SVG require the current valid render and reuse the
  // export dialog's chosen settings; the Mermaid source copy never requires one.
  const requestCopy=useRef<(kind:'image'|'svg'|'source')=>void>(()=>{});
  requestCopy.current=kind=>{if(kind==='source')void copySourceText();else void copyDiagram(kind,setCopyError);};
  async function copyDiagram(kind:'image'|'svg',report:(message:string)=>void){
    setCopyStatus('');
    if(!snapshot||pending||error)return false;
    try {
      if(kind==='image')await copyImage(snapshot,Number(scale),background==='transparent');
      else await copySvg(snapshot);
      setCopyStatus(kind==='image'?'Copied diagram image.':'Copied diagram SVG.');
      return true;
    } catch(e) { setCopyStatus(''); report(String(e)); return false; }
  }
  async function copySourceText(){
    if(!doc)return;
    setCopyStatus('');
    // An empty document has nothing to put on the pasteboard; this is a quiet notice,
    // not the clipboard-failure dialog the native command would raise.
    if(!doc.source.trim()){setCopyStatus('Nothing to copy.');return;}
    try { await copySource(doc.source); setCopyStatus('Copied Mermaid source.'); }
    catch(e) { setCopyStatus(''); setCopyError(String(e)); }
  }
  const requestEdit=useRef<(action:'undo'|'redo'|'find')=>void>(()=>{});
  requestEdit.current=action=>{
    // Editing commands belong to the focused field while a modal is open; the editor keeps
    // its own history untouched until focus returns to it.
    if(settingsOpenRef.current||imageStyleOpenRef.current){
      if(action!=='find'&&nativeTextField()&&typeof document.execCommand==='function')document.execCommand(action);
      return;
    }
    if(action==='find'){
      if(doc){setFindOpen(true);setTimeout(()=>findInput.current?.focus(),0);}
      return;
    }
    if(nativeTextField())document.execCommand(action);else travel(action);
  };
  useEffect(()=>{
    if(!('__TAURI_INTERNALS__' in window))return;
    const update=()=>{
      const native=nativeTextField();
      void invoke('set_edit_enabled',{
        undo:native?(document.queryCommandEnabled?.('undo')??true):Boolean(history?.undo.length),
        redo:native?(document.queryCommandEnabled?.('redo')??true):Boolean(history?.redo.length),
      }).catch(error=>console.error('Could not update native edit availability',error));
    };
    update();document.addEventListener('focusin',update);document.addEventListener('input',update);
    return()=>{document.removeEventListener('focusin',update);document.removeEventListener('input',update);};
  },[doc,active,view]);
  useEffect(()=>{
    if('__TAURI_INTERNALS__' in window) {
      void invoke('set_export_enabled',{enabled:canExport}).catch(error=>console.error('Could not update native Export availability',error));
      void invoke('set_copy_enabled',{enabled:canExport}).catch(error=>console.error('Could not update native Copy availability',error));
    }
  },[canExport]);
  // Settings is a dialog over the live editor. Capture the focused control and its caret
  // before opening, then put both back on close; a vanished control falls back to the active
  // tab or the empty-workspace New button. A repeated menu activation only refocuses Settings.
  const requestSettings=useRef<()=>void>(()=>{});
  requestSettings.current=()=>{
    if(settingsOpenRef.current){settingsFirst.current?.focus();return;}
    // A native menu command can arrive while another modal owns the window; stacking a
    // second Radix dialog would leave two focus traps fighting over the same keyboard.
    if(imageStyleOpenRef.current||exportOpen||saveDialog||closeTarget||conflictTarget||windowFailure||saveError||copyError||openError)return;
    const focused=document.activeElement;
    const element=focused instanceof HTMLElement&&focused!==document.body?focused:null;
    settingsFocus.current={element,start:element instanceof HTMLTextAreaElement?element.selectionStart:null,end:element instanceof HTMLTextAreaElement?element.selectionEnd:null};
    setSettingsOpen(true);
  };
  function restoreSettingsFocus(){
    const saved=settingsFocus.current;
    const element=saved.element?.isConnected?saved.element:null;
    if(element){
      element.focus();
      if(element instanceof HTMLTextAreaElement&&saved.start!==null&&saved.end!==null){
        element.setSelectionRange(saved.start,saved.end);
        const part=element===sourceEditor.current?'source':element===cssEditor.current?'css':null;
        if(part&&carets.current[active])carets.current[active][part]={start:saved.start,end:saved.end};
      }
      return;
    }
    const tab=document.getElementById(`tab-${documentIds.current[active]}`);
    if(tab){tab.focus();return;}
    emptyNewButton.current?.focus();
  }
  function markdownFor(document:DraftDocument){
    const original=document.originalMarkdown??createMarkdownDocument({mermaid:document.source,css:document.css});
    const externalCss=Boolean(markdownAssetPaths(original)?.css);
    return updateMarkdownDocument(original,{mermaid:document.source,css:externalCss?'':document.css});
  }
  // A note needs an attachments folder only when it has sidecar files to write: images or
  // icons, or a stylesheet that is already external. A plain note keeps its CSS inline in
  // the fenced block, so the first save must not demand a folder it will not use.
  function carriesAttachments(document:DraftDocument):boolean{
    return Object.keys(document.assets).length>0||Boolean(markdownAssetPaths(document.originalMarkdown??'')?.css);
  }
  function markdownSnapshot(document:DraftDocument,attachments:string,namespace:string,externalizeCss=false,freshDestination=false):MarkdownSnapshot{
    const base=markdownFor(document);
    const previous=markdownAssetPaths(base);
    const external=externalizeCss||Boolean(previous?.css);
    const text=external?updateMarkdownDocument(base,{mermaid:document.source,css:''}):base;
    if(!previous&&!Object.keys(document.assets).length&&!(external&&document.css))return {format:'markdown',text,files:[],source:document.source,css:document.css,assets:document.assets};
    const plan=planMarkdownAssets({
      text,assets:document.assets,attachments:freshDestination?attachments:previous?.attachments??attachments,
      namespace:freshDestination?namespace:previous?.namespace??namespace,
      css:external?(document.css?{body:document.css}:previous?.css?null:undefined):undefined,
    });
    return {format:'markdown',text:plan.text,files:plan.files,source:document.source,css:document.css,assets:document.assets};
  }
  function markdownSession(handle:string,revision:number,attachments='.',namespace=handle.replace(/[^a-zA-Z0-9_-]/g,'-'),rootReady=false):SaveSession{
    const session:SaveSession={handle,kind:'markdown',revisions:revision,epoch:0,attachments,namespace,rootReady,queue:null as unknown as SaveSession['queue'],status:'saved',snapshot:document=>markdownSnapshot(document,session.attachments,session.namespace)};
    const queue=new SaveQueue<SaveResult,number>(revision,async(value,expected)=>{
      if(!('format' in value)||value.format!=='markdown')throw new Error('Expected a Markdown save snapshot.');
      const result=await invoke<{revision:number;published:string[]}>('write_markdown_document',{handle,revision:expected,text:value.text,files:value.files});
      if(typeof result?.revision!=='number')throw new Error('The native Markdown save did not report a revision.');
      return result.revision;
    },()=>{session.status=queue.state;if(mounted.current)refreshSaveState(n=>n+1);if(queue.state==='failed')void verifyWriteConflict.current(session);});
    session.queue=queue as unknown as SaveSession['queue'];
    return session;
  }
  function pairedSession(opened:OpenedPair):SaveSession{
    const session:SaveSession={handle:opened.handle,kind:'paired',revisions:opened.revisions,epoch:0,attachments:'.',namespace:opened.handle,rootReady:true,queue:null as unknown as SaveSession['queue'],status:'saved',snapshot:document=>pairedSnapshot(document,document.pair!)};
    const queue=new SaveQueue<PairedSnapshot,PairRevisions>(opened.revisions,async(snapshot,expected)=>{
      const result=await invoke<PairedWrite>('write_paired_document',{handle:opened.handle,expected,source:snapshot.source,css:snapshot.css,assets:snapshot.assets});
      // Partial group writes still advance the members that reached disk; the queue adopts
      // these revisions from the thrown error so an explicit retry does not conflict with
      // our own successful write.
      session.revisions=result.revisions;
      if(result.failure){
        const written=result.written.length?` The ${result.written.join(', ')} reached disk`:' No file in the group reached disk';
        throw Object.assign(new Error(`${result.failure.member} could not be saved: ${result.failure.message}.${written}; the files are saved individually, not as one atomic transaction. Recovery retains the latest document snapshot.`),{expected:result.revisions});
      }
      return result.revisions;
    },()=>{session.status=queue.state;if(mounted.current)refreshSaveState(n=>n+1);if(queue.state==='failed')void verifyWriteConflict.current(session);});
    session.queue=queue as unknown as SaveSession['queue'];
    return session;
  }
  function openConflict(name:string){
    const session=openedSessions.current[name];
    if(!session?.external)return;
    conflictFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    setConflictError('');
    setConflictNotice('');
    setConflictMember('source');
    setConflictTarget(name);
  }
  function installExternal(name:string,session:SaveSession,disk:DiskSnapshot,error?:string){
    if(openedSessions.current[name]!==session)return;
    const next:DiskSnapshot=error?{...disk,error}:disk;
    const first=session.external===undefined;
    const changed=!sameDisk(session.external,next);
    if(changed)session.external=next;
    // Pause before anything else can enqueue: a watcher notification is never permission to
    // replace the version the user is about to compare.
    session.queue.pause();
    // A conflict is a modal too. If Settings or the image style dialog owns the window, keep
    // the conflict pending until it closes instead of stacking focus traps.
    if(first&&name===latest.current.active&&!settingsOpenRef.current&&!imageStyleOpenRef.current)openConflict(name);
    if(first||changed)refreshSaveState(n=>n+1);
  }
  function clearExternal(session:SaveSession){
    if(!session.external)return;
    // An inspection reporting no change is not proof that the editor applied the disk version.
    // A reload adopted natively but not applied, and a version displaced by Keep Local, both
    // leave the conflict live until an explicit resolution even though the baseline matches.
    if(session.holdConflict)return;
    session.external=undefined;
    session.queue.resume();
    refreshSaveState(n=>n+1);
  }
  // A native reload or overwrite adopts disk state even when the editor cannot apply it. The
  // queue must expect that revision, or every later write fails with a revision conflict.
  function adoptNativeRevision(session:SaveSession,revision:number|PairRevisions){
    session.revisions=revision;
    try { session.queue.reset(revision); } catch(error) { session.blocked=error; }
  }
  async function pairContents(opened:OpenedPair,locationId=opened.location_id):Promise<{document:DraftDocument;missing:string[]}>{
    let assets:Record<string,string>={};
    if(opened.assets!==null){
      try { assets=decodePairedAssets(opened.assets); }
      catch(error) { throw new Error(`Cannot open ${opened.source_name}: ${(error as Error).message}`); }
    }
    const missing:string[]=[];
    for(const reference of imageReferences(opened.source)){
      if(reference in assets)continue;
      try { assets[reference]=await invoke<string>('read_paired_asset',{handle:opened.handle,reference}); }
      catch(error) { missing.push(`${reference} (${String(error)})`); }
    }
    return {document:{source:opened.source,css:opened.css??defaultCSS,assets,pair:{base:opened.base,cssCompanion:opened.css!==null,assetsCompanion:opened.assets!==null,locationId}},missing};
  }
  async function markdownContents(opened:OpenedMarkdown,allowPrompt:boolean):Promise<{document:DraftDocument;attachments:string;namespace:string;rootReady:boolean}>{
    const parsed=parseMarkdownDocument(opened.text);
    const manifest=markdownAssetPaths(opened.text);
    const references=[
      ...Object.values(manifest?.assets??{}).map(({path,kind})=>({path,kind})),
      ...(manifest?.css?[{path:manifest.css,kind:'css'}]:[]),
    ];
    const resolved=references.length?await invoke<{path:string;data:string;kind:string}[]|null>('read_markdown_assets',{handle:opened.handle,references,allowPrompt}):[];
    if(resolved===null)throw new Error('Attachment folder selection was cancelled; the Markdown note was not opened.');
    if(!Array.isArray(resolved)||resolved.length!==references.length)throw new Error('The native Markdown asset reader returned an incomplete attachment set.');
    const byPath=new Map<string,{data:string;kind:string}>();
    for(const item of resolved){
      if(!item||typeof item.path!=='string'||typeof item.data!=='string'||typeof item.kind!=='string'||byPath.has(item.path))throw new Error('The native Markdown asset reader returned invalid attachment data.');
      byPath.set(item.path,{data:item.data,kind:item.kind});
    }
    const assets:Record<string,string>={};
    for(const [reference,item] of Object.entries(manifest?.assets??{})){
      const value=byPath.get(item.path);
      if(!value||value.kind!==item.kind)throw new Error(`Missing validated Markdown asset: ${reference}`);
      if(item.kind==='image'){
        const problem=imageDataProblem(reference,value.data);
        if(problem)throw new Error(problem);
      }else validateIconBody(reference,value.data);
      assets[reference]=value.data;
    }
    let css=parsed.css;
    if(manifest?.css){
      const value=byPath.get(manifest.css);
      if(!value||value.kind!=='css')throw new Error('The external Markdown stylesheet is missing or invalid.');
      css=value.data;
    }
    return {document:{source:parsed.mermaid,css,assets,originalMarkdown:opened.text},attachments:manifest?.attachments??'.',namespace:manifest?.namespace??opened.handle.replace(/[^a-zA-Z0-9_-]/g,'-'),rootReady:await invoke<boolean>('markdown_root_ready',{handle:opened.handle})};
  }
  async function ensureMarkdownRoot(name:string,onlyIfNeeded=false):Promise<boolean>{
    const session=openedSessions.current[name];
    if(session?.kind!=='markdown'||session.rootReady)return true;
    if(onlyIfNeeded){
      const current=latest.current.documents[name];
      let needsRoot=true;
      try {
        const snapshot=current?session.snapshot(current):undefined;
        needsRoot=Boolean(snapshot&&'format' in snapshot&&snapshot.format==='markdown'&&snapshot.files.length);
      } catch { needsRoot=true; }
      // Plain notes save with no attachment folder; asking for one would be noise.
      if(!needsRoot)return true;
    }
    const relative=await invoke<string|null>('choose_markdown_attachments',{handle:session.handle,overrideAttachments:false});
    if(relative===null)return false;
    session.attachments=relative;
    session.rootReady=true;
    return true;
  }
  function applyReloaded(name:string,updated:DraftDocument,revision:number|PairRevisions,session:SaveSession,notice:string){
    if(openedSessions.current[name]!==session)return;
    const next={...latest.current,documents:{...latest.current.documents,[name]:updated}};
    latest.current=next;
    setDocuments(next.documents);
    const recovered=writeDrafts(next);
    try { session.queue.reset(revision); } catch(error) { session.blocked=error; }
    session.revisions=revision;
    session.external=undefined;
    session.holdConflict=false;
    if(!recovered)session.blocked=new Error('Draft recovery failed after reloading the file; keep the document open and save again.');
    histories.current[name]={source:{undo:[],redo:[]},css:{undo:[],redo:[]}};
    carets.current[name]={source:{start:0,end:0},css:{start:0,end:0}};
    if(assetNotice?.name===name)setAssetNotice(undefined);
    refreshSaveState(n=>n+1);
    setCopyStatus(notice);
  }
  async function reloadMarkdown(name:string,session:SaveSession,explicit=false):Promise<boolean>{
    // Invalidates inspections that began before this explicit resolution.
    session.epoch++;
    const reloaded=await invoke<{text:string;revision:number}>('reload_named_document',{handle:session.handle});
    if(!reloaded||typeof reloaded.text!=='string'||typeof reloaded.revision!=='number')throw new Error('The native reload did not return the file content.');
    if(openedSessions.current[name]!==session)return false;
    const current=latest.current.documents[name];
    if(!current)return false;
    let contents;
    try { contents=await markdownContents({handle:session.handle,name,text:reloaded.text,revision:reloaded.revision},explicit); }
    catch(error){
      // The registry has already adopted the disk content, so its revision is what every later
      // write must expect. The editor keeps the user's draft and the conflict stays open with
      // its guidance until the file can be applied or Keep Local replaces it.
      adoptNativeRevision(session,reloaded.revision);
      session.holdConflict=true;
      // Reset resumes autosave; the unresolved conflict must keep it paused.
      session.queue.pause();
      throw new Error(`The file on disk cannot be applied: ${String(error)} Its revision was adopted so saving is not stuck: choose Save a Copy to keep this draft, Keep Local to replace the file, or fix the file and reload again.`);
    }
    // Edits made while the file was being read are newer than "no unsaved work exists".
    // Keep them and present the disk version as a conflict instead of replacing the editor.
    if(!explicit&&(session.queue.state!=='saved'||session.blocked!==undefined)){
      adoptNativeRevision(session,reloaded.revision);
      // The native baseline now holds the disk version while the editor keeps newer local edits;
      // without this the next unchanged poll would drop the conflict and let an autosave
      // overwrite the external version.
      session.holdConflict=true;
      installExternal(name,session,{kind:'markdown',text:reloaded.text,missing:false,retained:[]});
      return false;
    }
    session.attachments=contents.attachments;
    session.namespace=contents.namespace;
    session.rootReady=contents.rootReady;
    applyReloaded(name,contents.document,reloaded.revision,session,`Reloaded ${name} from disk.`);
    return true;
  }
  async function reloadPaired(name:string,session:SaveSession,explicit=false):Promise<boolean>{
    session.epoch++;
    const opened=await invoke<OpenedPair|null>('reload_paired_document',{handle:session.handle});
    if(!opened||!('source_name' in opened))throw new Error('The native reload did not return the paired files.');
    if(openedSessions.current[name]!==session)return false;
    let contents;
    try { contents=await pairContents(opened,latest.current.documents[name]?.pair?.locationId); }
    catch(error){
      // The group is adopted natively but not applied to the editor; nothing local is replaced
      // by an unreadable asset index. The adopted revisions keep later saves from conflicting.
      adoptNativeRevision(session,opened.revisions);
      session.holdConflict=true;
      session.queue.pause();
      throw new Error(`The files on disk cannot be applied: ${String(error)} Their revisions were adopted so saving is not stuck: choose Save a Copy to keep this draft, Keep Local to replace them, or fix the files and reload again.`);
    }
    if(!explicit&&(session.queue.state!=='saved'||session.blocked!==undefined)){
      adoptNativeRevision(session,opened.revisions);
      session.holdConflict=true;
      installExternal(name,session,{kind:'paired',source:opened.source,css:opened.css,assets:opened.assets,missing:[],retained:[]});
      return false;
    }
    if(contents.missing.length)setAssetNotice({name,message:`Missing adjacent document assets kept as references: ${contents.missing.join('; ')}.`});
    applyReloaded(name,contents.document,opened.revisions,session,`Reloaded ${name} from disk.`);
    return true;
  }
  async function inspectSession(name:string,session:SaveSession){
    if(!('__TAURI_INTERNALS__' in window))return;
    if(inspecting.current[name])return;
    // A write already publishing owns the baseline until it resolves; inspect it next tick.
    if(session.queue.state==='saving')return;
    inspecting.current[name]=true;
    // A resolution requested while this read is in flight must win over its older result.
    const epoch=session.epoch;
    try {
      if(session.kind==='markdown'){
        const state=await invoke<NativeDocumentState>('inspect_named_document',{handle:session.handle}).catch(()=>undefined);
        if(!state||typeof state!=='object'||typeof state.changed!=='boolean')return;
        if(openedSessions.current[name]!==session||session.epoch!==epoch)return;
        if(!state.changed){ clearExternal(session); return; }
        const disk:DiskMarkdown={kind:'markdown',text:state.text,missing:Boolean(state.missing),error:state.error??undefined,retained:Array.isArray(state.retained)?state.retained:[]};
        if(!disk.missing&&disk.text!==null&&!disk.error&&session.queue.state==='saved'&&session.blocked===undefined&&session.external===undefined){
          // No unsaved local work: adopt the external version without a dialog.
          try { await reloadMarkdown(name,session); }
          catch(error) { installExternal(name,session,disk,String(error)); }
          return;
        }
        installExternal(name,session,disk);
        return;
      }
      const state=await invoke<NativePairState>('inspect_paired_document',{handle:session.handle}).catch(()=>undefined);
      if(!state||typeof state!=='object'||typeof state.changed!=='boolean')return;
      if(openedSessions.current[name]!==session||session.epoch!==epoch)return;
      if(!state.changed){ clearExternal(session); return; }
      const disk:DiskPair={kind:'paired',source:state.source,css:state.css,assets:state.assets,missing:Array.isArray(state.missing)?state.missing:[],error:state.error??undefined,retained:Array.isArray(state.retained)?state.retained:[]};
      if(!disk.missing.length&&!disk.error&&disk.source!==null&&session.queue.state==='saved'&&session.blocked===undefined&&session.external===undefined){
        try { await reloadPaired(name,session); }
        catch(error) { installExternal(name,session,disk,String(error)); }
        return;
      }
      installExternal(name,session,disk);
    } finally { delete inspecting.current[name]; }
  }
  async function verifyConflict(session:SaveSession){
    if(session.external||session.queue.state!=='failed')return;
    // A failed write reports a conflict as text; expected-revision failures are local, not
    // evidence of an external change, so only these messages trigger an inspection.
    if(!/changed on disk|revision conflict/i.test(String(session.queue.error)))return;
    const name=Object.keys(openedSessions.current).find(candidate=>openedSessions.current[candidate]===session);
    if(!name)return;
    await inspectSession(name,session);
  }
  inspectExternal.current=inspectSession;
  verifyWriteConflict.current=verifyConflict;
  function retainedNotice(retained:RetainedVersion[]):string {
    const paths=retained.map(version=>version.path).join(', ');
    return `An external edit made after the comparison was replaced on disk. It is preserved at ${paths}. Reload Disk restores it; Keep Local again discards it.`;
  }
  async function resolveExternal(action:'reload'|'keep'){
    const name=conflictTarget;
    if(!name||conflictBusy)return;
    const session=openedSessions.current[name];
    const current=latest.current.documents[name];
    if(!session?.external||!current)return;
    if(session.queue.state==='saving'){setConflictError('A save is still finishing. Try again when it completes.');return;}
    const id=documentIds.current[name];
    // An inspection already reading the disk must not reinstate the conflict after this action.
    session.epoch++;
    setConflictBusy(true);setConflictError('');setConflictNotice('');
    try {
      if(action==='reload'){
        if(session.kind==='markdown')await reloadMarkdown(name,session,true);
        else await reloadPaired(name,session,true);
        setConflictTarget(undefined);
        return;
      }
      if(session.kind==='markdown'){
        if(!await ensureMarkdownRoot(name,true)){setConflictError('An attachments folder is required before this version can replace the file on disk.');return;}
        const snapshot=session.snapshot(current);
        if(!('format' in snapshot)||snapshot.format!=='markdown')throw new Error('Could not create the Markdown overwrite snapshot.');
        // The version the user compared, so native can tell a late external edit from it.
        const shown=session.external.kind==='markdown'?session.external.text:null;
        const result=await invoke<OverwriteResult>('overwrite_markdown_document',{handle:session.handle,text:snapshot.text,shown,files:snapshot.files});
        if(typeof result?.revision!=='number')throw new Error('The native overwrite did not report a revision.');
        if(openedSessions.current[name]!==session||documentIds.current[name]!==id)return;
        const updated={...latest.current.documents[name],originalMarkdown:snapshot.text};
        const next={...latest.current,documents:{...latest.current.documents,[name]:updated}};
        latest.current=next;
        setDocuments(next.documents);
        // The file write already succeeded, so a recovery failure is reported without
        // discarding the adopted revision or the kept content.
        if(!writeDrafts(next)){
          const failure=new Error('Draft recovery failed after replacing the file; keep the document open and save again.');
          session.blocked=failure;
          setSaveError(String(failure));
        }
        adoptNativeRevision(session,result.revision);
        const kept=`Kept the local version of ${name} and replaced the file on disk.`;
        if(result.retained?.length){
          // A write that arrived after the comparison was displaced; name it, and keep the
          // comparison open so Reload Disk can put it back instead of losing it silently.
          installExternal(name,session,{kind:'markdown',text:snapshot.text,missing:false,retained:result.retained});
          session.holdConflict=true;
          setCopyStatus(kept);
          setConflictNotice(retainedNotice(result.retained));
          refreshSaveState(n=>n+1);
          return;
        }
        session.external=undefined;
        session.holdConflict=false;
        refreshSaveState(n=>n+1);
        setCopyStatus(kept);
        setConflictTarget(undefined);
        return;
      }
      if(!current.pair)throw new Error('The paired document association is missing; reopen the files before resolving.');
      const snapshot=pairedSnapshot(current,current.pair);
      const shown=session.external.kind==='paired'?{source:session.external.source,css:session.external.css,assets:session.external.assets}:null;
      const result=await invoke<PairedWrite>('overwrite_paired_document',{handle:session.handle,source:snapshot.source,css:snapshot.css,assets:snapshot.assets,shown});
      if(!result?.revisions)throw new Error('The native overwrite did not report revisions.');
      if(openedSessions.current[name]!==session||documentIds.current[name]!==id)return;
      session.revisions=result.revisions;
      if(result.failure){
        const written=result.written.length?`The ${result.written.join(', ')} reached disk`:'No file in the group reached disk';
        throw new Error(`${result.failure.member} could not be saved: ${result.failure.message}. ${written}; the files are saved individually, not as one atomic transaction. Your draft is retained and the conflict stays open.`);
      }
      adoptNativeRevision(session,result.revisions);
      const untouched=result.untouched_companions;
      const live=latest.current.documents[name];
      if(untouched&&live.pair){
        applyDocument(name,{
          ...live,
          css:live.pair.cssCompanion?live.css:untouched.css??live.css,
          assets:untouched.assets===null?live.assets:{...decodePairedAssets(untouched.assets),...live.assets},
          pair:{...live.pair,cssCompanion:live.pair.cssCompanion||untouched.css!==null,assetsCompanion:live.pair.assetsCompanion||untouched.assets!==null},
        });
      }
      if(result.retained?.length){
        installExternal(name,session,{kind:'paired',source:snapshot.source,css:snapshot.css??untouched?.css??null,assets:snapshot.assets??untouched?.assets??null,missing:[],retained:result.retained});
        session.holdConflict=true;
        setCopyStatus(`Kept the local version of ${name} and replaced its files on disk.`);
        setConflictNotice(retainedNotice(result.retained));
        refreshSaveState(n=>n+1);
        return;
      }
      session.external=undefined;
      session.holdConflict=false;
      refreshSaveState(n=>n+1);
      setCopyStatus(`Kept the local version of ${name} and replaced its files on disk.`);
      setConflictTarget(undefined);
    } catch(error) { setConflictError(String(error)); refreshSaveState(n=>n+1); }
    finally { setConflictBusy(false); }
  }
  useEffect(()=>{
    if(!('__TAURI_INTERNALS__' in window))return;
    let disposed=false;
    const tick=()=>{
      if(disposed)return;
      const name=latest.current.active;
      const session=openedSessions.current[name];
      if(session)void inspectExternal.current(name,session);
    };
    // Poll the active group while it is associated with a file. Every write updates the
    // native baseline, so our own saves are recognized instead of being reloaded.
    const immediate=setTimeout(tick,0);
    const timer=setInterval(tick,1000);
    return()=>{disposed=true;clearTimeout(immediate);clearInterval(timer);};
  },[active]);
  useEffect(()=>{
    // A conflict detected while this tab was in the background (an autosave there failed)
    // must not leave an apparently idle, silently paused tab. Opening is tied to activation so
    // a dialog the user dismissed with "Keep paused" is not reopened by the next poll.
    const session=openedSessions.current[active];
    if(session?.external&&conflictTarget!==active)openConflict(active);
    // Runs only on activation: a dialog dismissed with "Keep paused" stays dismissed.
  },[active]);
  useEffect(()=>{
    // A conflict that arrived under Settings or the image style dialog opens once the modal
    // is gone, so two dialogs never share the window.
    if(settingsOpen||imageStyleTarget)return;
    const session=openedSessions.current[active];
    if(session?.external&&conflictTarget!==active)openConflict(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the modal closing.
  },[settingsOpen,imageStyleTarget]);
  function applyDocument(name:string,updated:DraftDocument,requireRecovery=false){
    const workspace=latest.current;
    const next={...workspace,documents:{...workspace.documents,[name]:updated}};
    const recovered=writeDrafts(next);
    if(requireRecovery&&!recovered)return false;
    latest.current=next;
    setDocuments(next.documents);
    const session=openedSessions.current[name];
    if(session){
      const wasBlocked=session.blocked!==undefined;
      if(!recovered)session.blocked=session.blocked??new Error('Draft recovery failed, so the latest edits cannot be saved yet. Keep the document open and save again.');
      // Autosave stays paused while the external version is unresolved. The recovery write
      // above still captured the user's draft; no snapshot is enqueued over the conflict.
      else if(!session.external)try { session.queue.update(session.snapshot(updated)); session.blocked=undefined; }
      catch(error) { session.blocked=error; if(!wasBlocked)setSaveError(String(error)); }
      if((session.blocked!==undefined)!==wasBlocked)refreshSaveState(n=>n+1);
    }
    return true;
  }
  function applyText(part:Part,value:string){
    const current=latest.current.documents[active];
    // An explicit styling edit is what makes an in-memory stylesheet persistable as a
    // companion; opening a standalone .mmd or editing only its source never creates one.
    applyDocument(active,{...current,[part]:value,...(part==='css'&&current.pair&&!current.pair.cssCompanion?{pair:{...current.pair,cssCompanion:true}}:{})});
  }
  function edit(part:Part,value:string, coalesce=false, pairs?:readonly DelimiterPair[]){
    if(!doc||value===doc[part])return;
    const history=histories.current[active][part];
    if(!coalesce)history.undo.push({value:doc[part],caret:carets.current[active][part],pairs:currentPairs(history,doc[part])});
    history.redo=[];
    history.paired=pairs?.length?{value,pairs}:undefined;
    applyText(part,value);
  }
  function changeEditorText(part:Part,value:string,caret:number){
    if(!doc)return;
    const before=doc[part];
    const pairs=currentPairs(histories.current[active][part],before);
    edit(part,value,false,pairsAfterInput(pairs,before,value,carets.current[active][part].start,caret));
  }
  function travel(direction:'undo'|'redo'){
    if(!doc||!history)return;
    paletteGesture.current.changed=false;
    const entry=history[direction].pop();if(!entry)return;
    const editor=part==='source'?sourceEditor.current:cssEditor.current;
    const caret=editor?{start:editor.selectionStart,end:editor.selectionEnd}:carets.current[active][part];
    history[direction==='undo'?'redo':'undo'].push({value:doc[part],caret,pairs:currentPairs(history,doc[part])});
    history.paired=entry.pairs?.length?{value:entry.value,pairs:entry.pairs}:undefined;
    carets.current[active][part]=entry.caret;
    if(editor)selection.current={editor,...entry.caret};
    applyText(part,entry.value);
  }
  function rememberCaret(event:React.SyntheticEvent<HTMLElement>){
    if(!(event.target instanceof HTMLTextAreaElement))return;
    const editor=event.target;const part=editor===sourceEditor.current?'source':'css';
    if(part==='source')sourceTouched.current=true;
    carets.current[active][part]={start:editor.selectionStart,end:editor.selectionEnd};
  }
  function applyEditorEdit(editor:HTMLTextAreaElement,part:Part,value:string,start:number,end:number,pairs:readonly DelimiterPair[]){
    if(value===editor.value)editor.setSelectionRange(start,end);
    else{
      selection.current={editor,start,end};
      edit(part,value,false,pairs);
    }
    carets.current[active][part]={start,end};
  }
  function editorKeyDown(event:React.KeyboardEvent<HTMLElement>){
    rememberCaret(event);
    if(event.defaultPrevented||event.nativeEvent.isComposing)return;
    if((event.metaKey||event.ctrlKey)&&!event.altKey&&event.key.toLowerCase()==='f'){event.preventDefault();setFindOpen(true);setTimeout(()=>findInput.current?.focus(),0);return;}
    if((event.metaKey||event.ctrlKey)&&!event.altKey&&event.key.toLowerCase()==='z'){
      event.preventDefault();travel(event.shiftKey?'redo':'undo');return;
    }
    if(event.ctrlKey&&!event.metaKey&&!event.altKey&&event.key.toLowerCase()==='y'){
      event.preventDefault();travel('redo');return;
    }
    if(event.key==='Escape'){escapeTab.current=true;return;}
    if(escapeTab.current&&!['Shift','Control','Alt','Meta'].includes(event.key)){escapeTab.current=false;if(event.key==='Tab')return;}
    if(!(event.target instanceof HTMLTextAreaElement))return;
    const editor=event.target;const {value,selectionStart:start,selectionEnd:end}=editor;
    const editorPart=editor===sourceEditor.current?'source':'css';
    let pairs=currentPairs(histories.current[active][editorPart],value);
    const delimiter=delimiterKeyEdit(event.nativeEvent,editor,pairs);
    if(delimiter){
      event.preventDefault();
      applyEditorEdit(editor,editorPart,delimiter.value,delimiter.start,delimiter.end,delimiter.pairs);
      return;
    }
    if((event.key!=='Tab'&&event.key!=='Enter')||event.altKey||event.ctrlKey||event.metaKey)return;
    const from=start===0?0:value.lastIndexOf('\n',start-1)+1;
    let next:string;let nextStart:number;let nextEnd:number;
    if(event.key==='Enter'){
      const indent=/^[ \t]+/.exec(value.slice(from,start))?.[0];
      if(!indent)return;
      next=value.slice(0,start)+'\n'+indent+value.slice(end);
      nextStart=nextEnd=start+1+indent.length;
      pairs=movePairs(pairs,start,end,1+indent.length);
    }else if(!event.shiftKey&&start===end){
      next=value.slice(0,start)+'  '+value.slice(end);nextStart=nextEnd=start+2;
      pairs=movePairs(pairs,start,end,2);
    }else{
      const newline=value.indexOf('\n',end>start&&value[end-1]==='\n'?end-1:end);
      const to=newline<0?value.length:newline;
      const lines=value.slice(from,to).split('\n');
      const changed=lines.map(line=>event.shiftKey?line.replace(/^( {1,2}|\t)/,''):'  '+line);
      next=value.slice(0,from)+changed.join('\n')+value.slice(to);
      const offset=(position:number)=>{
        if(position<from)return position;
        let cursor=from;let delta=0;
        for(let i=0;i<lines.length;i++){
          const change=changed[i].length-lines[i].length;
          if(position<=cursor+lines[i].length)return cursor+delta+Math.max(0,position-cursor+change);
          cursor+=lines[i].length+1;delta+=change;
        }
        return position+delta;
      };
      nextStart=offset(start);nextEnd=offset(end);
      pairs=pairs.map(({open,close})=>({open:offset(open),close:offset(close)}));
    }
    event.preventDefault();
    applyEditorEdit(editor,editorPart,next,nextStart,nextEnd,pairs);
  }
  function resizeSplit(value:number,element:HTMLElement){
    const width=element.parentElement!.getBoundingClientRect().width;
    setSplit(Math.max(width?Math.max(25,260/width*100):25,Math.min(65,value)));
  }
  function startDrag(event:React.PointerEvent<HTMLDivElement>){
    if(event.button!==0)return;
    const width=event.currentTarget.parentElement!.getBoundingClientRect().width;if(!width)return;
    event.preventDefault();event.currentTarget.focus();event.currentTarget.setPointerCapture(event.pointerId);
    drag.current={pointer:event.pointerId,x:event.clientX,split:Math.max(split,260/width*100),width,snapped:split===50};
  }
  function moveDrag(event:React.PointerEvent<HTMLDivElement>){
    const start=drag.current;if(start?.pointer!==event.pointerId)return;
    const next=start.split+(event.clientX-start.x)/start.width*100;
    const distanceFromCenter=Math.abs(next-50)*start.width/100;
    const snapDistance=start.snapped?12:8;
    start.snapped=distanceFromCenter<=snapDistance;
    resizeSplit(start.snapped?50:next,event.currentTarget);
  }
  function stopDrag(event:React.PointerEvent<HTMLDivElement>){
    if(drag.current?.pointer!==event.pointerId)return;
    drag.current=undefined;event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function resizeKey(event:React.KeyboardEvent<HTMLDivElement>){
    const step=event.shiftKey?10:1;
    const value=event.key==='ArrowLeft'?split-step:event.key==='ArrowRight'?split+step:event.key==='Home'?25:event.key==='End'?65:undefined;
    if(value!==undefined){event.preventDefault();resizeSplit(value,event.currentTarget);}
  }
  useEffect(()=>{if(!window.matchMedia)return;const q=matchMedia('(prefers-color-scheme: dark)');const update=()=>setSystemDark(q.matches);update();q.addEventListener('change',update);return()=>q.removeEventListener('change',update);},[]);
  const theme=appThemes.find(choice=>choice.id===themeId)??appThemes[0];
  const themeAppearance: 'light'|'dark'=theme.appearance==='system'?(systemDark?'dark':'light'):theme.appearance;
  const sampleAppearance=(choice:ThemeChoice)=>choice.appearance==='system'?(systemDark?'dark':'light'):choice.appearance;
  const chooseTheme=(id:string)=>{
    const choice=appThemes.find(option=>option.id===id);
    if(!choice)return;
    setThemeId(choice.id);
    try { localStorage.setItem(APP_THEME_KEY,choice.id); setThemeError(''); }
    catch { setThemeError('Could not save the appearance choice. It applies now but reverts on relaunch.'); }
  };
  const CanvasIcon=canvasOptions[canvasChoice].Icon;
  useEffect(()=>{
    const pane=panel.current;
    const toolbar=previewToolbar.current;
    const panes=pane?.parentElement;
    if(!pane||!toolbar||!panes||!globalThis.ResizeObserver)return;
    const observer=new ResizeObserver(entries=>{
      for(const entry of entries){
        if(entry.target===pane)setWidth(Math.max(240,Math.round(entry.contentRect.width)-32));
        if(entry.target===toolbar)panes.style.setProperty('--preview-toolbar-height',`${toolbar.getBoundingClientRect().height}px`);
      }
    });
    observer.observe(pane);
    observer.observe(toolbar,{box:'border-box'});
    return()=>observer.disconnect();
  },[hasDocument]);
  useEffect(()=>{
    const element=previewScroll.current;if(!element)return;
    const nativeOverscroll=globalThis.CSS?.supports?.('overscroll-behavior','none');
    const scrollPreview=(event:WheelEvent)=>{
      if(!event.cancelable||event.ctrlKey)return;
      const mode=event.deltaMode;
      const shiftScroll=event.shiftKey&&event.deltaX===0&&event.deltaY!==0;
      if(nativeOverscroll&&!shiftScroll)return;
      const {scrollTop,scrollLeft,scrollHeight,clientHeight,scrollWidth,clientWidth}=element;
      const scale=(page:number)=>mode===WheelEvent.DOM_DELTA_LINE?16:mode===WheelEvent.DOM_DELTA_PAGE?page:1;
      const left=scrollLeft+(shiftScroll?event.deltaY:event.deltaX)*scale(clientWidth);
      const top=scrollTop+(shiftScroll?0:event.deltaY)*scale(clientHeight);
      const boundedLeft=Math.max(0,Math.min(scrollWidth-clientWidth,left));
      const boundedTop=Math.max(0,Math.min(scrollHeight-clientHeight,top));
      // Older WebKit needs custom boundary handling. Keep the usable motion on both axes.
      if(!shiftScroll&&left===boundedLeft&&top===boundedTop)return;
      event.preventDefault();
      element.scrollLeft=boundedLeft;
      element.scrollTop=boundedTop;
    };
    element.addEventListener('wheel',scrollPreview,{passive:false});
    return()=>element.removeEventListener('wheel',scrollPreview);
  },[hasDocument]);
  useLayoutEffect(()=>{
    const revision=++generation.current;
    if(!doc)return;
    setPending(true);setError('');setErrorLine(0);setDiagnostic(false);
    setDiagnosticDetailsOpen(false);
    const started=performance.now();
    let diagnosticTimer:ReturnType<typeof setTimeout>|undefined;
    const timer=setTimeout(async()=>{
      try{const next=await renderDiagram(doc,{mode,width});if(revision!==generation.current)return;setViews(v=>{const view={...(v[active]??initialView()),snapshot:next};if(mode==='responsive'&&view.fitted)view.zoom=Math.min(100,Math.round(width/next.width*100));return{...v,[active]:view};});}
      catch(e){
        if(revision!==generation.current)return;
        setError(String(e));const line=(e as {line?:unknown})?.line;setErrorLine(typeof line==='number'&&Number.isInteger(line)&&line>0?line:0);
        // Detection, the export gate, and keeping the last valid preview happen at once.
        // Only the diagnostic message waits out a burst of typing, so a half-typed line
        // never flashes an error; the next edit restarts this window.
        const wait=800-(performance.now()-started);
        if(wait<=0)setDiagnostic(true);
        else diagnosticTimer=setTimeout(()=>{if(revision===generation.current)setDiagnostic(true);},wait);
      }
      finally{if(revision===generation.current)setPending(false);}
    },120);
    return()=>{clearTimeout(timer);if(diagnosticTimer)clearTimeout(diagnosticTimer);generation.current++;};
  },[doc,active,mode,mode==='responsive'?width:0]);
  useLayoutEffect(()=>{
    if(!preview.current)return;
    const root=preview.current.shadowRoot ?? preview.current.attachShadow({mode:'open'});
    // Paint the document color across the preview pane while keeping its export rectangle.
    root.innerHTML=`<style>
      :host { all: initial; display: block; -webkit-user-select: none; user-select: none; }
      svg { display: block; }
      svg > [data-orei-canvas] { display: none; }
    </style>${snapshot?.svg??''}`;
    const background=root.querySelector('svg')?.getAttribute('data-orei-background');
    previewScroll.current?.style.setProperty('--document-canvas',background??'');
  },[snapshot]);
  const documentCommand=useRef<(command:string)=>void>(()=>{});
  documentCommand.current=command=>{
    // A menu shortcut can reach the webview under an open modal. Destination pickers,
    // Close and New would either stack a dialog/sheet or change the document the modal is
    // scoped to, so they wait until the modal is closed. Save is included because its
    // attachments prompt is a native sheet.
    if((settingsOpenRef.current||imageStyleOpenRef.current)&&['new','open','save','save-as','save-copy','close'].includes(command))return;
    if(command==='new')newDocument();else if(command==='open')void openDocument();else if(command==='save')void saveDocument();else if(command==='save-as')openSaveDialog('save-as');else if(command==='save-copy')openSaveDialog('copy');else if(command==='close')setCloseTarget(active);
  };
  useEffect(()=>{
    if(!('__TAURI_INTERNALS__' in window))return;
    let disposed=false;
    const unlisteners=new Set<()=>void>();
    import('@tauri-apps/api/event')
      .then(({listen})=>{
        const retain=(fn:()=>void)=>{if(disposed)fn();else unlisteners.add(fn);};
        return Promise.all([
          listen<string>('document-request',event=>{if(!disposed)documentCommand.current(event.payload);}).then(retain),
          listen('export-request',()=>{if(!disposed)requestExport.current();}).then(retain),
          listen('settings-request',()=>{if(!disposed)requestSettings.current();}).then(retain),
          listen<string>('diagram-copy-request',event=>{
            if(disposed||!event)return;
            if(event.payload==='source')requestCopy.current('source');
            else if(event.payload==='image'||event.payload==='svg')requestCopy.current(event.payload);
          }).then(retain),
          listen<'undo'|'redo'|'find'>('edit-request',event=>{if(!disposed&&(event.payload==='undo'||event.payload==='redo'||event.payload==='find'))requestEdit.current(event.payload);}).then(retain),
        ]);
      })
      .catch(error=>console.error('Could not subscribe to native commands',error));
    return()=>{disposed=true;for(const unlisten of unlisteners)unlisten();};
  },[]);
  useEffect(()=>{
    // Evidence scenarios request the shipped samples explicitly after startup. Normal
    // launches never receive this event, so they cannot flash or persist fixture content.
    const seed=(request:Event)=>{
      const detail=(request as CustomEvent<{documents?:Record<string,DraftDocument>;active?:string}>).detail;
      if(!detail?.documents || typeof detail.documents!=='object')return;
      const entries=Object.entries(detail.documents).filter(([,document])=>Boolean(document)
        &&typeof document.source==='string'&&typeof document.css==='string'
        &&Boolean(document.assets)&&typeof document.assets==='object'&&!Array.isArray(document.assets));
      if(!entries.length)return;
      const documents=Object.fromEntries(entries.map(([name,document])=>[name,{...document,assets:{...document.assets}}])) as Record<string,DraftDocument>;
      const active=typeof detail.active==='string'&&Object.hasOwn(documents,detail.active)?detail.active:entries[0][0];
      evidenceSamples.current=true;
      documentIds.current=Object.fromEntries(Object.keys(documents).map((name,index)=>[name,`doc-${index+1}`]));
      nextDocumentId.current=Object.keys(documents).length;
      histories.current=Object.fromEntries(Object.keys(documents).map(name=>[name,{source:{undo:[],redo:[]},css:{undo:[],redo:[]}}]));
      carets.current=Object.fromEntries(Object.keys(documents).map(name=>[name,{source:{start:0,end:0},css:{start:0,end:0}}]));
      scrollPositions.current={};
      setViews({});
      latest.current={documents,active};
      setDocuments(documents);
      setActive(active);
      setDraftStatus('Evidence samples are not saved as drafts');
    };
    window.addEventListener('orei-evidence-samples',seed);
    return()=>window.removeEventListener('orei-evidence-samples',seed);
  },[]);
  useEffect(()=>{if('__TAURI_INTERNALS__' in window) { const effectMs=performance.now(); void import('./runner').then(({startRunner})=>startRunner(effectMs)).catch(error=>console.error('Could not start evidence runner',error)); }},[]);
  async function toggleMultiple(){setMultiple(!multiple);if(!multiple)setHeld(await Promise.all(Object.values(documents).map(d=>renderDiagram(d,{mode:'fixed',width:800}))));else setHeld([]);}
  const css=doc?.css??'';
  const colors=useMemo(()=>paletteValues(css),[css]);
  const imageStyleMessage=useMemo(()=>imageStyleProblem(css),[css]);
  const paletteAvailable=useMemo(()=>paletteFields.every(([name])=>rewritePalette(css,name,colors[name]||'#000000')!==undefined),[css,colors]);
  const activeScheme=Object.values(diagramSchemes).find(scheme=>Object.entries(scheme.colors).every(([name,color])=>colors[name]?.toLowerCase()===color))?.name??'';
  const [schemeError,setSchemeError]=useState(false);
  useEffect(()=>setSchemeError(false),[active,css]);
  useLayoutEffect(()=>{if(!paletteAvailable)paletteGesture.current={active:false,changed:false};},[paletteAvailable]);
  function palette(name:string,value:string){
    const next=rewritePalette(css,name,value);
    if(next===undefined||next===css)return;
    edit('css',next,paletteGesture.current.active&&paletteGesture.current.changed);
    if(paletteGesture.current.active)paletteGesture.current.changed=true;
  }
  function applyScheme(colors:Record<string,string>){
    const next=applyPalette(css,colors);
    setSchemeError(next===undefined);
    if(next!==undefined)edit('css',next);
  }
  function findNext(){
    const editor=part==='source'?sourceEditor.current:cssEditor.current;
    if(!editor||!findText)return;
    const start=editor.value.indexOf(findText,editor.selectionEnd);
    const index=start<0?editor.value.indexOf(findText):start;
    if(index>=0){editor.focus();editor.setSelectionRange(index,index+findText.length);carets.current[active][part]={start:index,end:index+findText.length};}
  }
  async function closeDocument(){
    if(!closeTarget||closingTabs.current.has(closeTarget))return;
    const target=closeTarget;
    closingTabs.current.add(target);
    try {
    const session=openedSessions.current[target];
    if(session&&session.blocked)throw new Error('Document content cannot be saved yet; resolve it before closing.');
    // A session paused on an external change is closed only after the close dialog warned
    // that the local version is discarded and the on-disk version is left untouched.
    if(session&&session.external){ if(!finalizeClose(target))return; return; }
    if(session)await(session.queue.state==='failed'?session.queue.retry():session.queue.flush());
    if(!finalizeClose(target))return;
    } catch { setCloseFailure(true); }
    finally { closingTabs.current.delete(target); }
  }
  async function forceCloseDocument(){
    if(!closeTarget||closingTabs.current.has(closeTarget))return;
    const target=closeTarget;
    closingTabs.current.add(target);
    try {
    // Emergency escape when saving or recovery is permanently stuck: dispose the queue
    // (best-effort) and discard the tab with its latest edits, as warned in the dialog.
    const session=openedSessions.current[target];
    if(session)void session.queue.dispose().catch(()=>{});
    if(!finalizeClose(target))return;
    } finally { closingTabs.current.delete(target); }
  }
  function finalizeClose(target:string):boolean{
    try {
    const current=latest.current;
    const remaining={...current.documents};delete remaining[target];
    const nextActive=current.active===target?(Object.keys(remaining)[0]??''):current.active;
    if(!writeDrafts({documents:remaining,active:nextActive})){setCloseFailure(true);return false;}
    const session=openedSessions.current[target];
    if(session){
      void session.queue.dispose().catch(()=>{});
      delete openedSessions.current[target];
      // Release the native handle and any retained conflict staging; the files on disk are
      // not touched by a close.
      if('__TAURI_INTERNALS__' in window)void invoke(session.kind==='markdown'?'release_named_document':'release_paired_document',{handle:session.handle}).catch(()=>{});
    }
    delete documentIds.current[target];
    delete histories.current[target];delete carets.current[target];
    delete scrollPositions.current[target];
    setViews(v=>{const next={...v};delete next[target];return next;});
    latest.current={documents:remaining,active:nextActive};
    setDocuments(remaining);setActive(nextActive);setCloseTarget(undefined);setCloseFailure(false);
    if(!nextActive){
      setFindOpen(false);setFindText('');
      setPreviewTab('preview');setDocsOpened(false);
      setMultiple(false);setHeld([]);
      setCopyStatus('');
      sourceTouched.current=false;
      escapeTab.current=false;
      requestedSourceLine.current=0;
      pan.current=undefined;
    }
    if(assetNotice?.name===target)setAssetNotice(undefined);
    return true;
    } catch { setCloseFailure(true); return false; }
  }
  function newDocumentId(){return `doc-${++nextDocumentId.current}`;}
  async function reconnectPaired(name:string,id:string,pick:boolean){
    const baseline=initial.documents[name];
    const pair=baseline?.pair;
    if(!pair||(pick&&opening.current))return;
    if(pick)opening.current=true;
    const stillHere=()=>mounted.current&&documentIds.current[name]===id&&!openedSessions.current[name];
    let opened:OpenedFile|null=null;
    let connected=false;
    try {
      const filename=`${pair.base}.mmd`;
      opened=pick
        ?await invoke<OpenedFile|null>('open_named_document',{pairedName:filename})
        :await invoke<OpenedPair|null>('restore_paired_document',{locationId:pair.locationId});
      if(!opened||!stillHere())return;
      if(!isOpenedPair(opened)||opened.base!==pair.base)throw new Error(`Choose ${filename} to reconnect this tab.`);
      const {document:disk,missing}=await pairContents(opened);
      if(!stillHere())return;
      const live=latest.current.documents[name];
      const canSave=matchesOpenedPair(baseline,disk)||matchesOpenedPair(live,disk);
      const updated={...live,pair:{...live.pair!,locationId:opened.location_id}};
      if(canSave&&disk.pair!.assetsCompanion)updated.pair.assetsCompanion=true;
      const next={...latest.current,documents:{...latest.current.documents,[name]:updated}};
      const recovered=writeDrafts(next);
      latest.current=next;
      setDocuments(next.documents);
      const session=pairedSession(opened);
      openedSessions.current[name]=session;
      connected=true;
      if(missing.length)setAssetNotice({name,message:`Missing adjacent document assets kept as references: ${missing.join('; ')}.`});
      if(!canSave){
        // Native authorization already adopted the version currently on disk. Keep the
        // comparison open even when the next inspection reports an unchanged baseline.
        session.holdConflict=true;
        const missingMembers=[];
        if(pair.cssCompanion&&opened.css===null)missingMembers.push('stylesheet');
        if(pair.assetsCompanion&&opened.assets===null)missingMembers.push('asset index');
        installExternal(name,session,{kind:'paired',source:opened.source,css:opened.css,assets:opened.assets,missing:missingMembers,retained:[]});
      } else if(!matchesOpenedPair(updated,disk)){
        try {
          if(!recovered)throw new Error('Draft recovery failed, so the latest edits cannot be saved yet. Keep the document open and save again.');
          session.queue.update(session.snapshot(updated));
        } catch(error) { session.blocked=error; }
      }
      refreshSaveState(n=>n+1);
    } catch(error) { if(pick&&stillHere())setSaveError(String(error)); }
    finally {
      if(opened&&!connected)void invoke(isOpenedPair(opened)?'release_paired_document':'release_named_document',{handle:opened.handle}).catch(()=>{});
      if(pick)opening.current=false;
    }
  }
  useEffect(()=>{
    if(!('__TAURI_INTERNALS__' in window))return;
    for(const [name,document] of Object.entries(initial.documents)){
      if(typeof document.pair?.locationId!=='string'||!document.pair.locationId)continue;
      const operation=reconnectPaired(name,documentIds.current[name],false);
      restoringPairs.current.set(name,operation);
      void operation.finally(()=>restoringPairs.current.delete(name));
    }
  },[initial]);
  async function saveFirst(name:string){
    if(firstSaving.current)return;
    const id=documentIds.current[name];
    const current=latest.current.documents[name];
    if(!id||!current)return;
    firstSaving.current=name;
    setCopyStatus('');
    setSaveError('');
    try {
      if(current.pair){
        if(destinationPending.current)return;
        await restoringPairs.current.get(name);
        if(documentIds.current[name]!==id)return;
        if(!openedSessions.current[name])await reconnectPaired(name,id,true);
        const session=openedSessions.current[name];
        if(documentIds.current[name]===id&&session&&!session.external)await saveOpenedDocument(name,session);
        return;
      }
      const prepared=await invoke<{destination:string;attachments:string;namespace:string}|null>('prepare_markdown_destination',{defaultName:defaultDestinationName(current,name,'markdown'),needsAttachments:carriesAttachments(current),overrideAttachments:false});
      if(!prepared){setCopyStatus('Save cancelled.');return;}
      const snapshot=markdownSnapshot(current,prepared.attachments,prepared.namespace,Object.keys(current.assets).length>0,true);
      let created:{handle:string;name:string;text:string;revision:number}|null;
      try { created=await invoke('create_markdown_document',{destination:prepared.destination,text:snapshot.text,files:snapshot.files}); }
      catch(error) { void invoke('cancel_markdown_destination',{destination:prepared.destination}).catch(()=>{}); throw error; }
      if(!created){void invoke('cancel_markdown_destination',{destination:prepared.destination}).catch(()=>{});return;}
      if(created.text!==snapshot.text)throw new Error('The new file changed during saving. It has not been associated with this draft. Your edits remain recoverable.');
      const currentName=Object.keys(latest.current.documents).find(candidate=>documentIds.current[candidate]===id);
      if(!currentName){setCopyStatus(`Saved ${created.name}. The document was closed while the save picker was open; the file contains the content from when Save was chosen.`);return;}
      const moved={...latest.current.documents[currentName],originalMarkdown:created.text};
      let display=created.name,number=2;
      while(display!==currentName&&Object.hasOwn(latest.current.documents,display))display=`${created.name} (${number++})`;
      const session=markdownSession(created.handle,created.revision,prepared.attachments,prepared.namespace,true);
      openedSessions.current[display]=session;
      if(display!==currentName){
        histories.current[display]=histories.current[currentName];delete histories.current[currentName];
        carets.current[display]=carets.current[currentName];delete carets.current[currentName];
        setViews(v=>{if(!Object.hasOwn(v,currentName))return v;const next={...v};next[display]=v[currentName];delete next[currentName];return next;});
        if(scrollPositions.current[currentName]){scrollPositions.current[display]=scrollPositions.current[currentName];delete scrollPositions.current[currentName];}
        documentIds.current[display]=id;delete documentIds.current[currentName];
      }
      const documents:Record<string,DraftDocument>={};
      for(const [key,value] of Object.entries(latest.current.documents))documents[key===currentName?display:key]=key===currentName?moved:value;
      const nextActive=latest.current.active===currentName?display:latest.current.active;
      latest.current={documents,active:nextActive};
      setDocuments(documents);setActive(nextActive);
      if(!writeDrafts(latest.current)){
        // Recovery failed, but the session is already live: queue the pending snapshot so a
        // later Save flushes it instead of reporting an empty queue as success. This is a
        // deliberate exception to "recovery must be recorded before update" (save-queue.ts):
        // the file write is more durable than the failed local recovery.
        try { const pendingText=session.snapshot(moved); if(!sameMarkdownContent(pendingText,snapshot))session.queue.update(pendingText); }
        catch(pendingError) { session.blocked=pendingError; }
        throw new Error('The file was created, but draft recovery failed. Keep the document open and save again after resolving recovery.');
      }
      let latestText:SaveResult;
      try { latestText=session.snapshot(moved); } catch(error) { session.blocked=error; setSaveError(String(error)); return; }
      if(!sameMarkdownContent(latestText,snapshot)){
        session.queue.update(latestText);
        try { await session.queue.flush(); } catch(error) { setSaveError(String(error)); }
      }
    } catch(error) { setSaveError(String(error)); }
    finally { firstSaving.current=undefined; }
  }
  async function saveOpenedDocument(name:string,session:SaveSession){
    if(session.external){openConflict(name);return;}
    if(session.kind==='markdown'&&!await ensureMarkdownRoot(name,true)){
      setSaveError('Save cancelled: this note needs an attachments folder before its images or stylesheet can be saved.');
      return;
    }
    if(!writeDrafts(latest.current)){
      session.blocked=session.blocked??new Error('Draft recovery failed, so the latest edits cannot be saved yet. Keep the document open and save again.');
      setSaveError(String(session.blocked));
      return;
    }
    if(session.blocked){
      // The content could not be serialized when the session was created; re-attempt now
      // that the document may have changed, instead of treating an empty flush as success.
      // Always submit the full current snapshot: the queued one may be stale when an edit
      // was blocked from enqueueing earlier.
      const document=latest.current.documents[name];
      try {
        session.queue.update(session.snapshot(document));
        session.blocked=undefined;
        refreshSaveState(n=>n+1);
      } catch(error) { session.blocked=error; setSaveError(String(error)); refreshSaveState(n=>n+1); return; }
    }
    try { await(session.queue.state==='failed'?session.queue.retry():session.queue.flush()); }
    catch(error) { setSaveError(String(error)); void verifyWriteConflict.current(session); }
  }
  async function saveDocument(){
    const name=latest.current.active;
    if(!name)return;
    const session=openedSessions.current[name];
    if(session){await saveOpenedDocument(name,session);return;}
    if(firstSavePending.current){await firstSavePending.current;return;}
    const pending=saveFirst(name);
    firstSavePending.current=pending;
    try { await pending; }
    finally { if(firstSavePending.current===pending)firstSavePending.current=undefined; }
  }
  function newDocument(source?:string){
    const current=latest.current.documents;
    let number=1;while(Object.hasOwn(current,`Untitled ${number}`))number++;
    const name=`Untitled ${number}`;
    documentIds.current[name]=newDocumentId();
    histories.current[name]={source:{undo:[],redo:[]},css:{undo:[],redo:[]}};
    carets.current[name]={source:{start:0,end:0},css:{start:0,end:0}};
    const document=blankDocument(source);
    const markdown=createMarkdownDocument({mermaid:document.source,css:document.css});
    parseMarkdownDocument(markdown);
    const next={documents:{...current,[name]:{...document,originalMarkdown:markdown}},active:name};
    latest.current=next;
    setDocuments(next.documents);setActive(name);
  }
  async function openDocument(){
    if(opening.current)return;
    opening.current=true;
    let selected:OpenedFile|null=null;
    let installed=false;
    try {
      selected=await invoke<OpenedFile|null>('open_named_document');
      if(!selected)return;
      const filename=isOpenedPair(selected)?selected.source_name:selected.name;
      let document:DraftDocument;
      let session:SaveSession;
      let missing:string[]=[];
      if(isOpenedPair(selected)){
        const contents=await pairContents(selected);
        document=contents.document;
        missing=contents.missing;
        session=pairedSession(selected);
      }else{
        if(!selected.name.toLowerCase().endsWith('.md'))throw new Error('Only Markdown and Mermaid documents are supported.');
        const contents=await markdownContents(selected,true);
        document=contents.document;
        session=markdownSession(selected.handle,selected.revision,contents.attachments,contents.namespace,contents.rootReady);
      }
      const current=latest.current.documents;
      const base=filename && !Object.hasOwn(Object.prototype,filename)?filename:'Opened document';
      let name=base, number=2;
      while(Object.hasOwn(current,name))name=`${base} (${number++})`;
      setAssetNotice(missing.length?{name,message:`Missing adjacent document assets kept as references: ${missing.join('; ')}.`}:undefined);
      documentIds.current[name]=newDocumentId();
      openedSessions.current[name]=session;
      histories.current[name]={source:{undo:[],redo:[]},css:{undo:[],redo:[]}};
      carets.current[name]={source:{start:0,end:0},css:{start:0,end:0}};
      const workspace={documents:{...current,[name]:document},active:name};
      latest.current=workspace;
      setDocuments(workspace.documents);setActive(name);
      installed=true;
    } catch(error) { setOpenError(String(error));if(selected&&!installed)void invoke(isOpenedPair(selected)?'release_paired_document':'release_named_document',{handle:selected.handle}).catch(()=>{}); }
    finally { opening.current=false; }
  }
  function moveTabState(from:string,to:string,id:string){
    histories.current[to]=histories.current[from];delete histories.current[from];
    carets.current[to]=carets.current[from];delete carets.current[from];
    setViews(v=>{if(!Object.hasOwn(v,from))return v;const next={...v};next[to]=v[from];delete next[from];return next;});
    if(scrollPositions.current[from]){scrollPositions.current[to]=scrollPositions.current[from];delete scrollPositions.current[from];}
    documentIds.current[to]=id;delete documentIds.current[from];
  }
  function focusDocumentFallback(){
    const tab=document.getElementById(`tab-${documentIds.current[latest.current.active]}`);
    if(tab){tab.focus();return;}
    emptyNewButton.current?.focus();
  }
  function openSaveDialog(mode:SaveMode){
    const current=latest.current.documents[latest.current.active];
    if(!current)return;
    // One destination operation at a time: a dialog opened while a first save or another
    // destination creation is in flight would render a submit button that silently no-ops.
    if(destinationPending.current||firstSaving.current){setCopyStatus('A save operation is already in progress. Finish or cancel it before using Save As or Save Copy again.');return;}
    // Remember where the command started so Escape or Cancel returns keyboard focus there;
    // a native-menu invocation can leave no sensible control focused, so keep a fallback.
    const focused=document.activeElement;
    saveDialogFocus.current=focused instanceof HTMLElement&&focused!==document.body?focused:null;
    setSaveError('');
    setCopyStatus('');
    setOverrideAttachments(false);
    setSaveTarget(documentFormat(current));
    setSaveDialog(mode);
  }
  const plannedDestination=saveDialog?((): {plan?:Conversion;error:string} => {
    const document=latest.current.documents[latest.current.active];
    try { return {plan:planConversion(document,saveTarget),error:''}; }
    catch(error) { return {error:String(error)}; }
  })():undefined;
  async function saveDestination(){
    if(!saveDialog||destinationPending.current||firstSaving.current)return;
    const mode=saveDialog,target=saveTarget;
    const name=latest.current.active;
    const current=latest.current.documents[name];
    const id=documentIds.current[name];
    const identity=histories.current[name];
    if(!current||!id)return;
    let plan:Conversion;
    try { plan=planConversion(current,target); } catch(error) { setSaveError(String(error)); return; }
    destinationPending.current=true;
    setSaveDialog(undefined);
    setSaveError('');
    setCopyStatus('');
    const unchanged=(candidate:string)=>documentIds.current[candidate]===id&&histories.current[candidate]===identity&&latest.current.documents[candidate]===current;
    try {
      const defaultName=defaultDestinationName(current,name,target);
      if(target==='markdown'){
        if(plan.format!=='markdown')throw new Error('The conversion did not produce a Markdown destination.');
        const prepared=await invoke<{destination:string;attachments:string;namespace:string}|null>('prepare_markdown_destination',{defaultName,needsAttachments:carriesAttachments(current),overrideAttachments});
        if(!prepared){setCopyStatus('Save cancelled.');return;}
        const snapshot=markdownSnapshot(current,prepared.attachments,prepared.namespace,Object.keys(current.assets).length>0,true);
        if(mode==='copy'){
          try {
            if(await invoke<boolean>('save_markdown_copy',{destination:prepared.destination,text:snapshot.text,files:snapshot.files}))setCopyStatus(unchanged(name)?'Copy saved.':'An earlier version was saved. The draft changed while the picker was open; save another copy to include the latest edits.');
            else void invoke('cancel_markdown_destination',{destination:prepared.destination}).catch(()=>{});
          } catch(error) { void invoke('cancel_markdown_destination',{destination:prepared.destination}).catch(()=>{});throw error; }
          return;
        }
        let created:{handle:string;name:string;text:string;revision:number}|null;
        try { created=await invoke('create_markdown_document',{destination:prepared.destination,text:snapshot.text,files:snapshot.files}); }
        catch(error) { void invoke('cancel_markdown_destination',{destination:prepared.destination}).catch(()=>{});throw error; }
        if(!created){void invoke('cancel_markdown_destination',{destination:prepared.destination}).catch(()=>{});return;}
        if(created.text!==snapshot.text)throw new Error('The new file changed during saving. It has not been associated with this document. Your edits remain recoverable.');
        const liveName=Object.keys(latest.current.documents).find(candidate=>documentIds.current[candidate]===id);
        if(!liveName){void invoke('release_named_document',{handle:created.handle}).catch(()=>{});setCopyStatus(`Saved ${created.name}. The document was closed while the picker was open; the file contains the content from when Save As was chosen.`);return;}
        const live=latest.current.documents[liveName];
        const destination:DraftDocument={source:live.source,css:live.css,assets:live.assets,originalMarkdown:created.text};
        await adoptDestination(liveName,created.name,destination,markdownSession(created.handle,created.revision,prepared.attachments,prepared.namespace,true),snapshot);
        return;
      }
      if(plan.format!=='paired')throw new Error('The conversion did not produce a paired destination.');
      const snapshot=plan.snapshot;
      if(mode==='copy'){
        if(await invoke<boolean>('save_paired_copy',{source:snapshot.source,css:snapshot.css,assets:snapshot.assets,defaultName}))setCopyStatus(unchanged(name)?'Copy saved.':'An earlier version was saved. The draft changed while the picker was open; save another copy to include the latest edits.');
        return;
      }
      const opened=await invoke<OpenedPair|null>('create_paired_destination',{source:snapshot.source,css:snapshot.css,assets:snapshot.assets,defaultName});
      if(!opened)return;
      const liveName=Object.keys(latest.current.documents).find(candidate=>documentIds.current[candidate]===id);
      if(!liveName){setCopyStatus(`Saved ${opened.source_name}. The document was closed while the picker was open; the file contains the content from when Save As was chosen.`);return;}
      const live=latest.current.documents[liveName];
      const destination:DraftDocument={source:live.source,css:live.css,assets:live.assets,pair:{base:opened.base,cssCompanion:opened.css!==null,assetsCompanion:opened.assets!==null,locationId:opened.location_id}};
      await adoptDestination(liveName,opened.source_name,destination,pairedSession(opened),snapshot);
    } catch(error) { setSaveError(String(error)); }
    finally { destinationPending.current=false; }
  }
  async function adoptDestination(liveName:string,destinationName:string,destination:DraftDocument,session:SaveSession,written:SaveResult){
    const previous=openedSessions.current[liveName];
    let display=destinationName,number=2;
    while(display!==liveName&&Object.hasOwn(latest.current.documents,display))display=`${destinationName} (${number++})`;
    if(display!==liveName){moveTabState(liveName,display,documentIds.current[liveName]!);delete openedSessions.current[liveName];}
    openedSessions.current[display]=session;
    const documents:Record<string,DraftDocument>={};
    for(const [key,value] of Object.entries(latest.current.documents))documents[key===liveName?display:key]=key===liveName?destination:value;
    const nextActive=latest.current.active===liveName?display:latest.current.active;
    latest.current={documents,active:nextActive};
    setDocuments(documents);setActive(nextActive);
    // The destination is complete before the active save identity, recovery record, and
    // session association change; the previous file is retained on disk. Releasing the old
    // session also restores any version its last save had displaced into retention.
    if(previous&&previous!==session){
      void previous.queue.dispose().catch(error=>console.error('Could not finish saving the previous destination',error));
      if('__TAURI_INTERNALS__' in window)void invoke(previous.kind==='markdown'?'release_named_document':'release_paired_document',{handle:previous.handle}).catch(()=>{});
    }
    if(!writeDrafts(latest.current)){
      // The destination exists, so keep the live session and carry its snapshot; a later Save
      // flushes it instead of reporting an empty queue as success.
      try { const pending=session.snapshot(destination); if(!sameWritten(pending,written))session.queue.update(pending); }
      catch(error) { session.blocked=error; }
      refreshSaveState(n=>n+1);
      throw new Error('The new file was created, but draft recovery failed. Keep the document open and save again after resolving recovery.');
    }
    try {
      const pending=session.snapshot(latest.current.documents[display]);
      if(!sameWritten(pending,written)){session.queue.update(pending);await session.queue.flush();}
    } catch(error) { session.blocked=error; setSaveError(String(error)); refreshSaveState(n=>n+1); return; }
    refreshSaveState(n=>n+1);
    setCopyStatus(`Saved ${display}.`);
  }
  async function importIcon(){
    if(iconBusy)return;
    if(firstSaving.current){setIconError('A first save is still in progress. Finish or cancel it before importing an icon.');return;}
    const startedId=documentIds.current[latest.current.active];
    setIconBusy(true);setIconError('');setIconNotice('');
    try {
      const picked=await invoke<{name:string;text:string}|null>('import_icon_file');
      if(!picked)return;
      const currentName=Object.keys(latest.current.documents).find(candidate=>documentIds.current[candidate]===startedId);
      if(!currentName){setIconNotice('The document was closed while the icon picker was open; nothing was imported.');return;}
      const current=latest.current.documents[currentName];
      const icon=importSvgIcon({namespace:iconNamespace.trim()||'custom',name:iconName.trim()||iconNameFromFilename(picked.name),svg:picked.text,existing:current.assets});
      if(!await ensureMarkdownRoot(currentName)){setIconNotice('Attachment folder selection was cancelled; the icon was not imported.');return;}
      const updated={...current,assets:addAsset(current.assets,icon.reference,icon.body)};
      const candidate={...latest.current,documents:{...latest.current.documents,[currentName]:updated}};
      // The icon becomes an attachment only on the next save, so draft recovery is the
      // durable copy until then. Record it before exposing the import in the library.
      if(!writeDrafts(candidate)){setIconError('The icon could not be added because draft recovery is unavailable, so it would not reopen. Nothing was changed.');return;}
      applyDocument(currentName,updated);
      setIconName('');
      setIconNotice(`Imported ${icon.reference}. Reference it with @{ icon: "${icon.reference}" }.`);
    } catch(error) { setIconError(String(error)); }
    finally { setIconBusy(false); }
  }
  function removeIcon(reference:string){
    setIconError('');setIconNotice('');
    const name=latest.current.active;
    const current=latest.current.documents[name];
    if(!current)return;
    applyDocument(name,{...current,assets:removeAsset(current.assets,reference)});
    setIconNotice(`Removed ${reference}.`);
  }
  async function importCollection(){
    if(collectionBusy)return;
    setCollectionBusy(true);setCollectionError('');setCollectionMessage('');
    try {
      const picked=await invoke<{name:string;text:string}|null>('import_icon_collection_file');
      if(!picked)return;
      // Parse, collision-check and size-check before anything touches local storage.
      const result=importIconCollection(iconLibrary,picked.text,{namespace:collectionNamespace});
      const failure=storeIconLibrary(result.library);
      if(failure){setCollectionError(failure);return;}
      setIconLibrary(result.library);
      setCollectionNamespace('');
      const count=collectionIconCount(result.collection);
      setCollectionMessage(`Imported ${result.collection.prefix} with ${count} icon${count===1?'':'s'}. ${collectionNoticeText(result.collection)}`);
    } catch(error) { setCollectionError(String(error)); }
    finally { setCollectionBusy(false); }
  }
  function removeCollection(prefix:string){
    setCollectionError('');setCollectionMessage('');
    const next=removeIconCollection(iconLibrary,prefix);
    if(next===iconLibrary)return;
    const failure=storeIconLibrary(next);
    if(failure){setCollectionError(failure);return;}
    setIconLibrary(next);
    setCollectionMessage(`Removed ${prefix}. Documents keep the definitions they already carry.`);
    collectionButton.current?.focus();
  }
  /** Inserts a reference at the source caret, or after the existing source before it is touched. */
  function insertSourceSnippet(name:string,snippet:string){
    const live=latest.current.documents[name];
    if(!live)return false;
    const editor=sourceEditor.current;
    // The source editor keeps its last caret while Styling is visible. Until it has
    // been used, appending keeps the snippet after the existing diagram text.
    const caret=sourceTouched.current?carets.current[name].source:{start:live.source.length,end:live.source.length};
    const start=Math.min(caret.start,live.source.length);
    const end=Math.min(caret.end,live.source.length);
    const next=live.source.slice(0,start)+snippet+live.source.slice(end);
    edit('source',next);
    carets.current[name].source={start:start+snippet.length,end:start+snippet.length};
    if(editor)selection.current={editor,start:start+snippet.length,end:start+snippet.length};
    return true;
  }
  function insertLibraryIcon(reference:string){
    setIconError('');setIconNotice('');
    const name=latest.current.active;
    const current=latest.current.documents[name];
    if(!current)return;
    const id=documentIds.current[name];
    const insert=()=>{
      const liveName=Object.keys(latest.current.documents).find(candidate=>documentIds.current[candidate]===id);
      if(!liveName)return;
      const live=latest.current.documents[liveName];
      const assets=withIconReference(live.assets,iconLibrary,reference);
      const added=assets!==live.assets;
      if(added){
        // Only the used definition is copied into the document, and it is recorded in
        // draft recovery before the reference is exposed, so a reopen needs no pack.
        const candidate={...latest.current,documents:{...latest.current.documents,[liveName]:{...live,assets}}};
        if(!writeDrafts(candidate)) throw new Error('The icon could not be added because draft recovery is unavailable, so it would not reopen. Nothing was changed.');
        applyDocument(liveName,{...live,assets});
      }
      const snippet=`@{ icon: "${reference}" }`;
      insertSourceSnippet(liveName,snippet);
      setIconNotice(added?`Inserted ${snippet} and added ${reference} to this document.`
        :reference.startsWith(`${BUNDLED_ICON_PREFIX}:`)?`Inserted ${snippet}. The bundled collection needs no document copy.`
        :`Inserted ${snippet}. This document already carries ${reference}.`);
    };
    if(openedSessions.current[name]?.kind==='markdown'&&!openedSessions.current[name]!.rootReady){
      void ensureMarkdownRoot(name).then(ready=>{if(ready)insert();else setIconNotice('Attachment folder selection was cancelled; the icon was not added.');}).catch(error=>setIconError(String(error)));
      return;
    }
    try { insert(); } catch(error) { setIconError(String(error)); }
  }
  function pasteImage(event:ClipboardEvent<HTMLTextAreaElement>){
    const clipboard=event.clipboardData;
    const png=Array.from(clipboard.items??[]).find(item=>item.kind==='file'&&item.type==='image/png')?.getAsFile()
      ??Array.from(clipboard.files??[]).find(file=>file.type==='image/png');
    if(!png)return;
    event.preventDefault();
    const {selectionStart:start,selectionEnd:end}=event.currentTarget;
    void importImage(png,{start,end});
  }
  async function importImage(png?:File,pastedAt?:Caret){
    if(imagePending.current)return;
    const firstSaveMessage='A first save is still in progress. Finish or cancel it before importing an image.';
    if(firstSaving.current){setImageError(firstSaveMessage);return;}
    const startedName=latest.current.active;
    const startedId=documentIds.current[startedName];
    const startedSource=latest.current.documents[startedName]?.source;
    const requestedReference=png?undefined:imageReference;
    const findDocument=()=>Object.keys(latest.current.documents).find(name=>documentIds.current[name]===startedId);
    imagePending.current=true;
    setImageBusy(true);setImageError('');setImageNotice('');
    try {
      const picked=png?{name:'pasted-image.png',data:await readClipboardPng(png)}
        :await invoke<{name:string;data:string}|null>('import_image_file');
      if(!picked)return;
      const nameBeforePicker=findDocument();
      if(!nameBeforePicker)throw new Error('The document was closed before the image could be added.');
      if(png&&startedSource?.trim()&&detectType(startedSource)!=='flowchart')throw new Error('Paste an image into a Mermaid flowchart.');
      if(!await ensureMarkdownRoot(nameBeforePicker)){setImageNotice('Attachment folder selection was cancelled.');return;}
      const name=findDocument();
      if(!name)throw new Error('The document was closed before the image could be added.');
      if(firstSaving.current)throw new Error(firstSaveMessage);
      const current=latest.current.documents[name];
      if(pastedAt&&current.source!==startedSource)throw new Error('The source changed while reading the image. Paste again at the new cursor position.');
      let reference=requestedReference;
      if(png){
        const used=new Set(imageReferences(current.source));
        reference=picked.name;
        for(let number=2;Object.hasOwn(current.assets,reference)||used.has(reference);number++)reference=`pasted-image-${number}.png`;
      }
      const image=importLocalImage({reference,filename:picked.name,data:picked.data,existing:current.assets});
      const snippet=imageSnippet(image.reference,image.data);
      const isActive=name===latest.current.active;
      const canInsert=!current.source.trim()||detectType(current.source)==='flowchart';
      const caret=pastedAt??(sourceTouched.current?carets.current[name].source:{start:current.source.length,end:current.source.length});
      let source=current.source;
      let cursor=caret.end;
      // A file picked from another tab can still be added to its original asset list.
      if(canInsert&&(isActive||pastedAt)){
        let {start,end}=caret;
        const header=/^[\t ]*(?:flowchart|graph)\b[^\r\n]*/m.exec(source);
        if(header&&start<header.index+header[0].length){
          start=header.index+header[0].length;
          end=Math.max(end,start);
        }
        if(start===end&&source.slice(source.lastIndexOf('\n',start-1)+1,start).trim()){
          const lineEnd=source.indexOf('\n',end);
          start=end=lineEnd===-1?source.length:lineEnd-Number(source[lineEnd-1]==='\r');
        }
        const used=new Set(source.match(/\bimage\d+\b/g));
        let number=1;
        while(used.has(`image${number}`))number++;
        const before=source.slice(0,start);
        const after=source.slice(end);
        const newline=source.includes('\r\n')?'\r\n':'\n';
        const prefix=!source.trim()?'flowchart TD'+newline:before.slice(before.lastIndexOf('\n')+1).trim()?newline:'';
        const node=`${prefix}image${number}${snippet}`;
        source=before+node+(after&&!/^(?:\r?\n)/.test(after)?newline:'')+after;
        cursor=before.length+node.length;
      }
      const updated={...current,source,assets:addAsset(current.assets,image.reference,image.data)};
      if(!applyDocument(name,updated,true))throw new Error('The image could not be added because draft recovery is unavailable.');
      if(source!==current.source){
        const history=histories.current[name].source;
        history.undo.push({value:current.source,caret});
        history.redo=[];
        carets.current[name].source={start:cursor,end:cursor};
        if(isActive){
          sourceTouched.current=true;
          if(sourceEditor.current)selection.current={editor:sourceEditor.current,start:cursor,end:cursor};
        }
      }
      if(!png)setImageReference('');
      setImageNotice(png?`Pasted ${image.reference}. Find it in Styling → Local images.`
        :source!==current.source?`Imported ${image.reference} and inserted ${snippet}.`:`Imported ${image.reference} into ${name}.`);
    } catch(error) { setImageError(String(error)); }
    finally { imagePending.current=false;setImageBusy(false); }
  }
  function removeImage(reference:string){
    setImageError('');setImageNotice('');
    const name=latest.current.active;
    const current=latest.current.documents[name];
    if(!current)return;
    applyDocument(name,{...current,assets:removeAsset(current.assets,reference)});
    setImageNotice(`Removed ${reference}. References to it in the diagram source were kept as text.`);
  }
  /** Pins the dialog to the active document's identity and the cog that owns the focus return. */
  function openImageStyle(reference:string){
    const name=latest.current.active;
    const current=latest.current.documents[name];
    const id=documentIds.current[name];
    if(!current||!id||!Object.hasOwn(current.assets,reference))return;
    setImageError('');setImageNotice('');
    setImageStyleFailure('');
    imageStyleFocus.current=imageCogs.current[reference]??null;
    setImageStyleTarget({documentId:id,reference,data:current.assets[reference]});
  }
  function closeImageStyle(){
    setImageStyleTarget(undefined);
    setImageStyleFailure('');
  }
  /**
   * Applies the draft to the latest stylesheet of the same document and image. Every guard
   * re-reads the live workspace: a tab switch, reload, close, same-name replacement or a
   * removed image refuses the write and says why instead of touching another document.
   */
  function applyImageStyleDraft(style:ImageStyle){
    const target=imageStyleTarget;
    if(!target)return;
    const name=Object.keys(latest.current.documents).find(candidate=>documentIds.current[candidate]===target.documentId);
    if(!name){setImageStyleFailure('The document was closed while this dialog was open, so the style was not applied. Nothing was changed.');return;}
    if(name!==latest.current.active){setImageStyleFailure(`The active document changed to ${latest.current.active||'none'} while this dialog was open, so the style of ${target.reference} was not applied. Close this dialog and style the image in the current document.`);return;}
    const current=latest.current.documents[name];
    const data=Object.hasOwn(current.assets,target.reference)?current.assets[target.reference]:undefined;
    if(data===undefined||assetKind(data)!=='image'){setImageStyleFailure(`The image ${target.reference} is no longer stored in this document, so its style was not applied. Nothing was changed.`);return;}
    if(data!==target.data){setImageStyleFailure(`The image ${target.reference} changed while this dialog was open. Reopen image styling to edit the current image.`);return;}
    const problem=imageDataProblem(target.reference,data);
    if(problem){setImageStyleFailure(problem);return;}
    const result=applyImageStyle(current.css,target.reference,style);
    if('problem' in result){setImageStyleFailure(result.problem);return;}
    // A no-op Apply (including Reset with nothing stored) closes the dialog without
    // adding an undo entry or marking the draft dirty.
    if(result.changed)edit('css',result.css);
    closeImageStyle();
  }
  async function copyIconReference(reference:string){
    setIconError('');setIconNotice('');
    const snippet=`@{ icon: "${reference}" }`;
    try {
      await copyText(snippet);
      setIconNotice(`Copied ${snippet}. Insert it to add any definition this document still needs.`);
    } catch(error) { setIconError(String(error)); }
  }
  function tabStatus(name:string){
    const session=openedSessions.current[name];
    if(!session)return draftStatus==='Draft recovery failed'?'Recovery failed':draftStatus==='Draft recovery pending'?'Recovery pending':'Draft';
    if(session.external)return conflictLabel(session.external);
    return saveLabel(session);
  }
  function localVersion(document:DraftDocument|undefined,disk:DiskSnapshot|undefined,member:'source'|'css'|'assets'):{value:string|null;error?:string}{
    if(!document||!disk)return {value:null};
    try {
      if(disk.kind==='markdown')return {value:markdownFor(document)};
      if(!document.pair)throw new Error('The paired file association is missing; reopen the files before comparing.');
      const snapshot=pairedSnapshot(document,document.pair);
      return {value:member==='source'?snapshot.source:member==='css'?snapshot.css:snapshot.assets};
    } catch(error) { return {value:null,error:String(error)}; }
  }
  function diskVersion(disk:DiskSnapshot|undefined,member:'source'|'css'|'assets'):string|null{
    if(!disk)return null;
    if(disk.kind==='markdown')return disk.text;
    return member==='source'?disk.source:member==='css'?disk.css:disk.assets;
  }
  function retainedVersion(disk:DiskSnapshot|undefined,member:'source'|'css'|'assets'):RetainedVersion|undefined{
    if(!disk)return undefined;
    if(disk.kind==='markdown')return disk.retained[0];
    const label=member==='source'?'source':member==='css'?'stylesheet':'asset index';
    return disk.retained.find(version=>version.member===label);
  }
  function saveCopyFromConflict(){
    const name=conflictTarget;
    if(!name||!latest.current.documents[name])return;
    setConflictTarget(undefined);
    // Save a Copy writes only the local draft to a new destination and leaves the file on
    // disk untouched, so it is offered while the conflict is still unresolved.
    if(name!==latest.current.active){latest.current={...latest.current,active:name};setActive(name);}
    openSaveDialog('copy');
  }
  const conflictSession=conflictTarget?openedSessions.current[conflictTarget]:undefined;
  const conflictDisk=conflictSession?.external;
  const conflictDocument=conflictTarget?documents[conflictTarget]:undefined;
  const conflictLocal=localVersion(conflictDocument,conflictDisk,conflictMember);
  const conflictPreserved=retainedVersion(conflictDisk,conflictMember);
  const conflictDiskValue=diskVersion(conflictDisk,conflictMember);
  const conflictReloadable=Boolean(conflictDisk)&&!externalMissing(conflictDisk!)&&!conflictBusy&&conflictSession?.queue.state!=='saving'
    &&(conflictDisk?.kind==='markdown'?conflictDisk.text!==null:conflictDisk?.source!==null);
  const importedIcons=doc?documentIcons(doc.assets):[];
  const importedImages=doc?documentImages(doc.assets):[];
  // The dialog reads the pinned document, not whatever tab is active now, so its preview and
  // values stay stable while Apply can still refuse a changed active document.
  const imageStyleDocument=imageStyleTarget?documents[Object.keys(documents).find(name=>documentIds.current[name]===imageStyleTarget.documentId)??'']:undefined;
  const iconResults=useMemo(()=>view==='Styling'?searchIcons(iconLibrary,iconQuery,24):[],[iconLibrary,iconQuery,view]);
  const iconPreviews=useMemo(()=>iconResults.map(result=>{
    try { return resolveIconReference(iconLibrary,result.reference); }
    catch { return undefined; }
  }),[iconLibrary,iconResults]);
  const nativeApp='__TAURI_INTERNALS__' in window;
  const dragRegion=nativeApp&&navigator.userAgent.includes('Macintosh')?'deep':undefined;
  const statusTone=(label:string):'ok'|'pending'|'problem'|'neutral'=>
    label==='Saved'?'ok'
    :label==='Pending save'||label==='Saving…'||label==='Recovery pending'?'pending'
    :label==='Draft'?'neutral'
    :'problem';
  const tabKeyDown=(event:React.KeyboardEvent<HTMLDivElement>)=>{
    if((event.target as HTMLElement).getAttribute('role')!=='tab')return;
    const names=Object.keys(latest.current.documents);
    if(names.length<2)return;
    const index=names.indexOf(latest.current.active);
    const next=event.key==='ArrowRight'?(index+1)%names.length
      :event.key==='ArrowLeft'?(index-1+names.length)%names.length
      :event.key==='Home'?0
      :event.key==='End'?names.length-1
      :-1;
    if(next<0)return;
    event.preventDefault();
    const name=names[next];
    setActive(name);
    setTimeout(()=>document.getElementById(`tab-${documentIds.current[name]}`)?.focus(),0);
  };
  return <Theme appearance={themeAppearance} accentColor={theme.accentColor} grayColor={theme.grayColor} radius="small" scaling="100%" panelBackground="solid">
    <main className="workspace" data-appearance={themeAppearance} style={{'--editor-width':`${split}%`} as React.CSSProperties}>
      <header className="app-header" data-tauri-drag-region={dragRegion}>
        <Text size="4" weight="bold" className="app-name"><Crown className="app-name-crown" size={14} strokeWidth={2.5} aria-hidden="true"/>orei</Text>
        <div className="toolbar" role="group" aria-label="Document commands">
          <div className="toolbar-group" role="group" aria-label="New and save document">
            <Button size="1" color="gray" variant="ghost" aria-label="New document" title="New document" onClick={()=>newDocument()}><FilePlus2 size={15}/>New</Button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger><Button size="1" color="gray" variant="ghost" aria-label="Templates" title="Templates"><LayoutTemplate size={14}/><span className="templates-label">Templates</span></Button></DropdownMenu.Trigger>
              <DropdownMenu.Content size="1" align="start" sideOffset={6}>
                {diagramTemplates.map(template=><DropdownMenu.Item key={template.name} onSelect={()=>newDocument(template.source)}>{template.name}</DropdownMenu.Item>)}
              </DropdownMenu.Content>
            </DropdownMenu.Root>
            <Button size="1" color="gray" variant="ghost" disabled={!nativeApp} title={nativeApp?'Open a Markdown or Mermaid document':'Available in the desktop app'} onClick={()=>void openDocument()}><FolderOpen size={15}/>Open</Button>
            <Button size="1" color="gray" variant="solid" disabled={!nativeApp||!doc} title={nativeApp?'Save the active document':'Available in the desktop app'} onClick={()=>void saveDocument()}><Save size={15}/>Save</Button>
          </div>
          <Button size="1" className="toolbar-export" ref={exportButton} variant="soft" disabled={!canExport} title={error?'A current valid render is required':'Export current diagram'} onClick={()=>setExportOpen(true)}><Download size={15}/>Export</Button>
          {openedSessions.current[active]?.external&&<Button size="1" color="red" variant="soft" aria-haspopup="dialog" onClick={()=>openConflict(active)}>Review external change</Button>}
          <Button className="evidence-only" variant="ghost" size="1" aria-pressed={multiple} onClick={()=>void toggleMultiple()}>Multiple documents</Button>
        </div>
      </header>
      {doc?<>
      <nav className="tab-strip" aria-label="Document tabs">
        <div className="tab-scroll" role="tablist" aria-label="Document tabs" aria-orientation="horizontal" onKeyDown={tabKeyDown}>
          {Object.keys(documents).map(name=>{
            const status=tabStatus(name);
            const tabId=`tab-${documentIds.current[name]}`;
            const statusId=`${tabId}-status`;
            // The dot carries the quiet state; the text stays available to assistive
            // technology and becomes visible only for the active tab or one needing attention.
            const tone=statusTone(status);
            const showStatus=active===name||tone==='pending'||tone==='problem';
            return <div key={name} className={active===name?'tab is-active':'tab'} role="presentation">
              <Button id={tabId} className="tab-select" size="1" variant="ghost" role="tab" aria-selected={active===name} aria-controls="document-panel" aria-describedby={statusId} tabIndex={active===name?0:-1} onClick={()=>{paletteGesture.current={active:false,changed:false};setActive(name);}}>{name}</Button>
              <span className={`status-dot status-${tone}`} aria-hidden="true"/>
              <Text as="span" id={statusId} size="1" color="gray" className={showStatus?'tab-status':'tab-status visually-hidden'}>{status}</Text>
              <Tooltip content={`Close ${name}`}><IconButton className="tab-close" variant="ghost" size="1" aria-label={`Close ${name}`} onClick={()=>{setCloseFailure(false);setCloseTarget(name);}}><X size={14}/></IconButton></Tooltip>
            </div>;
          })}
        </div>
      </nav>
      <section className="panes" id="document-panel" role="tabpanel" aria-labelledby={`tab-${documentIds.current[active]}`}>
        <section className="editor" aria-label="Editing pane" onKeyDown={editorKeyDown} onBeforeInput={rememberCaret} onSelect={rememberCaret}>
          <Flex className="pane-toolbar" align="start" justify="between" gap="2">
            <SegmentedControl.Root size="1" value={view} onValueChange={v=>{paletteGesture.current={active:false,changed:false};setView(v);}} aria-label="Editor view">{['Diagram','Styling'].map(v=><SegmentedControl.Item key={v} value={v}>{v}</SegmentedControl.Item>)}</SegmentedControl.Root>
            <Flex gap="1" align="center" className="pane-actions">
              <Tooltip content="Copy Mermaid source (works while the preview is invalid)"><IconButton size="1" variant="ghost" aria-label="Copy source" onMouseDown={e=>e.preventDefault()} onClick={()=>void copySourceText()}><Copy size={16}/></IconButton></Tooltip>
              <Tooltip content="Undo (Command Z)"><IconButton size="1" variant="ghost" aria-label="Undo" onMouseDown={e=>e.preventDefault()} disabled={!history?.undo.length} onClick={()=>travel('undo')}><Undo2 size={16}/></IconButton></Tooltip>
              <Tooltip content="Redo (Command Shift Z)"><IconButton size="1" variant="ghost" aria-label="Redo" onMouseDown={e=>e.preventDefault()} disabled={!history?.redo.length} onClick={()=>travel('redo')}><Redo2 size={16}/></IconButton></Tooltip>
            </Flex>
          </Flex>
          {findOpen&&<div className="find-bar" role="search" aria-label="Find in document">
            <TextField.Root ref={findInput} aria-label="Find in editor" size="1" placeholder="Find" value={findText} onChange={e=>setFindText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();findNext();}if(e.key==='Escape'){e.stopPropagation();setFindOpen(false);(part==='source'?sourceEditor:cssEditor).current?.focus();}}}/>
            <Button size="1" variant="soft" onClick={findNext}>Find next</Button>
            <Button size="1" variant="ghost" onClick={()=>{setFindOpen(false);(part==='source'?sourceEditor:cssEditor).current?.focus();}}>Close find</Button>
          </div>}
          <div className="editor-content editor-source" hidden={view!=='Diagram'}>
            <CodeEditor ref={sourceEditor} label="Diagram source" language="mermaid" value={doc.source} onChange={(value,caret)=>changeEditorText('source',value,caret)} onPaste={pasteImage}/>
            {view==='Diagram'&&imageError&&<Callout.Root color="red" role="alert"><Callout.Text>{imageError}</Callout.Text></Callout.Root>}
            {view==='Diagram'&&imageNotice&&<Text as="p" size="1" role="status">{imageNotice}</Text>}
          </div>
          <div className="editor-content styling" hidden={view!=='Styling'}>
            <StylingDisclosure title="Palette" initiallyOpen>
              <div className="field">
                <Text size="1" weight="medium" id="color-scheme-label">Color scheme</Text>
                <Select.Root size="2" value={activeScheme} onValueChange={name=>{
                  const scheme=Object.values(diagramSchemes).find(option=>option.name===name);
                  if(scheme)applyScheme(scheme.colors);
                }}>
                  <Select.Trigger aria-labelledby="color-scheme-label" placeholder="Custom" className="scheme-trigger"/>
                  <Select.Content position="popper" align="start" sideOffset={6} collisionPadding={12} variant="soft" className="scheme-menu">
                    {Object.values(diagramSchemes).map(scheme=>(
                      <Select.Item key={scheme.name} value={scheme.name}>
                        <span className="scheme-option">
                          {scheme.name}
                          <span className="scheme-swatches" aria-hidden="true">
                            {[scheme.colors['--pele-bg'],scheme.colors['--pele-surface'],scheme.colors['--pele-accent']].map(color=><span key={color} style={{backgroundColor:color}}/>)}
                          </span>
                        </span>
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              </div>
              {schemeError&&<Callout.Root color="amber" role="alert"><Callout.Text>Resolve incomplete or ambiguous rules in the stylesheet before applying a color scheme.</Callout.Text></Callout.Root>}
              {paletteAvailable&&<div className="palette-list">{paletteFields.map(([name,label])=>{const value=colors[name]??'';return <div className="palette-row" key={name}>
                <Text as="label" size="1" weight="medium" className="palette-name" htmlFor={`palette-${name}`} title={name}>{label}</Text>
                <input className="palette-swatch" aria-label={`${name} swatch`} type="color" value={/^#[0-9a-f]{6}$/i.test(value)?value:'#000000'} onPointerDown={()=>{paletteGesture.current={active:true,changed:false};}} onPointerUp={()=>{paletteGesture.current={active:false,changed:false};}} onPointerCancel={()=>{paletteGesture.current={active:false,changed:false};}} onLostPointerCapture={()=>{paletteGesture.current={active:false,changed:false};}} onBlur={()=>{paletteGesture.current={active:false,changed:false};}} onChange={e=>palette(name,e.target.value)}/>
                <TextField.Root id={`palette-${name}`} className="palette-value" aria-label={`${name} value`} size="2" value={value} onChange={e=>palette(name,e.target.value)}/>
              </div>;})}</div>}
              {!paletteAvailable&&<Callout.Root color="amber"><Callout.Text>Palette paused. Choose a color scheme to start a palette, or resolve duplicate or incomplete stylesheet rules.</Callout.Text></Callout.Root>}
            </StylingDisclosure>
            <section className="styling-section styling-section-content stylesheet-section" aria-labelledby="stylesheet-heading">
              <Heading as="h3" size="2" weight="bold" id="stylesheet-heading">Stylesheet</Heading>
              <CodeEditor ref={cssEditor} label="Diagram stylesheet" language="css" value={doc.css} onChange={(value,caret)=>changeEditorText('css',value,caret)}/>
              <Text as="p" size="1" color="gray">Global --pele-font is measured; per-element typography may not relayout. Remote resources are blocked.</Text>
            </section>
            <StylingDisclosure title="Icons">
              <div className="styling-group">
                <Heading as="h4" size="2" weight="medium">Import an SVG</Heading>
                <Text id="icon-help" size="1" color="gray">SVGs are stored as namespace:name and saved with Markdown notes or paired Mermaid files.</Text>
                <div className="control-row">
                  <div className="field-pair">
                    <div className="field"><Text as="label" size="1" weight="medium" htmlFor="icon-namespace">Namespace</Text><TextField.Root id="icon-namespace" aria-label="Icon namespace" aria-describedby="icon-help" value={iconNamespace} onChange={e=>setIconNamespace(e.target.value)} disabled={iconBusy}/></div>
                    <div className="field"><Text as="label" size="1" weight="medium" htmlFor="icon-name">Name</Text><TextField.Root id="icon-name" aria-label="Icon name" aria-describedby="icon-help" placeholder="From filename" value={iconName} onChange={e=>setIconName(e.target.value)} disabled={iconBusy}/></div>
                  </div>
                  <Button variant="soft" disabled={iconBusy||!nativeApp} title={nativeApp?'Choose an SVG file to import':'Available in the desktop app'} aria-describedby="icon-help" onClick={()=>void importIcon()}>Import SVG…</Button>
                </div>
                {iconError&&<Callout.Root color="red" role="alert"><Callout.Text>{iconError}</Callout.Text></Callout.Root>}
                {iconNotice&&<Text as="p" size="1" role="status">{iconNotice}</Text>}
                {importedIcons.length>0&&<div className="icon-library" aria-label="Imported icons">{importedIcons.map(([reference])=><div className="icon-row" key={reference}><div className="asset-info"><code>{reference}</code><Text size="1" color="gray">{`@{ icon: "${reference}" }`}</Text></div><Button variant="ghost" size="1" aria-label={`Remove icon ${reference}`} onClick={()=>removeIcon(reference)}>Remove</Button></div>)}</div>}
              </div>
              <div className="styling-group">
                <Heading as="h4" size="2" weight="medium">Iconify packs</Heading>
                <Text id="collection-help" size="1" color="gray">JSON packs stay in the local library. Leave the namespace blank to use the pack’s prefix.</Text>
                <div className="control-row">
                  <div className="field"><Text as="label" size="1" weight="medium" htmlFor="collection-namespace">Namespace</Text><TextField.Root id="collection-namespace" aria-label="Icon collection namespace" aria-describedby="collection-help" placeholder="From collection" value={collectionNamespace} onChange={e=>setCollectionNamespace(e.target.value)} disabled={collectionBusy}/></div>
                  <Button ref={collectionButton} variant="soft" disabled={collectionBusy||!nativeApp} title={nativeApp?'Choose an Iconify JSON collection to import':'Available in the desktop app'} aria-describedby="collection-help" onClick={()=>void importCollection()}>Import Iconify pack…</Button>
                </div>
                {collectionError&&<Callout.Root color="red" role="alert"><Callout.Text>{collectionError}</Callout.Text></Callout.Root>}
                {collectionMessage&&<Text as="p" size="1" role="status">{collectionMessage}</Text>}
                {libraryProblems.length>0&&<Callout.Root color="amber"><Callout.Text>{libraryProblems.join(' ')}</Callout.Text></Callout.Root>}
                {iconLibrary.collections.length>0&&<div className="icon-library" aria-label="Imported icon collections">{iconLibrary.collections.map(collection=><div className="icon-row" key={collection.prefix}><div className="asset-info"><code>{collection.prefix}</code><Text size="1" color="gray">{` ${collectionIconCount(collection)} icons`}</Text><Text as="p" size="1" color="gray">{collectionNoticeText(collection)}</Text>{collection.unsupported.length>0&&<Text as="p" size="1" color="gray">{collection.unsupported.join(' ')}</Text>}</div><Button variant="ghost" size="1" aria-label={`Remove icon collection ${collection.prefix}`} disabled={collectionBusy} onClick={()=>removeCollection(collection.prefix)}>Remove</Button></div>)}</div>}
              </div>
              <div className="styling-group">
                <Heading as="h4" size="2" weight="medium">Find icons</Heading>
                <Text id="icon-search-help" size="1" color="gray">Search Lucide and imported packs. Insert adds the icon to the draft at the last caret. Copy copies the reference.</Text>
                <TextField.Root id="icon-search" aria-label="Search icons" aria-describedby="icon-search-help" placeholder="Name or namespace:name" value={iconQuery} onChange={e=>setIconQuery(e.target.value)}/>
                <Text size="1" color="gray" role="status">{`${iconLibrary.collections.length} imported collect${iconLibrary.collections.length===1?'ion':'ions'} · showing ${iconResults.length}`}</Text>
                {iconResults.length>0?<div className="icon-library" aria-label="Icon search results">{iconResults.map((result,index)=><div className="icon-row" key={result.reference}>{iconPreviews[index]?<span className="icon-preview" aria-hidden="true" dangerouslySetInnerHTML={{__html:iconPreviews[index]!}}/>:<Text size="1" color="red">Unsupported</Text>}<code>{result.reference}</code><Button variant="soft" size="1" aria-label={`Insert ${result.reference}`} onClick={()=>insertLibraryIcon(result.reference)}>Insert</Button><Button variant="ghost" size="1" aria-label={`Copy reference for ${result.reference}`} onClick={()=>void copyIconReference(result.reference)}>Copy</Button></div>)}</div>:<Text as="p" size="1" role="status">No icons match {JSON.stringify(iconQuery)}.</Text>}
              </div>
            </StylingDisclosure>
            <StylingDisclosure title="Local images">
              <Text id="image-help" size="1" color="gray">Import a PNG or paste one into Diagram source. Edit w and h in the source to resize it.</Text>
              <div className="control-row">
                <div className="field"><Text as="label" size="1" weight="medium" htmlFor="image-reference">Reference</Text><TextField.Root id="image-reference" aria-label="Image reference" aria-describedby="image-help" placeholder="assets/photo.png" value={imageReference} onChange={e=>setImageReference(e.target.value)} disabled={imageBusy}/></div>
                <Button variant="soft" disabled={imageBusy||!nativeApp} title={nativeApp?'Choose a PNG image to import':'Available in the desktop app'} aria-describedby="image-help" onClick={()=>void importImage()}>Import PNG…</Button>
              </div>
              {imageError&&<Callout.Root color="red" role="alert"><Callout.Text>{imageError}</Callout.Text></Callout.Root>}
              {imageNotice&&<Text as="p" size="1" role="status">{imageNotice}</Text>}
              {imageStyleMessage&&<Callout.Root color="amber" role="alert"><Callout.Text>{imageStyleMessage}</Callout.Text></Callout.Root>}
              {importedImages.length>0&&<div className="icon-library" aria-label="Local images">{importedImages.map(([reference,data])=><div className="icon-row image-row" key={reference}>
                <img className="asset-thumbnail" src={data} alt={`Thumbnail of ${reference}`}/>
                <div className="asset-info"><code>{reference}</code><Text size="1" color="gray">{imageSnippet(reference,data)}</Text></div>
                <Tooltip content="Style this image"><IconButton ref={node=>{imageCogs.current[reference]=node;}} size="1" variant="ghost" aria-label={imageStyleControlLabel(reference)} aria-haspopup="dialog" onClick={()=>openImageStyle(reference)}><Cog size={16}/></IconButton></Tooltip>
                <Button variant="ghost" size="1" aria-label={`Remove image ${reference}`} onClick={()=>removeImage(reference)}>Remove</Button>
              </div>)}</div>}
            </StylingDisclosure>
          </div>
          <div className="editor-diagnostic" data-visible={showDiagnostic||undefined} data-details-open={diagnosticDetailsOpen||undefined}>
            <div className="editor-diagnostic-status" aria-live="polite" aria-atomic="true" role={showDiagnostic?'status':undefined}>
              {showDiagnostic&&<>
                <CircleExclamationPoint size={14} aria-hidden="true"/>
                <div>
                  <Text as="div" size="1" weight="medium">Preview out of date</Text>
                  {snapshot&&<Text as="div" size="1" color="gray">Showing last valid diagram</Text>}
                </div>
              </>}
            </div>
            {showDiagnostic&&<>
              {errorLine>0&&<Button size="1" variant="soft" color="gray" className="editor-diagnostic-action" onClick={()=>goToSourceLine(errorLine)}>Go to line {errorLine}</Button>}
              <Button size="1" variant="ghost" color="gray" className="editor-diagnostic-toggle" aria-expanded={diagnosticDetailsOpen} aria-controls="editor-diagnostic-details" onClick={()=>setDiagnosticDetailsOpen(open=>!open)}>
                {diagnosticDetailsOpen?'Hide details':'Details'}
              </Button>
              <pre id="editor-diagnostic-details" className="editor-diagnostic-detail" hidden={!diagnosticDetailsOpen} tabIndex={0} aria-label="Preview error details">{error}</pre>
            </>}
          </div>
        </section>
        <div className="divider" role="separator" tabIndex={0} aria-orientation="vertical" aria-valuemin={25} aria-valuemax={65} aria-valuenow={split} aria-label="Editor pane width" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={()=>{drag.current=undefined;}} onKeyDown={resizeKey} onDoubleClick={event=>resizeSplit(50,event.currentTarget)}/>
        <section className="preview-pane" ref={panel} aria-label="Preview pane" data-stale={showDiagnostic&&snapshot?true:undefined}>
          <Tabs.Root className="preview-tabs" value={previewTab} onValueChange={tab=>{
            setPreviewTab(tab);
            if(tab==='docs')setDocsOpened(true);
          }}>
            <div className="pane-toolbar preview-toolbar" ref={previewToolbar}>
              <Flex align="center" gap="2">
                <Tabs.List size="1" aria-label="Preview pane view">
                  <Tabs.Trigger value="preview">Preview</Tabs.Trigger>
                  <Tabs.Trigger value="docs">Docs</Tabs.Trigger>
                </Tabs.List>
                {!showDocs&&<SegmentedControl.Root size="1" value={mode} onValueChange={v=>setMode(v as 'fixed'|'responsive')} aria-label="Preview layout">
                  <SegmentedControl.Item value="fixed">Fixed</SegmentedControl.Item>
                  <SegmentedControl.Item value="responsive">Responsive</SegmentedControl.Item>
                </SegmentedControl.Root>}
              </Flex>
              {showDocs?<DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  <Button size="1" variant="ghost">Doc sections<DropdownMenu.TriggerIcon/></Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content size="1" align="end">
                  {peleDocsSections.map(([label,path])=><DropdownMenu.Item key={path} onSelect={()=>{
                    if(docsFrame.current)docsFrame.current.src=peleDocsUrl+path;
                  }}>{label}</DropdownMenu.Item>)}
                </DropdownMenu.Content>
              </DropdownMenu.Root>:<Flex align="center" gap="2" className="preview-controls">
                <Select.Root size="1" value={canvasChoice} onValueChange={value=>setCanvasChoice(value as CanvasChoice)}>
                  <Select.Trigger aria-label="Canvas appearance" title="Canvas appearance" variant="ghost"><CanvasIcon size={14}/></Select.Trigger>
                  <Select.Content position="popper" align="end" sideOffset={6} collisionPadding={8}>
                    {Object.entries(canvasOptions).map(([value,{label,Icon}])=>(
                      <Select.Item key={value} value={value}>
                        <Flex as="span" align="center" gap="2"><Icon size={14}/>{label}</Flex>
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
                <Flex align="center" gap="1" className="zoom-controls" role="group" aria-label="Preview zoom controls">
                  <Tooltip content="Zoom out"><IconButton size="1" variant="ghost" aria-label="Zoom out" disabled={zoom<=minZoom} onClick={()=>stepZoom(-10)}><Minus size={14}/></IconButton></Tooltip>
                  <TextField.Root id="preview-zoom" className="zoom-input" aria-label="Preview zoom" type="number" min={minZoom} max={maxZoom} step="5" size="1" value={zoomDraft} onChange={e=>setZoomDraft(e.target.value)} onBlur={commitZoom} onKeyDown={zoomKeyDown}>
                    <TextField.Slot side="right" aria-hidden="true">%</TextField.Slot>
                  </TextField.Root>
                  <Tooltip content="Zoom in"><IconButton size="1" variant="ghost" aria-label="Zoom in" disabled={zoom>=maxZoom} onClick={()=>stepZoom(10)}><Plus size={14}/></IconButton></Tooltip>
                  {mode==='responsive'&&<Tooltip content="Fit preview to pane width"><IconButton size="1" variant={tabView.fitted?'soft':'ghost'} aria-label="Fit preview to pane width" aria-pressed={tabView.fitted} onClick={()=>updateView(snapshot?{fitted:true,zoom:Math.min(100,Math.round(width/snapshot.width*100))}:{fitted:true})}><Maximize2 size={14}/></IconButton></Tooltip>}
                </Flex>
              </Flex>}
            </div>
            <div className="preview-panels">
              <Tabs.Content className="preview-tab-panel" value="preview" forceMount inert={showDocs} aria-hidden={showDocs}>
                <div className="preview-scroll" data-canvas-appearance={canvasChoice} ref={previewScroll} role="region" aria-label="Preview canvas" tabIndex={0}
                  onDoubleClick={jumpFromPreview}
                  onPointerDown={startPan}
                  onPointerMove={movePan}
                  onPointerUp={stopPan}
                  onPointerLeave={e=>{if(pan.current?.pointer===e.pointerId&&!pan.current?.captured)pan.current=undefined;}}
                  onPointerCancel={e=>{if(pan.current?.pointer===e.pointerId)pan.current=undefined;}}
                  onLostPointerCapture={e=>{if(e.target===e.currentTarget&&pan.current?.pointer===e.pointerId)pan.current=undefined;}}>
                  <div className="preview-stage" style={{width:(snapshot?.width??0)*zoom/100,height:(snapshot?.height??0)*zoom/100}}>
                    <div data-testid="preview" ref={preview} style={{width:snapshot?.width,transform:`scale(${zoom/100})`,transformOrigin:'top left'}}/>
                  </div>
                  {multiple&&held.map((s,i)=><img className="held-document" key={i} alt={`Held document ${i+1}`} src={'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(s.svg)}/>)}
                </div>
              </Tabs.Content>
              <Tabs.Content className="preview-tab-panel" value="docs" forceMount inert={!showDocs} aria-hidden={!showDocs}>
                {docsOpened&&<iframe className="pele-docs-frame" ref={docsFrame} title="Pele documentation" src={peleDocsUrl} sandbox="" referrerPolicy="no-referrer"/>}
              </Tabs.Content>
            </div>
          </Tabs.Root>
        </section>
      </section>
      </>:<section className="empty-workspace" aria-labelledby="empty-workspace-heading">
        <Flex direction="column" align="center" gap="3">
          <Heading as="h1" size="4" id="empty-workspace-heading">No documents open</Heading>
          <Flex gap="2">
            <Button ref={emptyNewButton} onClick={()=>newDocument()}><FilePlus2 size={16}/>New diagram</Button>
            <Button variant="soft" color="gray" disabled={!nativeApp} onClick={()=>void openDocument()}><FolderOpen size={16}/>Open file</Button>
          </Flex>
        </Flex>
      </section>}
      {(doc||copyStatus||draftStatus==='Draft recovery failed')&&<footer className="status-bar">
        {((doc&&draftStatus!=='Drafts saved locally')||draftStatus==='Draft recovery failed')&&<Text size="1" color="gray">{draftStatus}</Text>}
        {doc?.pair&&<Text size="1" color="gray" className="status-detail">{`Paired ${doc.pair.base}.mmd with ${doc.pair.cssCompanion?'stylesheet companion':'in-memory stylesheet'}.`}</Text>}
        {assetNotice?.name===active&&<Text size="1" color="amber" className="status-detail">{assetNotice.message}</Text>}
        {openedSessions.current[active]?.queue.state==='failed'&&<Text size="1" color="red">Last save: {String(openedSessions.current[active]!.queue.error)}</Text>}
        {copyStatus&&<Text size="1" color="gray">{copyStatus}</Text>}
        {initial.blocked&&<Text size="1" color="amber" className="status-detail">Existing recovery data could not be read and has been preserved. Save an asset-free copy of current work before closing.</Text>}
        {doc&&<Flex className="preview-status" align="center" gap="2">
          <span className={`status-dot status-${showDiagnostic?'neutral':pending||error?'pending':'ok'}`} aria-hidden="true"/>
          <Text size="1" color="gray" role={showDiagnostic?undefined:'status'} className="render-status">{showDiagnostic?'Preview paused':pending||error?'Preparing preview…':'Current preview'}</Text>
        </Flex>}
      </footer>}
      <Dialog.Root open={!!saveError} onOpenChange={open=>{if(!open)setSaveError('');}}><Dialog.Content maxWidth="440px"><Dialog.Title>Could not save document</Dialog.Title><Dialog.Description>{saveError} Your draft remains open.</Dialog.Description><Flex justify="end" mt="4"><Dialog.Close><Button>OK</Button></Dialog.Close></Flex></Dialog.Content></Dialog.Root>
      <Dialog.Root open={!!copyError} onOpenChange={open=>{if(!open)setCopyError('');}}><Dialog.Content maxWidth="440px"><Dialog.Title>Could not copy diagram</Dialog.Title><Dialog.Description>{copyError} The clipboard may have been cleared.</Dialog.Description><Flex justify="end" mt="4"><Dialog.Close><Button>OK</Button></Dialog.Close></Flex></Dialog.Content></Dialog.Root>
      <Dialog.Root open={!!openError} onOpenChange={open=>{if(!open)setOpenError('');}}><Dialog.Content maxWidth="440px"><Dialog.Title>Could not open document</Dialog.Title><Dialog.Description>{openError}</Dialog.Description><Flex justify="end" mt="4"><Dialog.Close><Button>OK</Button></Dialog.Close></Flex></Dialog.Content></Dialog.Root>
      <Dialog.Root open={!!closeTarget} onOpenChange={open=>{if(!open){setCloseTarget(undefined);setCloseFailure(false);}}}><Dialog.Content maxWidth="440px" onCloseAutoFocus={event=>{
        if(emptyNewButton.current){event.preventDefault();emptyNewButton.current.focus();}
      }}><Dialog.Title>Close {closeTarget}?</Dialog.Title><Dialog.Description>{closeTarget&&openedSessions.current[closeTarget]?.external?'This document changed on disk and its local version is still unresolved. Closing discards the local version in orei. Any version replaced by orei\'s last save is put back on disk; otherwise the file is left as it is, including any change made outside orei.':closeFailure?'The file save or draft recovery could not be completed. Keep the document open to save a copy, or retry closing. Closing without saving discards the latest edits of this document.':'Pending changes to an opened file will be saved first. Untitled draft content will be discarded.'}</Dialog.Description><Flex gap="3" justify="end" mt="4"><Dialog.Close><Button variant="soft">Keep open</Button></Dialog.Close>{closeFailure&&<Button color="red" variant="soft" onClick={forceCloseDocument}>Close without saving</Button>}<Button color="red" onClick={closeDocument}>{closeTarget&&openedSessions.current[closeTarget]?.external?'Discard local version':closeFailure?'Retry discard':'Discard draft'}</Button></Flex></Dialog.Content></Dialog.Root>
      <Dialog.Root open={windowFailure} onOpenChange={open=>{setWindowFailure(open);if(!open){setCloseRequested(false);setExitFailure(false);void invoke('cancel_close').catch(()=>{});}}}><Dialog.Content maxWidth="440px"><Dialog.Title>Window close needs attention</Dialog.Title><Dialog.Description>{exitFailure?'The close request failed. Keep the window open and retry closing.':Object.values(openedSessions.current).some(session=>session.external)?'A document has an unresolved change on disk, so orei paused its saves. Closing keeps the version on disk and retains your local draft in recovery for the next launch.':closeRequested?'Pending file changes or draft recovery could not be saved. Keep the window open or retry. Closing without saving may lose the latest edits to opened Markdown files and may restore older drafts next time.':'The close handler could not be registered. Keep the window open and copy your work before leaving the app.'}</Dialog.Description><Flex gap="3" justify="end" mt="4"><Dialog.Close><Button variant="soft">Keep open</Button></Dialog.Close>{closeRequested&&<><Button onClick={()=>{setExitFailure(false);void flushNamed.current(true).then(saved=>{if(saved)void invoke('exit_after_recovery').catch(()=>{setExitFailure(true);setWindowFailure(true);});else setWindowFailure(true);});}}>Retry and close</Button><Button color="red" variant="soft" onClick={()=>void invoke('exit_after_recovery').catch(()=>{setExitFailure(true);setWindowFailure(true);})}>Close without saving</Button></>}</Flex></Dialog.Content></Dialog.Root>
      <Dialog.Root open={exportOpen} onOpenChange={setExportOpen}>
        <Dialog.Content className="export-dialog" maxWidth="400px" onCloseAutoFocus={event=>{event.preventDefault();exportButton.current?.focus();}}>
          <Dialog.Title size="5">Export diagram</Dialog.Title>
          <Dialog.Description size="2" color="gray">Exports the full diagram.</Dialog.Description>
          <div className="export-settings" role="group" aria-label="PNG settings">
            <label className="export-field">
              <Text size="2" weight="medium">PNG scale</Text>
              <Select.Root value={scale} onValueChange={setScale}>
                <Select.Trigger aria-label="PNG scale"/>
                <Select.Content>{['1','2','4'].map(n=><Select.Item key={n} value={n}>{n}×</Select.Item>)}</Select.Content>
              </Select.Root>
            </label>
            <label className="export-field">
              <Text size="2" weight="medium">PNG background</Text>
              <Select.Root value={background} onValueChange={setBackground}>
                <Select.Trigger aria-label="Canvas background"/>
                <Select.Content>
                  <Select.Item value="document">Document background</Select.Item>
                  <Select.Item value="transparent">Transparent</Select.Item>
                </Select.Content>
              </Select.Root>
            </label>
          </div>
          {outputError&&<Callout.Root color="red" role="alert"><Callout.Text>{outputError}</Callout.Text></Callout.Root>}
          <div className="export-formats">
            {(['svg','png'] as const).map(format=><section className="export-format" key={format} aria-label={`${format.toUpperCase()} export`}>
              <Text size="2" weight="medium">{format.toUpperCase()}</Text>
              <div className="export-actions">
                <Button variant="soft" color="gray" aria-label={`Copy ${format.toUpperCase()}`} disabled={!canExport} onClick={async()=>{setOutputError('');if(await copyDiagram(format==='svg'?'svg':'image',setOutputError))setExportOpen(false);}}>Copy</Button>
                <Button aria-label={`Save ${format.toUpperCase()}`} disabled={!canExport} onClick={async()=>{try{setOutputError('');await saveSnapshot(snapshot!,format,Number(scale),background==='transparent');setExportOpen(false);}catch(e){setOutputError(String(e));}}}>Save</Button>
              </div>
            </section>)}
          </div>
          <div className="export-footer"><Dialog.Close><Button variant="ghost" color="gray">Cancel</Button></Dialog.Close></div>
        </Dialog.Content>
      </Dialog.Root>
      <Dialog.Root open={!!conflictTarget&&!!conflictDisk} onOpenChange={open=>{if(!open){setConflictTarget(undefined);setConflictError('');setConflictNotice('');}}}><Dialog.Content maxWidth="760px" onCloseAutoFocus={event=>{event.preventDefault();const target=conflictFocus.current;if(target?.isConnected)target.focus();else focusDocumentFallback();}}>
        <Dialog.Title>{conflictDisk&&externalMissing(conflictDisk)?'File missing on disk':'File changed on disk'}</Dialog.Title>
        <Dialog.Description size="2">orei paused autosave for {conflictTarget} so it does not overwrite the version on disk. Your local version stays in the editor and in draft recovery until you choose. Nothing is merged or written automatically.</Dialog.Description>
        <Text as="p" size="1" color="gray" mt="2">Reload Disk adopts the file on disk. If the last save had already replaced an external version, that preserved version is put back on disk first, so the version you load is the one shown here.</Text>
        {conflictNotice&&<Callout.Root color="amber" mt="3"><Callout.Text>{conflictNotice}</Callout.Text></Callout.Root>}
        {conflictDisk?.error&&<Callout.Root color="amber" mt="3"><Callout.Text>The version on disk cannot be used: {conflictDisk.error}</Callout.Text></Callout.Root>}
        {conflictDisk?.kind==='paired'&&conflictDisk.missing.length>0&&<Callout.Root color="amber" mt="3"><Callout.Text>Missing on disk: {conflictDisk.missing.join(', ')}. Reload Disk adopts the group without the missing file; Keep Local recreates members your local version includes.</Callout.Text></Callout.Root>}
        {conflictDisk?.kind==='paired'&&<Flex align="center" gap="2" mt="3"><Text as="label" size="2">Compare file</Text><Select.Root value={conflictMember} onValueChange={value=>setConflictMember(value as 'source'|'css'|'assets')}><Select.Trigger aria-label="Compare file"/><Select.Content><Select.Item value="source">Diagram source</Select.Item><Select.Item value="css">Stylesheet companion</Select.Item><Select.Item value="assets">Asset index</Select.Item></Select.Content></Select.Root></Flex>}
        <Flex direction="column" gap="2" mt="3">
          <Text size="1" weight="medium">Version on disk</Text>
          <pre aria-label="Version on disk" className="conflict-version">{conflictDiskValue??(conflictDisk&&externalMissing(conflictDisk)?'The file no longer exists at its saved location. The local version has not been deleted.':'This file is not present in the document group.')}</pre>
          {conflictPreserved&&<>
            <Text size="1" weight="medium">Version replaced by the last save — preserved for comparison</Text>
            <pre aria-label="Preserved version" className="conflict-version">{conflictPreserved.text??'The preserved version is not UTF-8, so it cannot be shown here. It is kept on disk at the path below.'}</pre>
            <Text size="1" color="gray">Preserved at {conflictPreserved.path}. Keep Local and close replace or discard this preserved copy; Save a Copy keeps your draft elsewhere first.</Text>
          </>}
          <Text size="1" weight="medium">In orei — local version</Text>
          <pre aria-label="Local version" className="conflict-version">{conflictLocal.value??(conflictMember==='css'?'This document has no stylesheet companion.':conflictMember==='assets'?'This document has no asset index.':'The local version cannot be shown.')}</pre>
        </Flex>
        {conflictLocal.error&&<Callout.Root color="red" mt="3"><Callout.Text>{conflictLocal.error}</Callout.Text></Callout.Root>}
        {conflictError&&<Callout.Root color="red" mt="3" role="alert"><Callout.Text>{conflictError}</Callout.Text></Callout.Root>}
        <Flex gap="3" justify="end" mt="4">
          <Dialog.Close><Button variant="ghost">Keep paused</Button></Dialog.Close>
          <Button variant="soft" onClick={saveCopyFromConflict}>Save a Copy…</Button>
          <Button color="red" variant="soft" disabled={conflictBusy||!!conflictLocal.error||conflictSession?.queue.state==='saving'} onClick={()=>void resolveExternal('keep')}>Keep Local (overwrite)</Button>
          <Button disabled={!conflictReloadable} onClick={()=>void resolveExternal('reload')}>Reload Disk</Button>
        </Flex>
      </Dialog.Content></Dialog.Root>
      <Dialog.Root open={!!saveDialog} onOpenChange={open=>{if(!open)setSaveDialog(undefined);}}><Dialog.Content maxWidth="480px" onCloseAutoFocus={event=>{event.preventDefault();const target=saveDialogFocus.current;if(target?.isConnected){target.focus();return;}focusDocumentFallback();}}><Dialog.Title>{saveDialog==='save-as'?'Save As':'Save a copy'}</Dialog.Title><Dialog.Description size="2">{saveDialog==='save-as'?'Writes the current diagram to a new destination and continues editing there. The original file stays on disk.':'Writes a copy to a new destination without changing which file this document saves to.'}</Dialog.Description><Flex direction="column" gap="4" mt="4"><Flex direction="column" gap="1"><Text as="label" size="2" weight="medium">Destination format</Text><SegmentedControl.Root value={saveTarget} onValueChange={value=>setSaveTarget(value as EditableFormat)} aria-label="Save destination format"><SegmentedControl.Item value="markdown">Markdown note</SegmentedControl.Item><SegmentedControl.Item value="paired">Paired Mermaid + CSS</SegmentedControl.Item></SegmentedControl.Root></Flex><Text size="1" color="gray">{saveTarget==='markdown'?'One .md note with the Mermaid fence and marked CSS block. Images, icons, and any external stylesheet are written to the attachments folder.':'A .mmd diagram source, a .css stylesheet companion, and an asset index when the document has icons or images.'}</Text>{saveTarget==='markdown'&&<Flex direction="column" gap="2"><Text size="1" color="gray">Notes picker starts in {markdownPreferences.defaultNotesFolder??'the system default folder'}; choose any note location in the native save dialog.</Text><Text size="1" color="gray">Attachments default to {markdownPreferences.defaultAttachmentsFolder??'the selected note folder'}.</Text>{!!doc&&carriesAttachments(doc)&&<label><input type="checkbox" checked={overrideAttachments} onChange={event=>setOverrideAttachments(event.target.checked)}/> Choose a different attachments folder for this save</label>}</Flex>}{plannedDestination?.error?<Callout.Root color="amber"><Callout.Text>{plannedDestination.error}</Callout.Text></Callout.Root>:null}<Flex gap="3" justify="end"><Dialog.Close><Button variant="soft">Cancel</Button></Dialog.Close><Button disabled={!plannedDestination?.plan} onClick={()=>void saveDestination()}>{saveDialog==='save-as'?'Choose destination…':'Save copy…'}</Button></Flex></Flex></Dialog.Content></Dialog.Root>
    </main>
    <ImageStyleDialog
      open={Boolean(imageStyleTarget)}
      reference={imageStyleTarget?.reference??''}
      preview={imageStyleTarget?.data}
      css={imageStyleDocument?.css??''}
      returnFocusTo={imageStyleFocus}
      applyProblem={imageStyleFailure||undefined}
      onOpenChange={open=>{if(!open)closeImageStyle();}}
      onApply={applyImageStyleDraft}
    />
    <Dialog.Root open={settingsOpen} onOpenChange={open=>{if(!open)setSettingsOpen(false);}}>
      <Dialog.Content className="settings-dialog" align="center" maxWidth="600px" onOpenAutoFocus={event=>{event.preventDefault();settingsFirst.current?.focus();}} onCloseAutoFocus={event=>{event.preventDefault();restoreSettingsFocus();}}>
        <header className="settings-dialog-header">
          <Dialog.Title>Settings</Dialog.Title>
          <Dialog.Description size="2" color="gray">Changes apply immediately.</Dialog.Description>
        </header>
        <div className="settings-dialog-body" role="region" aria-label="Settings options" tabIndex={0}>
          <section className="settings-dialog-section" aria-labelledby="appearance-heading">
            <Heading id="appearance-heading" size="3">Appearance</Heading>
            {themeError&&<Callout.Root color="amber" role="alert"><Callout.Text>{themeError}</Callout.Text></Callout.Root>}
            <RadioCards.Root value={themeId} onValueChange={chooseTheme} columns={{initial:'1',xs:'2'}} gap="2" aria-label="App appearance">
              {appThemes.map((choice,index)=><RadioCards.Item key={choice.id} value={choice.id} ref={node=>{if(index===0)settingsFirst.current=node;}}>
                <Flex direction="column" gap="2" width="100%">
                  <Theme appearance={sampleAppearance(choice)} accentColor={choice.accentColor} grayColor={choice.grayColor}>
                    <span className="theme-sample" aria-hidden="true">
                      <span className="theme-sample-header"/>
                      <span className="theme-sample-tabs"><span/><span/></span>
                      <span className="theme-sample-body">
                        <span className="theme-sample-editor"><span/><span/><span/></span>
                        <span className="theme-sample-preview"><span/></span>
                      </span>
                    </span>
                  </Theme>
                  <Text size="2" weight="medium">{choice.label}</Text>
                  <Text size="1" color="gray">{choice.hint}</Text>
                </Flex>
              </RadioCards.Item>)}
            </RadioCards.Root>
          </section>
          <section className="settings-dialog-section" aria-labelledby="markdown-saving-heading">
            <Heading id="markdown-saving-heading" size="3">Markdown Saving</Heading>
            <Text size="2" color="gray">Choose default folders for Markdown notes and attachments.</Text>
            {(['defaultNotesFolder','defaultAttachmentsFolder'] as const).map((key,index)=>{
              const label=index===0?'Default notes folder':'Default attachments folder';
              return <Flex key={key} className="settings-folder" align="center" gap="3" wrap="wrap">
                <Flex direction="column" gap="1" className="settings-folder-label"><Text size="2" weight="medium">{label}</Text><Text size="1" color="gray">{markdownPreferences[key]??'Not set'}</Text></Flex>
                <Button size="2" variant="soft" onClick={()=>void chooseFolder(key)}>Choose Folder…</Button>
                <Button size="2" variant="ghost" disabled={!markdownPreferences[key]} onClick={()=>void updatePreference(key,null)}>Clear</Button>
              </Flex>;
            })}
            {preferencesError&&<Callout.Root color="red" role="alert"><Callout.Text>{preferencesError}</Callout.Text></Callout.Root>}
          </section>
        </div>
        <div className="settings-dialog-footer"><Dialog.Close><Button>Done</Button></Dialog.Close></div>
      </Dialog.Content>
    </Dialog.Root>
  </Theme>;
}
