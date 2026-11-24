import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,expect,test,vi} from 'vitest';
import '@testing-library/jest-dom/vitest';
import {App} from '../src/App';
import {ensureFixtures,seedFixtures} from './seed';
import { requestDocument, type NativeDocumentListener } from './native-document-request';
import {createMarkdownDocument} from '../src/markdown-document';
import {pngDataUrl} from './png-fixture';

const native=vi.hoisted(()=>({open:vi.fn(),prepare:vi.fn(),create:vi.fn(),write:vi.fn(),paired:vi.fn(),copy:vi.fn(),pairCopy:vi.fn(),image:vi.fn(),asset:vi.fn(),exit:vi.fn(async()=>{}),close:undefined as (()=>void)|undefined,documentRequests:new Set<NativeDocumentListener>()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async(command:string,args?:unknown)=>{
  if(command==='open_named_document')return native.open();
  if(command==='prepare_markdown_destination')return native.prepare(args);
  if(command==='create_markdown_document')return native.create(args);
  if(command==='write_markdown_document')return {revision:await native.write(args),published:[]};
  if(command==='write_paired_document')return native.paired(args);
  if(command==='save_markdown_copy')return native.copy(args);
  if(command==='choose_markdown_attachments')return '../attachments';
  if(command==='cancel_markdown_destination')return true;
  if(command==='save_paired_copy')return native.pairCopy(args);
  if(command==='read_paired_asset')return native.asset(args);
  if(command==='import_image_file')return native.image();
  if(command==='close_listener_ready')return false;
  if(command==='exit_after_recovery')return native.exit();
})}));
vi.mock('@tauri-apps/api/event',()=>({listen:async(name:string,listener:()=>void)=>{
  if(name==='window-close-request'){native.close=listener;return()=>{native.close=undefined;};}
  if(name==='document-request'){native.documentRequests.add(listener as NativeDocumentListener);return()=>native.documentRequests.delete(listener as NativeDocumentListener);}
  return()=>{};
}}));
vi.mock('../src/runner',()=>({startRunner:vi.fn()}));
vi.mock('../src/rendering',()=>({renderDiagram:async()=>({svg:'<svg/>',width:100,height:100})}));

afterEach(()=>{
  cleanup();localStorage.clear();vi.restoreAllMocks();
  native.open.mockReset();native.prepare.mockReset();native.create.mockReset();native.write.mockReset();native.paired.mockReset();native.copy.mockReset();native.pairCopy.mockReset();native.image.mockReset();native.asset.mockReset();native.exit.mockReset();
  native.close=undefined;
  Reflect.deleteProperty(window,'__TAURI_INTERNALS__');
});

const start=()=>{native.prepare.mockResolvedValue({destination:'image-destination',attachments:'../attachments',namespace:'image-destination'});ensureFixtures();Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{},configurable:true});return render(<App/>);};
const blankTab=()=>{fireEvent.click(screen.getByRole('button',{name:'New document'}));fireEvent.click(screen.getByRole('radio',{name:'Styling'}));fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'flowchart LR\n  A --> B\n'}});};
const source=()=>screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
const importButton=()=>screen.getByRole('button',{name:'Import PNG…'});
const library=()=>screen.getByLabelText('Local images');
const storedAssets=()=>JSON.parse(localStorage.getItem('orei-drafts-v1')!).documents['Untitled 1'].assets;
const pair=(overrides:Record<string,unknown>={})=>({
  handle:'pair-image',base:'pick',source_name:'pick.mmd',source:'flowchart LR\n  A --> B\n',
  css_name:null,css:null,assets_name:null,assets:null,revisions:{source:1,css:null,assets:null},
  ...overrides,
});

test('a rejected image import leaves the document intact when draft recovery cannot record it',async()=>{
  native.image.mockResolvedValue({name:'Beach Photo.png',data:pngDataUrl(8,8)});
  start();blankTab();
  const before=localStorage.getItem('orei-drafts-v1');
  const previousSource=source().value;
  const setItem=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('full');});
  fireEvent.click(importButton());
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('draft recovery is unavailable'));
  expect(screen.queryByLabelText('Local images')).not.toBeInTheDocument();
  expect(source()).toHaveValue(previousSource);
  setItem.mockRestore();
  expect(storedAssets()).toEqual({});
  expect(before).toContain('"Untitled 1"');
});

test('imports a selected PNG, inserts its diagram reference, and records the data in recovery',async()=>{
  const data=pngDataUrl(8,8);
  native.image.mockResolvedValue({name:'Beach Photo.png',data});
  start();blankTab();
  fireEvent.click(importButton());
  await waitFor(()=>expect(screen.getByText(/Imported Beach Photo\.png and inserted/)).toBeInTheDocument());
  expect(source()).toHaveValue('flowchart LR\n  A --> B\nimage1@{ img: "Beach Photo.png", w: 8, h: 8, constraint: "on" }');
  expect(within(library()).getByText('Beach Photo.png',{selector:'code'})).toBeInTheDocument();
  expect(within(library()).getByText('@{ img: "Beach Photo.png", w: 8, h: 8, constraint: "on" }')).toBeInTheDocument();
  expect(storedAssets()).toEqual({'Beach Photo.png':data});
  expect(screen.getByLabelText('Image reference')).toHaveValue('');
});

test('pasting a PNG adds a sized node and recovers its data in Styling',async()=>{
  start();blankTab();fireEvent.click(screen.getByRole('radio',{name:'Diagram'}));
  const data=pngDataUrl(480,240);
  const file=new File([Uint8Array.from(atob(data.split(',')[1]),byte=>byte.charCodeAt(0))],'clip.png',{type:'image/png'});
  const editor=source();
  editor.setSelectionRange(editor.value.length,editor.value.length);
  fireEvent.paste(editor,{clipboardData:{items:[{kind:'file',type:'image/png',getAsFile:()=>file}],files:[file]}});
  await waitFor(()=>expect(source()).toHaveValue('flowchart LR\n  A --> B\nimage1@{ img: "pasted-image.png", w: 240, h: 120, constraint: "on" }'));
  fireEvent.paste(editor,{clipboardData:{files:[file]}});
  await waitFor(()=>expect(source().value).toContain('\nimage2@{ img: "pasted-image-2.png", w: 240, h: 120, constraint: "on" }'));
  expect(storedAssets()).toEqual({'pasted-image.png':data,'pasted-image-2.png':data});
  expect(fireEvent.paste(editor,{clipboardData:{items:[{kind:'string',type:'text/plain'}]}})).toBe(true);
  fireEvent.click(screen.getByRole('radio',{name:'Styling'}));
  expect(within(library()).getByText('pasted-image.png',{selector:'code'})).toBeInTheDocument();
  expect(within(library()).getByText('@{ img: "pasted-image.png", w: 240, h: 120, constraint: "on" }')).toBeInTheDocument();
});

test('rejecting a clipboard PNG leaves the source and assets intact',async()=>{
  start();blankTab();fireEvent.click(screen.getByRole('radio',{name:'Diagram'}));
  const before=source().value;
  const file=new File(['invalid PNG'],'clip.png',{type:'image/png'});
  fireEvent.paste(source(),{clipboardData:{files:[file]}});
  expect(await screen.findByRole('alert')).toHaveTextContent('not a readable PNG');
  expect(source()).toHaveValue(before);
  expect(storedAssets()).toEqual({});
});

test('uses the reference the user provides for a paired-compatible path',async()=>{
  const data=pngDataUrl(16,9);
  native.image.mockResolvedValue({name:'photo.png',data});
  start();blankTab();
  fireEvent.change(screen.getByLabelText('Image reference'),{target:{value:'assets/photo.png'}});
  fireEvent.click(importButton());
  await waitFor(()=>expect(screen.getByText(/Imported assets\/photo\.png and inserted/)).toBeInTheDocument());
  expect(source()).toHaveValue('flowchart LR\n  A --> B\nimage1@{ img: "assets/photo.png", w: 16, h: 9, constraint: "on" }');
  expect(within(library()).getByText('assets/photo.png',{selector:'code'})).toBeInTheDocument();
  expect(storedAssets()).toEqual({'assets/photo.png':data});
});

test('a cancelled picker leaves the document intact and reports nothing',async()=>{
  native.image.mockResolvedValue(null);
  start();blankTab();
  const before=source().value;
  fireEvent.click(importButton());
  await waitFor(()=>expect(native.image).toHaveBeenCalledOnce());
  expect(source()).toHaveValue(before);
  expect(screen.queryByLabelText('Local images')).not.toBeInTheDocument();
  expect(storedAssets()).toEqual({});
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a reference collision is explicit and preserves the stored image',async()=>{
  const first=pngDataUrl(8,8),second=pngDataUrl(9,9);
  native.image.mockResolvedValueOnce({name:'photo.png',data:first}).mockResolvedValueOnce({name:'photo.png',data:second});
  start();blankTab();
  fireEvent.click(importButton());
  await waitFor(()=>expect(within(library()).getByText('photo.png',{selector:'code'})).toBeInTheDocument());
  fireEvent.click(importButton());
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('already stored as photo.png'));
  expect(screen.getByRole('alert')).toHaveTextContent('nothing was changed');
  expect(storedAssets()['photo.png']).toBe(first);
  expect(within(library()).getAllByText('photo.png',{selector:'code'})).toHaveLength(1);
});

test('an unsafe reference is refused without losing document text',async()=>{
  native.image.mockResolvedValue({name:'photo.png',data:pngDataUrl(8,8)});
  start();blankTab();
  fireEvent.change(screen.getByLabelText('Image reference'),{target:{value:'../outside.png'}});
  fireEvent.click(importButton());
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Invalid image reference'));
  expect(source()).toHaveValue('flowchart LR\n  A --> B\n');
  expect(storedAssets()).toEqual({});
});

test('an image beyond the decoded-size limits is rejected with the measured size',async()=>{
  native.image.mockResolvedValue({name:'huge.png',data:pngDataUrl(4097,1)});
  start();blankTab();
  fireEvent.click(importButton());
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('huge.png is 4097 × 1 px'));
  expect(screen.getByRole('alert')).toHaveTextContent('supported limit is 4096 px per side');
  expect(source()).toHaveValue('flowchart LR\n  A --> B\n');
  expect(storedAssets()).toEqual({});
});

test('a Markdown note autosaves imported images through its approved attachments folder',async()=>{
  const markdown=createMarkdownDocument({mermaid:'graph TD\n',css:'node { color: red; }\n'});
  native.open.mockResolvedValue({handle:'handle-image',name:'note.md',text:markdown,revision:3});
  native.image.mockResolvedValue({name:'photo.png',data:pngDataUrl(8,8)});
  native.write.mockResolvedValue(4);
  start();
  fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n'));
  fireEvent.click(screen.getByRole('radio',{name:'Styling'}));
  fireEvent.click(importButton());
  await waitFor(()=>expect(within(library()).getByText('photo.png',{selector:'code'})).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(native.write).toHaveBeenCalledOnce(),{timeout:2500});
  expect(native.write.mock.calls[0][0].files).toEqual(expect.arrayContaining([expect.objectContaining({kind:'image',data:pngDataUrl(8,8)})]));
  expect(native.write.mock.calls[0][0].text).toContain('orei:assets:v1');
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'graph TD\n  A-->B\n'}});
  await waitFor(()=>expect(native.write).toHaveBeenCalledTimes(2),{timeout:2500});

  fireEvent.click(screen.getByRole('button',{name:'Remove image photo.png'}));
  expect(screen.queryByText('Save paused')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'graph TD\n  A-->C\n'}});
  await waitFor(()=>expect(native.write).toHaveBeenCalledTimes(3),{timeout:2500});
  expect(native.write.mock.calls.at(-1)![0].text).toContain('A-->C');
});

test('a paired document embeds the selected image in its index and reopens without the original file',async()=>{
  const data=pngDataUrl(8,8);
  native.open.mockResolvedValue(pair());
  native.image.mockResolvedValue({name:'photo.png',data});
  native.paired.mockResolvedValue({revisions:{source:2,css:null,assets:1},written:['source','asset index'],failure:null});
  const first=start();
  fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(screen.getByLabelText('Diagram source')).toHaveValue('flowchart LR\n  A --> B\n'));
  fireEvent.click(screen.getByRole('radio',{name:'Styling'}));
  fireEvent.change(screen.getByLabelText('Image reference'),{target:{value:'assets/photo.png'}});
  fireEvent.click(importButton());
  await waitFor(()=>expect(within(library()).getByText('assets/photo.png',{selector:'code'})).toBeInTheDocument());
  expect(screen.queryByText('Save paused')).not.toBeInTheDocument();
  await waitFor(()=>expect(native.paired).toHaveBeenCalled(),{timeout:2500});
  const written=native.paired.mock.calls[0][0];
  const index=JSON.parse(written.assets);
  expect(index.assets['assets/photo.png']).toEqual({kind:'image',mediaType:'image/png',encoding:'data-url',data});
  expect(written.source).toContain('image1@{ img: "assets/photo.png", w: 8, h: 8, constraint: "on" }');

  // Reopen from the index alone: the original PNG is gone and is never requested.
  first.unmount();
  localStorage.clear();
  native.asset.mockRejectedValue(new Error('Missing document asset: assets/photo.png'));
  native.open.mockResolvedValue(pair({source:written.source,assets_name:'pick.orei-assets.json',assets:written.assets,revisions:{source:2,css:null,assets:1}}));
  native.asset.mockClear();
  start();
  fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(screen.getByRole('tab',{name:'pick.mmd'})).toHaveAttribute('aria-selected','true'));
  expect(source()).toHaveValue('flowchart LR\n  A --> B\nimage1@{ img: "assets/photo.png", w: 8, h: 8, constraint: "on" }');
  fireEvent.click(screen.getByRole('radio',{name:'Styling'}));
  expect(within(library()).getByText('assets/photo.png',{selector:'code'})).toBeInTheDocument();
  expect(native.asset).not.toHaveBeenCalled();
  expect(screen.queryByText(/Missing adjacent document assets/)).not.toBeInTheDocument();
});

test('the imported image travels into a paired Save Copy and Markdown no longer refuses attachments',async()=>{
  const data=pngDataUrl(8,8);
  native.open.mockResolvedValue(pair());
  native.image.mockResolvedValue({name:'photo.png',data});
  native.paired.mockResolvedValue({revisions:{source:2,css:null,assets:1},written:['source','asset index'],failure:null});
  native.pairCopy.mockResolvedValue(true);
  start();
  fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(screen.getByLabelText('Diagram source')).toHaveValue('flowchart LR\n  A --> B\n'));
  fireEvent.click(screen.getByRole('radio',{name:'Styling'}));
  fireEvent.change(screen.getByLabelText('Image reference'),{target:{value:'assets/photo.png'}});
  fireEvent.click(importButton());
  await waitFor(()=>expect(within(library()).getByText('assets/photo.png',{selector:'code'})).toBeInTheDocument());

  await requestDocument(native.documentRequests,'save-copy');
  expect(await screen.findByRole('dialog')).toHaveTextContent('Destination format');
  // Markdown attachments carry the image and the native destination call publishes it.
  fireEvent.click(screen.getByRole('radio',{name:'Markdown note'}));
  expect(screen.getByRole('button',{name:'Save copy…'})).toBeEnabled();
  // The paired copy carries the same embedded data URL in its adjacent asset index.
  fireEvent.click(screen.getByRole('radio',{name:'Paired Mermaid + CSS'}));
  fireEvent.click(screen.getByRole('button',{name:'Save copy…'}));
  await waitFor(()=>expect(native.pairCopy).toHaveBeenCalledOnce());
  const copied=native.pairCopy.mock.calls[0][0];
  expect(copied.source).toContain('image1@{ img: "assets/photo.png", w: 8, h: 8, constraint: "on" }');
  expect(JSON.parse(copied.assets).assets['assets/photo.png']).toEqual({kind:'image',mediaType:'image/png',encoding:'data-url',data});
});

test('an imported image reopens from local draft recovery without the original file',async()=>{
  native.image.mockResolvedValue({name:'photo.png',data:pngDataUrl(8,8)});
  const first=start();blankTab();
  fireEvent.click(importButton());
  await waitFor(()=>expect(within(library()).getByText('photo.png',{selector:'code'})).toBeInTheDocument());
  first.unmount();
  ensureFixtures();
  render(<App/>);
  expect(screen.getByRole('tab',{name:'Untitled 1'})).toHaveAttribute('aria-selected','true');
  fireEvent.click(screen.getByRole('radio',{name:'Styling'}));
  expect(within(library()).getByText('photo.png',{selector:'code'})).toBeInTheDocument();
  expect(source()).toHaveValue('flowchart LR\n  A --> B\nimage1@{ img: "photo.png", w: 8, h: 8, constraint: "on" }');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
