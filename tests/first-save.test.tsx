import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,test,vi} from 'vitest';
import '@testing-library/jest-dom/vitest';
import {App} from '../src/App';
import {ensureFixtures,seedFixtures} from './seed';
import { requestDocument, type NativeDocumentListener } from './native-document-request';
import {createMarkdownDocument} from '../src/markdown-document';

type Opened={handle:string;name:string;text:string;revision:number};
const native=vi.hoisted(()=>({open:vi.fn(),prepare:vi.fn(async()=>({destination:'destination-1',attachments:'../attachments',namespace:'destination-1'})),create:vi.fn(),write:vi.fn(),copy:vi.fn(),exit:vi.fn(async()=>{}),close:undefined as (()=>void)|undefined,documentRequests:new Set<NativeDocumentListener>()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async(command:string,args?:unknown)=>{
  if(command==='open_named_document')return native.open();
  if(command==='prepare_markdown_destination')return native.prepare();
  if(command==='create_markdown_document')return native.create(args);
  if(command==='write_markdown_document')return {revision:await native.write(args),published:[]};
  if(command==='save_markdown_copy')return native.copy(args);
  if(command==='cancel_markdown_destination')return true;
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
  cleanup();localStorage.clear();
  native.open.mockReset();native.prepare.mockReset();native.create.mockReset();native.write.mockReset();native.copy.mockReset();native.exit.mockReset();
  native.close=undefined;
  Reflect.deleteProperty(window,'__TAURI_INTERNALS__');
});

const start=()=>{native.prepare.mockResolvedValue({destination:'destination-1',attachments:'../attachments',namespace:'destination-1'});ensureFixtures();Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{},configurable:true});return render(<App/>);};
const source=()=>screen.getByLabelText('Diagram source');
const markdown=createMarkdownDocument({mermaid:'graph TD\n',css:'node { color: red; }\n'});

test('first Save creates an exclusive Markdown destination, renames the initiating tab, and autosaves later edits',async()=>{
  native.create.mockImplementation(async({text}:{text:string})=>({handle:'handle-1',name:'note.md',text,revision:1}));
  native.write.mockResolvedValue(2);
  start();
  fireEvent.click(screen.getByRole('button',{name:'New document'}));
  fireEvent.change(source(),{target:{value:'flowchart LR\n  A-->B\n'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(native.create).toHaveBeenCalledOnce());
  expect(native.create.mock.calls[0][0].text).toContain('flowchart LR\n  A-->B\n');
  expect(native.create.mock.calls[0][0].text).toContain('<!-- orei:css:start -->');
  await waitFor(()=>expect(screen.getByRole('tab',{name:'note.md'})).toHaveAttribute('aria-selected','true'));
  expect(native.write).not.toHaveBeenCalled();

  fireEvent.change(source(),{target:{value:'flowchart LR\n  A-->C\n'}});
  await waitFor(()=>expect(native.write).toHaveBeenCalledOnce(),{timeout:2500});
  expect(native.write.mock.calls[0][0]).toMatchObject({handle:'handle-1',revision:1});
  expect(native.write.mock.calls[0][0].text).toContain('flowchart LR\n  A-->C\n');
});

test('canceling the first-save picker keeps an untitled recoverable draft with no association',async()=>{
  native.create.mockResolvedValue(null);
  start();
  fireEvent.click(screen.getByRole('button',{name:'New document'}));
  fireEvent.change(source(),{target:{value:'canceled draft'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(native.create).toHaveBeenCalledOnce());
  expect(source()).toHaveValue('canceled draft');
  expect(screen.getByRole('tab',{name:'Untitled 1'})).toBeInTheDocument();
  expect(native.write).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem('orei-drafts-v1')!).documents['Untitled 1'].source).toBe('canceled draft');
});

test('a failed first save keeps the draft, recovery, and untitled identity',async()=>{
  native.create.mockRejectedValue(Error('destination already exists'));
  start();
  fireEvent.click(screen.getByRole('button',{name:'New document'}));
  fireEvent.change(source(),{target:{value:'failed draft'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  expect(await screen.findByRole('dialog')).toHaveTextContent('destination already exists');
  expect(source()).toHaveValue('failed draft');
  fireEvent.click(screen.getByRole('button',{name:'OK'}));
  expect(screen.getByRole('tab',{name:'Untitled 1'})).toBeInTheDocument();
  expect(native.write).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem('orei-drafts-v1')!).documents['Untitled 1'].source).toBe('failed draft');
});

test('edits made while the first-save picker is open are written after association',async()=>{
  let finish!:(opened:Opened)=>void;
  native.create.mockImplementation(()=>new Promise<Opened>(resolve=>{finish=resolve;}));
  native.write.mockResolvedValue(2);
  start();
  fireEvent.click(screen.getByRole('button',{name:'New document'}));
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(native.create).toHaveBeenCalledOnce());
  fireEvent.change(source(),{target:{value:'flowchart TD\n  Late[Edit]\n'}});
  await act(async()=>{finish({handle:'handle-2',name:'late.md',text:native.create.mock.calls[0][0].text,revision:1});});
  await waitFor(()=>expect(screen.getByRole('tab',{name:'late.md'})).toBeInTheDocument());
  await waitFor(()=>expect(native.write).toHaveBeenCalledOnce(),{timeout:2500});
  expect(native.write.mock.calls[0][0]).toMatchObject({handle:'handle-2',revision:1});
  expect(native.write.mock.calls[0][0].text).toContain('Late[Edit]');
  expect(source()).toHaveValue('flowchart TD\n  Late[Edit]\n');
});

test('switching tabs while the first-save picker is open associates the initiating tab without stealing focus',async()=>{
  let finish!:(opened:Opened)=>void;
  native.create.mockImplementation(()=>new Promise<Opened>(resolve=>{finish=resolve;}));
  native.write.mockResolvedValue(2);
  start();
  fireEvent.click(screen.getByRole('button',{name:'New document'}));
  fireEvent.change(source(),{target:{value:'first tab work'}});
  fireEvent.click(screen.getByRole('button',{name:'New document'}));
  fireEvent.click(screen.getByRole('tab',{name:'Untitled 1'}));
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(native.create).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('tab',{name:'Untitled 2'}));
  await act(async()=>{finish({handle:'handle-3',name:'switched.md',text:native.create.mock.calls[0][0].text,revision:1});});
  await waitFor(()=>expect(screen.getByRole('tab',{name:'switched.md'})).toBeInTheDocument());
  expect(screen.getByRole('tab',{name:'Untitled 2'})).toHaveAttribute('aria-selected','true');
  fireEvent.click(screen.getByRole('tab',{name:'switched.md'}));
  expect(source()).toHaveValue('first tab work');
  fireEvent.change(source(),{target:{value:'edited after return'}});
  await waitFor(()=>expect(native.write).toHaveBeenCalledOnce(),{timeout:2500});
  expect(native.write.mock.calls[0][0]).toMatchObject({handle:'handle-3',revision:1});
  expect(native.write.mock.calls[0][0].text).toContain('edited after return');
});

test('closing the initiating tab while the picker is open does not associate a replacement tab',async()=>{
  localStorage.setItem('orei-drafts-v1',JSON.stringify({documents:{'Untitled 1':{source:'old work',css:'',assets:{}}},active:'Untitled 1'}));
  let finish!:(opened:Opened)=>void;
  native.create.mockImplementation(()=>new Promise<Opened>(resolve=>{finish=resolve;}));
  start();
  fireEvent.change(source(),{target:{value:'closing work'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(native.create).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button',{name:'Close Untitled 1'}));
  fireEvent.click(screen.getByRole('button',{name:'Discard draft'}));
  expect(screen.queryByLabelText('Diagram source')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'New diagram'}));
  await act(async()=>{finish({handle:'handle-4',name:'closed.md',text:native.create.mock.calls[0][0].text,revision:1});});
  await waitFor(()=>expect(screen.getByText(/Saved closed\.md\. The document was closed/)).toBeInTheDocument());
  expect(native.write).not.toHaveBeenCalled();
  expect(screen.queryByRole('tab',{name:'closed.md'})).not.toBeInTheDocument();
  expect(screen.getByRole('tab',{name:'Untitled 1'})).toBeInTheDocument();
  expect(source()).not.toHaveValue('closing work');
});

test('Save on a named document flushes pending autosave immediately',async()=>{
  native.open.mockResolvedValue({handle:'handle-5',name:'named.md',text:markdown,revision:3});
  native.write.mockResolvedValue(4);
  start();
  fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(source()).toHaveValue('graph TD\n'));
  fireEvent.change(source(),{target:{value:'graph TD\n  A-->Saved\n'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(native.write).toHaveBeenCalledOnce(),{timeout:600});
  expect(native.write.mock.calls[0][0]).toMatchObject({handle:'handle-5',revision:3});
  expect(native.write.mock.calls[0][0].text).toContain('A-->Saved');
});

test('Save Copy stays independent of the first-save association',async()=>{
  native.create.mockImplementation(async({text}:{text:string})=>({handle:'handle-6',name:'source.md',text,revision:1}));
  native.copy.mockResolvedValue(true);
  native.write.mockResolvedValue(2);
  start();
  fireEvent.click(screen.getByRole('button',{name:'New document'}));
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(screen.getByRole('tab',{name:'source.md'})).toBeInTheDocument());
  await requestDocument(native.documentRequests,'save-copy');
  fireEvent.click(screen.getByRole('button',{name:'Save copy…'}));
  await waitFor(()=>expect(native.copy).toHaveBeenCalledOnce());
  expect(native.copy.mock.calls[0][0].text).toContain('<!-- orei:css:start -->');
  expect(native.create).toHaveBeenCalledOnce();
  expect(source()).toHaveValue('flowchart TD\n  A[Start] --> B[End]');
  fireEvent.change(source(),{target:{value:'source edited after copy'}});
  await waitFor(()=>expect(native.write).toHaveBeenCalledOnce(),{timeout:2500});
  expect(native.write.mock.calls[0][0]).toMatchObject({handle:'handle-6',revision:1});
});

test('native close waits for a pending first save and its late-edit flush before exiting',async()=>{
  let finishCreate!:(opened:Opened)=>void;
  let finishWrite!:(revision:number)=>void;
  native.create.mockImplementation(()=>new Promise<Opened>(resolve=>{finishCreate=resolve;}));
  native.write.mockImplementation(()=>new Promise<number>(resolve=>{finishWrite=resolve;}));
  start();
  await waitFor(()=>expect(native.close).toBeDefined());
  fireEvent.click(screen.getByRole('button',{name:'New document'}));
  fireEvent.change(source(),{target:{value:'flowchart LR\n  A-->Before\n'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(native.create).toHaveBeenCalledOnce());
  fireEvent.change(source(),{target:{value:'flowchart LR\n  A-->Late\n'}});
  act(()=>native.close!());
  expect(native.exit).not.toHaveBeenCalled();
  await act(async()=>{finishCreate({handle:'handle-close',name:'close.md',text:native.create.mock.calls[0][0].text,revision:1});});
  await waitFor(()=>expect(native.write).toHaveBeenCalledOnce());
  expect(native.write.mock.calls[0][0]).toMatchObject({handle:'handle-close',revision:1});
  expect(native.write.mock.calls[0][0].text).toContain('A-->Late');
  expect(native.exit).not.toHaveBeenCalled();
  await act(async()=>{finishWrite(2);});
  await waitFor(()=>expect(native.exit).toHaveBeenCalledOnce());
});

test('a first save whose created text differs from the invoked snapshot refuses association and retains the draft',async()=>{
  native.create.mockImplementation(async({text}:{text:string})=>({handle:'handle-changed',name:'changed.md',text:text+'\nchanged on disk\n',revision:1}));
  start();
  fireEvent.click(screen.getByRole('button',{name:'New document'}));
  fireEvent.change(source(),{target:{value:'changed draft'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  expect(await screen.findByRole('dialog')).toHaveTextContent('changed during saving');
  expect(screen.getByRole('dialog')).toHaveTextContent('not been associated');
  fireEvent.click(screen.getByRole('button',{name:'OK'}));
  expect(screen.getByRole('tab',{name:'Untitled 1'})).toHaveAttribute('aria-selected','true');
  expect(screen.queryByRole('tab',{name:'changed.md'})).not.toBeInTheDocument();
  expect(source()).toHaveValue('changed draft');
  expect(native.write).not.toHaveBeenCalled();
  const recovery=JSON.parse(localStorage.getItem('orei-drafts-v1')!).documents['Untitled 1'];
  expect(recovery.source).toBe('changed draft');
  expect(recovery.originalMarkdown).not.toContain('changed on disk');

  native.create.mockImplementation(async({text}:{text:string})=>({handle:'handle-retry',name:'retry.md',text,revision:1}));
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(native.create).toHaveBeenCalledTimes(2));
  await waitFor(()=>expect(screen.getByRole('tab',{name:'retry.md'})).toBeInTheDocument());
  expect(native.write).not.toHaveBeenCalled();
});
