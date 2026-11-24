import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from '../src/App';
import { ensureFixtures } from './seed';
import { requestDocument, type NativeDocumentListener } from './native-document-request';
import { markdownAssetPaths } from '../src/markdown-assets';
import { parseMarkdownDocument } from '../src/markdown-document';
import { pngDataUrl } from './png-fixture';

const native=vi.hoisted(()=>({
  preferences:{defaultNotesFolder:'/notes-a',defaultAttachmentsFolder:'/assets-a'},
  folders:[] as string[], prepared:[] as unknown[], copies:[] as {text:string;files:{path:string;data:string;kind:string}[]}[], nextAttachments:'', rows:[] as {handle:string;name:string;text:string;revision:number;files:{path:string;data:string;kind:string}[]}[],
  cancelPrepare:false, rootReady:false, chooseCalls:0, open:vi.fn(), prepare:vi.fn(), create:vi.fn(), write:vi.fn(), copy:vi.fn(), image:vi.fn(), icon:vi.fn(), readAssets:vi.fn(),
  settingsListeners:new Set<()=>void>(), documentRequests:new Set<NativeDocumentListener>(),
}));

vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async(command:string,args?:any)=>{
  if(command==='get_markdown_preferences')return native.preferences;
  if(command==='set_markdown_preferences'){native.preferences=args.preferences;return true;}
  if(command==='pick_folder')return native.folders.shift()??null;
  if(command==='open_named_document')return native.open();
  if(command==='prepare_markdown_destination')return native.prepare(args);
  if(command==='create_markdown_document')return native.create(args);
  if(command==='write_markdown_document')return native.write(args);
  if(command==='save_markdown_copy')return native.copy(args);
  if(command==='read_markdown_assets')return native.readAssets(args);
  if(command==='markdown_root_ready')return native.rootReady;
  if(command==='choose_markdown_attachments'){native.chooseCalls++;native.rootReady=true;return '../assets-a';}
  if(command==='import_image_file')return native.image();
  if(command==='import_icon_file')return native.icon();
  if(command==='cancel_markdown_destination')return true;
  if(command==='close_listener_ready')return false;
  if(command==='release_named_document')return true;
})}));
vi.mock('@tauri-apps/api/event',()=>({listen:async(name:string,listener:()=>void)=>{
  if(name==='settings-request'){native.settingsListeners.add(listener);return()=>native.settingsListeners.delete(listener);}
  if(name==='document-request'){native.documentRequests.add(listener as NativeDocumentListener);return()=>native.documentRequests.delete(listener as NativeDocumentListener);}
  return()=>{};
}}));
vi.mock('../src/runner',()=>({startRunner:vi.fn()}));
vi.mock('../src/rendering',()=>({renderDiagram:async()=>({svg:'<svg/>',width:100,height:100})}));

afterEach(()=>{
  cleanup();localStorage.clear();
  for(const fn of [native.open,native.prepare,native.create,native.write,native.copy,native.image,native.icon,native.readAssets])fn.mockReset();
  native.preferences={defaultNotesFolder:'/notes-a',defaultAttachmentsFolder:'/assets-a'};
  native.folders=[];native.prepared=[];native.copies=[];native.nextAttachments='';native.rows=[];native.cancelPrepare=false;native.rootReady=false;native.chooseCalls=0;
  Reflect.deleteProperty(window,'__TAURI_INTERNALS__');
});

function start(){
  native.prepare.mockImplementation(async(args:{defaultName:string;needsAttachments:boolean;overrideAttachments:boolean})=>{
    native.prepared.push(args);
    if(native.cancelPrepare)return null;
    const attachments=args.overrideAttachments?'../one-off':native.nextAttachments||'../assets-a';
    native.nextAttachments='';
    return {destination:`destination-${native.prepared.length}`,attachments,namespace:`saved-note-${native.prepared.length}`};
  });
  native.create.mockImplementation(async(args:{destination:string;text:string;files:{path:string;data:string;kind:string}[]})=>{
    const row={handle:`handle-${native.rows.length+1}`,name:`note-${native.rows.length+1}.md`,text:args.text,revision:1,files:args.files};
    native.rows.push(row);return row;
  });
  native.write.mockImplementation(async(args:{handle:string;revision:number;text:string;files:{path:string;data:string;kind:string}[]})=>{
    if(!native.rootReady&&args.files.length)throw new Error('Choose an attachments folder in the native Markdown destination flow first');
    const row=native.rows.find(item=>item.handle===args.handle)!;row.text=args.text;row.revision++;row.files=args.files;
    return {revision:row.revision,published:args.files.map(file=>file.path)};
  });
  native.copy.mockImplementation(async(args:{text:string;files:{path:string;data:string;kind:string}[]})=>{native.copies.push(args);return true;});
  native.open.mockImplementation(async()=>native.rows.at(-1)??null);
  native.readAssets.mockImplementation(async(args:{references:{path:string;kind:string}[]})=>{
    const row=native.rows.at(-1)!;
    const manifest=markdownAssetPaths(row.text)!;
    const paths=[...Object.values(manifest.assets).map(asset=>asset.path),...(manifest.css?[manifest.css]:[])];
    return args.references.map(reference=>{
      const sourcePath=paths.find(path=>path===reference.path)!;
      const file=row.files.find(item=>sourcePath.endsWith(item.path))!;
      return {path:reference.path,data:file.data,kind:file.kind};
    });
  });
  ensureFixtures();Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{},configurable:true});
  return render(<App/>);
}

test('first Save stores image, custom icon, and authored CSS as files and reopens with validated hydration',async()=>{
  const png=pngDataUrl(8,8);
  native.image.mockResolvedValue({name:'photo.png',data:png});
  native.icon.mockResolvedValue({name:'car.svg',text:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'});
  start();
  fireEvent.click(screen.getByRole('button',{name:'New document'}));
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'flowchart LR\n  A@{ img: "photo.png" } --> B@{ icon: "custom:car" }\n'}});
  fireEvent.click(screen.getByRole('radio',{name:'Styling'}));
  fireEvent.change(screen.getByLabelText('Diagram stylesheet'),{target:{value:'.authored { color: purple; }\n'}});
  fireEvent.click(screen.getByRole('button',{name:'Import PNG…'}));
  await waitFor(()=>expect(screen.getByText(/Imported photo\.png/)).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button',{name:'Import SVG…'}));
  await waitFor(()=>expect(screen.getByText(/Imported custom:car/)).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(native.create).toHaveBeenCalledOnce());

  const saved=native.rows[0];
  expect(native.prepared[0]).toMatchObject({defaultName:'Untitled 1.md',needsAttachments:true,overrideAttachments:false});
  expect(saved.files.map(file=>file.kind).sort()).toEqual(['css','icon','image']);
  expect(saved.text).not.toContain('.authored { color: purple; }');
  expect(saved.text).not.toContain(png);
  expect(saved.text).not.toContain('<svg');
  expect(parseMarkdownDocument(saved.text).css).toBe('');
  expect(markdownAssetPaths(saved.text)?.css).toContain('../assets-a/');

  fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(screen.getByRole('tab',{name:'note-1.md (2)'})).toBeInTheDocument());
  expect(screen.getByLabelText('Diagram stylesheet')).toHaveValue('.authored { color: purple; }\n');
  fireEvent.click(screen.getByRole('radio',{name:'Styling'}));
  expect(within(screen.getByLabelText('Local images')).getByText('photo.png',{selector:'code'})).toBeInTheDocument();
  expect(within(screen.getByLabelText('Imported icons')).getByText('custom:car',{selector:'code'})).toBeInTheDocument();

  native.nextAttachments='../copy-assets';
  await requestDocument(native.documentRequests,'save-copy');
  fireEvent.click(screen.getByRole('radio',{name:'Markdown note'}));
  fireEvent.click(screen.getByRole('button',{name:'Save copy…'}));
  await waitFor(()=>expect(native.copy).toHaveBeenCalledOnce());
  expect(markdownAssetPaths(native.copies[0].text)?.attachments).toBe('../copy-assets');
  expect(screen.getByRole('tab',{name:'note-1.md (2)'})).toHaveAttribute('aria-selected','true');

  await requestDocument(native.documentRequests,'save-as');
  fireEvent.click(screen.getByRole('radio',{name:'Markdown note'}));
  fireEvent.click(screen.getByLabelText('Choose a different attachments folder for this save'));
  fireEvent.click(screen.getByRole('button',{name:'Choose destination…'}));
  await waitFor(()=>expect(native.create).toHaveBeenCalledTimes(2));
  expect(native.prepared.at(-1)).toMatchObject({needsAttachments:true,overrideAttachments:true});
  expect(markdownAssetPaths(native.rows[1].text)?.attachments).toBe('../one-off');
});

test('a reopened note asks for its attachments folder before saving sidecar files',async()=>{
  native.image.mockResolvedValue({name:'photo.png',data:pngDataUrl(8,8)});
  start();
  fireEvent.click(screen.getByRole('button',{name:'New document'}));
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'flowchart LR\n  A@{ img: "photo.png" } --> B\n'}});
  fireEvent.click(screen.getByRole('radio',{name:'Styling'}));
  fireEvent.click(screen.getByRole('button',{name:'Import PNG…'}));
  await waitFor(()=>expect(screen.getByText(/Imported photo\.png/)).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(native.create).toHaveBeenCalledOnce());

  fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(screen.getByRole('tab',{name:'note-1.md (2)'})).toBeInTheDocument());
  // A reopened handle authorizes reads from the remembered folder, never writes.
  native.chooseCalls=0;native.write.mockClear();
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'flowchart LR\n  A@{ img: "photo.png" } --> C\n'}});
  // Autosave cannot publish sidecars without a live write root; the repair is an explicit Save.
  await waitFor(()=>expect(native.write).toHaveBeenCalled(),{timeout:2500});
  expect(native.chooseCalls).toBe(0);
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(native.chooseCalls).toBe(1));
  await waitFor(()=>expect(native.write.mock.calls.at(-1)![0].files.length).toBeGreaterThan(0));
  expect(native.write.mock.calls.at(-1)![0].text).toContain('--> C');
});

test('cancelling First Save at the native destination picker keeps the recoverable draft',async()=>{
  start();
  fireEvent.click(screen.getByRole('button',{name:'New document'}));
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'flowchart TD\n  A-->RECOVER\n'}});
  native.cancelPrepare=true;
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(native.prepare).toHaveBeenCalledOnce());
  expect(native.create).not.toHaveBeenCalled();
  expect(screen.getByRole('tab',{name:'Untitled 1'})).toBeInTheDocument();
  expect(screen.getByLabelText('Diagram source')).toHaveValue('flowchart TD\n  A-->RECOVER\n');
  expect(JSON.parse(localStorage.getItem('orei-drafts-v1')!).documents['Untitled 1'].source).toContain('RECOVER');
});

test('Settings defaults stay independent; Save As overrides attachments and Save Copy cancellation keeps the association',async()=>{
  start();
  await waitFor(()=>expect(native.settingsListeners.size).toBeGreaterThan(0));
  act(()=>{for(const listener of native.settingsListeners)listener();});
  const settings=await screen.findByRole('dialog',{name:'Settings'});
  native.folders=['/notes-b','/assets-b'];
  fireEvent.click(within(settings).getAllByRole('button',{name:'Choose Folder…'})[0]);
  await waitFor(()=>expect(within(settings).getByText('/notes-b')).toBeInTheDocument());
  fireEvent.click(within(settings).getAllByRole('button',{name:'Choose Folder…'})[1]);
  await waitFor(()=>expect(within(settings).getByText('/assets-b')).toBeInTheDocument());
  fireEvent.click(within(settings).getByRole('button',{name:'Done'}));
  native.open.mockResolvedValue({handle:'source-handle',name:'source.md',text:'```mermaid\ngraph TD\n```\n<!-- orei:css:start -->\n```css\n.keep {}\n```\n<!-- orei:css:end -->\n',revision:1});
  fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n'));

  await requestDocument(native.documentRequests,'save-as');
  fireEvent.click(screen.getByRole('button',{name:'Choose destination…'}));
  await waitFor(()=>expect(native.create).toHaveBeenCalledOnce());
  expect(native.prepared.at(-1)).toMatchObject({defaultName:'source.md',needsAttachments:false,overrideAttachments:false});
  // A note whose only styling is inline needs no attachments folder and keeps that shape.
  expect(screen.queryByLabelText('Choose a different attachments folder for this save')).not.toBeInTheDocument();
  expect(markdownAssetPaths(native.rows[0].text)).toBeUndefined();
  expect(native.rows[0].text).toContain('.keep {}');
  expect(screen.getByRole('tab',{name:'note-1.md'})).toHaveAttribute('aria-selected','true');

  native.cancelPrepare=true;
  await requestDocument(native.documentRequests,'save-copy');
  fireEvent.click(screen.getByRole('radio',{name:'Markdown note'}));
  fireEvent.click(screen.getByRole('button',{name:'Save copy…'}));
  await waitFor(()=>expect(native.prepared).toHaveLength(2));
  expect(native.copy).not.toHaveBeenCalled();
  expect(screen.getByRole('tab',{name:'note-1.md'})).toHaveAttribute('aria-selected','true');

  native.cancelPrepare=false;
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'graph TD\n  AFTER --> DEFAULT CHANGE\n'}});
  await waitFor(()=>expect(native.write).toHaveBeenCalledOnce(),{timeout:2500});
  expect(native.write.mock.calls[0][0].files).toEqual([]);
  expect(native.write.mock.calls[0][0].text).toContain('.keep {}');
});

test('ordinary edits to a legacy inline-CSS note keep CSS in Markdown without attachment metadata',async()=>{
  const original='```mermaid\ngraph TD\n```\n<!-- orei:css:start -->\n```css\n.old { color: red; }\n```\n<!-- orei:css:end -->\n';
  start();native.open.mockResolvedValue({handle:'legacy-handle',name:'legacy.md',text:original,revision:4});fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(screen.getByLabelText('Diagram stylesheet')).toHaveValue('.old { color: red; }\n'));
  fireEvent.change(screen.getByLabelText('Diagram stylesheet'),{target:{value:'.old { color: blue; }\n'}});
  await waitFor(()=>expect(native.write).toHaveBeenCalledOnce(),{timeout:2500});
  expect(native.write.mock.calls[0][0].text).toContain('.old { color: blue; }');
  expect(native.write.mock.calls[0][0].text).not.toContain('orei:assets:v1');
  expect(native.write.mock.calls[0][0].files).toEqual([]);
});

test('a Markdown destination with no assets does not require an attachment folder',async()=>{
  start();
  native.open.mockResolvedValue({handle:'plain-handle',name:'plain.md',text:'```mermaid\ngraph TD\n```\n<!-- orei:css:start -->\n```css\n```\n<!-- orei:css:end -->\n',revision:1});
  fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n'));
  await requestDocument(native.documentRequests,'save-copy');
  fireEvent.click(screen.getByRole('radio',{name:'Markdown note'}));
  fireEvent.click(screen.getByRole('button',{name:'Save copy…'}));
  await waitFor(()=>expect(native.copy).toHaveBeenCalledOnce());
  expect(native.prepared[0]).toMatchObject({needsAttachments:false,overrideAttachments:false});
  expect(native.copy.mock.calls[0][0].files).toEqual([]);
  expect(markdownAssetPaths(native.copy.mock.calls[0][0].text)).toBeUndefined();
});
