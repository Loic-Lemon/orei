import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,expect,test,vi} from 'vitest';
import '@testing-library/jest-dom/vitest';
import {App} from '../src/App';
import {ensureFixtures,seedFixtures} from './seed';
import {createMarkdownDocument} from '../src/markdown-document';

const native=vi.hoisted(()=>({open:vi.fn(),create:vi.fn(),write:vi.fn(),paired:vi.fn(),copy:vi.fn(),icon:vi.fn(),exit:vi.fn(async()=>{}),close:undefined as (()=>void)|undefined}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async(command:string,args?:unknown)=>{
  if(command==='open_named_document')return native.open();
  if(command==='create_named_document')return native.create(args);
  if(command==='write_named_document')return native.write(args);
  if(command==='write_paired_document')return native.paired(args);
  if(command==='save_document_copy')return native.copy(args);
  if(command==='import_icon_file')return native.icon();
  if(command==='close_listener_ready')return false;
  if(command==='exit_after_recovery')return native.exit();
})}));
vi.mock('@tauri-apps/api/event',()=>({listen:async(name:string,listener:()=>void)=>{
  if(name==='window-close-request'){native.close=listener;return()=>{native.close=undefined;};}
  return()=>{};
}}));
vi.mock('../src/runner',()=>({startRunner:vi.fn()}));
vi.mock('../src/rendering',()=>({renderDiagram:async()=>({svg:'<svg/>',width:100,height:100})}));

afterEach(()=>{
  cleanup();localStorage.clear();vi.restoreAllMocks();
  native.open.mockReset();native.create.mockReset();native.write.mockReset();native.paired.mockReset();native.copy.mockReset();native.icon.mockReset();native.exit.mockReset();
  native.close=undefined;
  Reflect.deleteProperty(window,'__TAURI_INTERNALS__');
});

const car='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
const van='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 20"><path d="M1 1h30v18H1z"/></svg>';
const start=()=>{ensureFixtures();Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{},configurable:true});return render(<App/>);};
const blankTab=()=>{fireEvent.click(screen.getByRole('button',{name:'New document'}));fireEvent.click(screen.getByRole('radio',{name:'Styling'}));};
const importButton=()=>screen.getByRole('button',{name:'Import SVG…'});
const library=()=>screen.getByLabelText('Imported icons');
const storedAssets=()=>JSON.parse(localStorage.getItem('orei-drafts-v1')!).documents['Untitled 1'].assets;

test('imports an individual SVG into the active draft and exposes its usable reference',async()=>{
  native.icon.mockResolvedValue({name:'car.svg',text:car});
  start();blankTab();
  fireEvent.change(screen.getByLabelText('Icon name'),{target:{value:'Car'}});
  fireEvent.click(importButton());
  await waitFor(()=>expect(screen.getByText(/Imported custom:car/)).toBeInTheDocument());
  expect(within(library()).getByText('custom:car',{selector:'code'})).toBeInTheDocument();
  expect(within(library()).getByText('@{ icon: "custom:car" }')).toBeInTheDocument();
  expect(screen.getByLabelText('Icon name')).toHaveValue('');
  const assets=storedAssets();
  expect(Object.keys(assets)).toEqual(['custom:car']);
  expect(assets['custom:car']).toContain('viewBox="0 0 24 24"');
  expect(assets['custom:car']).toContain('<path d="M0 0h24v24H0z"/>');
});

test('derives the icon name from the picked file when the name is empty and scales the artwork',async()=>{
  native.icon.mockResolvedValue({name:'Delivery Van.svg',text:van});
  start();blankTab();
  fireEvent.click(importButton());
  await waitFor(()=>expect(within(library()).getByText('custom:delivery-van',{selector:'code'})).toBeInTheDocument());
  expect(storedAssets()['custom:delivery-van']).toContain('viewBox="0 0 32 20"');
  expect(storedAssets()['custom:delivery-van']).not.toContain('width="32"');
});

test('a cancelled picker leaves the document intact and reports nothing',async()=>{
  native.icon.mockResolvedValue(null);
  start();blankTab();
  fireEvent.click(importButton());
  await waitFor(()=>expect(native.icon).toHaveBeenCalledOnce());
  expect(screen.queryByLabelText('Imported icons')).not.toBeInTheDocument();
  expect(storedAssets()).toEqual({});
  expect(screen.queryByText(/Imported /)).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('unsafe SVG content is rejected clearly and leaves an existing icon intact',async()=>{
  native.icon.mockResolvedValueOnce({name:'car.svg',text:car}).mockResolvedValueOnce({name:'bad.svg',text:'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'});
  start();blankTab();
  fireEvent.click(importButton());
  await waitFor(()=>expect(within(library()).getByText('custom:car',{selector:'code'})).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('Icon name'),{target:{value:'bad'}});
  fireEvent.click(importButton());
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Unsupported icon content'));
  expect(Object.keys(storedAssets())).toEqual(['custom:car']);
  expect(within(library()).queryByText('custom:bad',{selector:'code'})).not.toBeInTheDocument();
});

test('a naming collision is explicit and preserves the original icon body',async()=>{
  native.icon.mockResolvedValueOnce({name:'car.svg',text:car}).mockResolvedValueOnce({name:'car.svg',text:van});
  start();blankTab();
  fireEvent.click(importButton());
  await waitFor(()=>expect(within(library()).getByText('custom:car',{selector:'code'})).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('Icon name'),{target:{value:'car'}});
  fireEvent.click(importButton());
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('already exists'));
  expect(screen.getByRole('alert')).toHaveTextContent('nothing was changed');
  expect(storedAssets()['custom:car']).toContain('viewBox="0 0 24 24"');
  expect(within(library()).getAllByText('custom:car',{selector:'code'})).toHaveLength(1);
});

test('first Save is refused while imported icons exist and succeeds after they are removed',async()=>{
  native.icon.mockResolvedValue({name:'car.svg',text:car});
  native.create.mockImplementation(async({text}:{text:string})=>({handle:'handle-icon',name:'note.md',text,revision:1}));
  native.write.mockResolvedValue(2);
  start();blankTab();
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'flowchart LR\n  A-->B\n'}});
  fireEvent.click(importButton());
  await waitFor(()=>expect(within(library()).getByText('custom:car',{selector:'code'})).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  expect(await screen.findByRole('dialog')).toHaveTextContent('Markdown asset storage is not specified yet');
  expect(screen.getByRole('dialog')).toHaveTextContent("draft's local recovery");
  expect(native.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'OK'}));
  expect(storedAssets()).toHaveProperty('custom:car');
  expect(screen.getByLabelText('Diagram source')).toHaveValue('flowchart LR\n  A-->B\n');

  fireEvent.click(screen.getByRole('button',{name:'Remove icon custom:car'}));
  expect(storedAssets()).toEqual({});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(native.create).toHaveBeenCalledOnce());
  expect(native.create.mock.calls[0][0].text).toContain('A-->B');
  await waitFor(()=>expect(screen.getByRole('tab',{name:'note.md'})).toHaveAttribute('aria-selected','true'));
});

test('importing into an opened file pauses autosave instead of dropping the icon',async()=>{
  const markdown=createMarkdownDocument({mermaid:'graph TD\n',css:'node { color: red; }\n'});
  native.open.mockResolvedValue({handle:'handle-open',name:'named.md',text:markdown,revision:3});
  native.icon.mockResolvedValue({name:'car.svg',text:car});
  native.write.mockResolvedValue(4);
  start();
  fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n'));
  fireEvent.click(screen.getByRole('radio',{name:'Styling'}));
  fireEvent.click(importButton());
  await waitFor(()=>expect(within(library()).getByText('custom:car',{selector:'code'})).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button',{name:'OK'}));
  expect(screen.getByText('Save paused')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'graph TD\n  A-->B\n'}});
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,900));});
  expect(native.write).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button',{name:'Remove icon custom:car'}));
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'graph TD\n  A-->C\n'}});
  await waitFor(()=>expect(native.write).toHaveBeenCalled(),{timeout:2500});
  expect(native.write.mock.calls.at(-1)![0].text).toContain('A-->C');
});

test('an import is refused while a first save is still choosing its destination',async()=>{
  let finish!:(opened:null)=>void;
  native.create.mockImplementation(()=>new Promise<null>(resolve=>{finish=resolve;}));
  start();blankTab();
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(native.create).toHaveBeenCalledOnce());
  fireEvent.click(importButton());
  expect(screen.getByRole('alert')).toHaveTextContent('first save is still in progress');
  expect(native.icon).not.toHaveBeenCalled();
  await act(async()=>{finish(null);});
});

test('a rejected import leaves the library intact when draft recovery cannot record it',async()=>{
  native.icon.mockResolvedValue({name:'car.svg',text:car});
  start();blankTab();
  const before=localStorage.getItem('orei-drafts-v1');
  const setItem=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('full');});
  fireEvent.click(importButton());
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('draft recovery is unavailable'));
  expect(screen.queryByLabelText('Imported icons')).not.toBeInTheDocument();
  setItem.mockRestore();
  expect(JSON.parse(localStorage.getItem('orei-drafts-v1')!).documents['Untitled 1'].assets).toEqual({});
  expect(before).toContain('"Untitled 1"');
});

test('imported icons reopen from local draft recovery without the original file',async()=>{
  native.icon.mockResolvedValue({name:'car.svg',text:car});
  const first=start();blankTab();
  fireEvent.click(importButton());
  await waitFor(()=>expect(within(library()).getByText('custom:car',{selector:'code'})).toBeInTheDocument());
  first.unmount();
  ensureFixtures();
  render(<App/>);
  expect(screen.getByRole('tab',{name:'Untitled 1'})).toHaveAttribute('aria-selected','true');
  fireEvent.click(screen.getByRole('radio',{name:'Styling'}));
  expect(within(library()).getByText('custom:car',{selector:'code'})).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a paired Mermaid document embeds an imported icon in its asset index instead of pausing',async()=>{
  const source='flowchart LR\n  A-->B\n';
  native.open.mockResolvedValue({handle:'pair-icon',base:'icons',source_name:'icons.mmd',source,css_name:null,css:null,assets_name:null,assets:null,revisions:{source:1,css:null,assets:null}});
  native.icon.mockResolvedValue({name:'car.svg',text:car});
  native.paired.mockResolvedValue({revisions:{source:2,css:null,assets:1},written:['source','asset index'],failure:null});
  start();
  fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(screen.getByLabelText('Diagram source')).toHaveValue(source));
  fireEvent.click(screen.getByRole('radio',{name:'Styling'}));
  fireEvent.click(importButton());
  await waitFor(()=>expect(within(library()).getByText('custom:car',{selector:'code'})).toBeInTheDocument());
  // The standalone-Markdown asset gate must not pause a paired document: it can carry the icon.
  expect(screen.queryByText('Save paused')).not.toBeInTheDocument();
  expect(screen.queryByText(/File autosave is paused/)).not.toBeInTheDocument();
  await waitFor(()=>expect(native.paired).toHaveBeenCalled(),{timeout:2500});
  const index=JSON.parse(native.paired.mock.calls[0][0].assets);
  expect(index.assets['custom:car']).toMatchObject({kind:'icon',mediaType:'image/svg+xml',encoding:'text'});
  expect(index.assets['custom:car'].data).toContain('viewBox="0 0 24 24"');
});
