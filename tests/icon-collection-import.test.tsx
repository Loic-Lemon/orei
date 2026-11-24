import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,expect,test,vi} from 'vitest';
import '@testing-library/jest-dom/vitest';
import {App} from '../src/App';
import {ensureFixtures,seedFixtures} from './seed';

const native=vi.hoisted(()=>({
  open:vi.fn(),prepare:vi.fn(),create:vi.fn(),write:vi.fn(),paired:vi.fn(),copy:vi.fn(),icon:vi.fn(),collection:vi.fn(),text:vi.fn(),exit:vi.fn(async()=>{}),
}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async(command:string,args?:unknown)=>{
  if(command==='open_named_document')return native.open();
  if(command==='prepare_markdown_destination')return native.prepare(args);
  if(command==='create_markdown_document')return native.create(args);
  if(command==='write_markdown_document')return {revision:await native.write(args),published:[]};
  if(command==='write_paired_document')return native.paired(args);
  if(command==='save_markdown_copy')return native.copy(args);
  if(command==='cancel_markdown_destination')return true;
  if(command==='import_icon_file')return native.icon();
  if(command==='import_icon_collection_file')return native.collection();
  if(command==='copy_output_text')return native.text(args);
  if(command==='close_listener_ready')return false;
  if(command==='exit_after_recovery')return native.exit();
})}));
vi.mock('@tauri-apps/api/event',()=>({listen:async()=>()=>{}}));
vi.mock('../src/runner',()=>({startRunner:vi.fn()}));
vi.mock('../src/rendering',()=>({renderDiagram:async()=>({svg:'<svg/>',width:100,height:100})}));

afterEach(()=>{
  cleanup();localStorage.clear();vi.restoreAllMocks();
  native.open.mockReset();native.prepare.mockReset();native.create.mockReset();native.write.mockReset();native.paired.mockReset();
  native.copy.mockReset();native.icon.mockReset();native.collection.mockReset();native.text.mockReset();native.exit.mockReset();
  Reflect.deleteProperty(window,'__TAURI_INTERNALS__');
});

const pack=(overrides:Record<string,unknown>={})=>JSON.stringify({
  prefix:'acme',
  width:24,
  height:24,
  info:{name:'Acme icons',author:{name:'Acme Team'},license:{title:'MIT',spdx:'MIT'}},
  icons:{dot:{body:'<circle cx="12" cy="12" r="6"/>'},rotated:{body:'<path d="M0 0"/>',rotate:1}},
  aliases:{'dot-alias':{parent:'dot'}},
  ...overrides,
});
const start=()=>{native.prepare.mockResolvedValue({destination:'collection-destination',attachments:'../attachments',namespace:'collection-destination'});ensureFixtures();Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{},configurable:true});return render(<App/>);};
const blankTab=()=>{fireEvent.click(screen.getByRole('button',{name:'New document'}));fireEvent.click(screen.getByRole('radio',{name:'Styling'}));};
const collectionButton=()=>screen.getByRole('button',{name:'Import Iconify pack…'});
const search=()=>screen.getByLabelText('Search icons');
const results=()=>screen.getByLabelText('Icon search results');
const storedDocument=()=>JSON.parse(localStorage.getItem('orei-drafts-v1')??'{"documents":{}}').documents['Untitled 1'];
const storedAssets=()=>storedDocument()?.assets??{};
const importedCollections=()=>screen.queryByLabelText('Imported icon collections');

test('imports an Iconify pack and inserts a searched icon with only its used definition',async()=>{
  native.collection.mockResolvedValue({name:'acme.json',text:pack()});
  const view=start();blankTab();
  fireEvent.click(collectionButton());
  await waitFor(()=>expect(screen.getByText(/Imported acme with 3 icons/)).toBeInTheDocument());
  expect(screen.getByText('Acme icons by Acme Team · MIT (MIT)')).toBeInTheDocument();

  fireEvent.change(search(),{target:{value:'acme:dot'}});
  expect(within(results()).getByText('acme:dot',{selector:'code'})).toBeInTheDocument();
  expect(view.container.querySelector('.icon-preview svg')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Insert acme:dot'}));

  expect((screen.getByLabelText('Diagram source') as HTMLTextAreaElement).value).toContain('@{ icon: "acme:dot" }');
  const assets=storedAssets();
  expect(Object.keys(assets)).toEqual(['acme:dot']);
  expect(assets['acme:dot']).toContain('<circle cx="12" cy="12" r="6"/>');
  expect(assets['acme:dot']).toContain('viewBox="0 0 24 24"');
  // The whole pack is never copied into the document.
  expect(Object.keys(assets)).toHaveLength(1);
  expect(screen.getByText(/Inserted @\{ icon: "acme:dot" \} and added acme:dot/)).toBeInTheDocument();
});

test('an imported pack is available offline after a restart, without another file read',async()=>{
  native.collection.mockResolvedValue({name:'acme.json',text:pack()});
  const first=start();blankTab();
  fireEvent.click(collectionButton());
  await waitFor(()=>expect(importedCollections()).toBeInTheDocument());
  first.unmount();

  ensureFixtures();
  render(<App/>);blankTab();
  expect(within(importedCollections()!).getByText('acme',{selector:'code'})).toBeInTheDocument();
  expect(screen.getByText('Acme icons by Acme Team · MIT (MIT)')).toBeInTheDocument();
  fireEvent.change(search(),{target:{value:'acme:dot-alias'}});
  expect(within(results()).getByText('acme:dot-alias',{selector:'code'})).toBeInTheDocument();
  expect(native.collection).toHaveBeenCalledOnce();
});

test('previews the resolved alias and transform body in the search result',async()=>{
  native.collection.mockResolvedValue({name:'acme.json',text:pack()});
  const view=start();blankTab();
  fireEvent.click(collectionButton());
  await waitFor(()=>expect(importedCollections()).toBeInTheDocument());
  fireEvent.change(search(),{target:{value:'acme:rotated'}});
  const preview=view.container.querySelector('.icon-preview svg');
  expect(preview).not.toBeNull();
  expect(preview!.innerHTML).toContain('rotate(90 12 12)');
  fireEvent.change(search(),{target:{value:'acme:dot-alias'}});
  expect(view.container.querySelector('.icon-preview svg')!.innerHTML).toContain('circle');
});

test('a second pack with the same namespace is refused explicitly and nothing changes',async()=>{
  native.collection.mockResolvedValueOnce({name:'acme.json',text:pack()}).mockResolvedValueOnce({name:'acme.json',text:pack()});
  start();blankTab();
  fireEvent.click(collectionButton());
  await waitFor(()=>expect(importedCollections()).toBeInTheDocument());
  fireEvent.click(collectionButton());
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('already imported'));
  expect(screen.getByRole('alert')).toHaveTextContent('nothing was changed');
  expect(within(importedCollections()!).getAllByText('acme',{selector:'code'})).toHaveLength(1);
});

test('malformed and oversized packs are rejected with a clear message and no library change',async()=>{
  native.collection.mockResolvedValueOnce({name:'bad.json',text:'not json'}).mockResolvedValueOnce({name:'huge.json',text:' '.repeat(2*1024*1024+1)});
  start();blankTab();
  fireEvent.click(collectionButton());
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('not valid JSON'));
  fireEvent.click(collectionButton());
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('too large'));
  expect(importedCollections()).not.toBeInTheDocument();
  expect(localStorage.getItem('orei-icon-library-v1')).toBeNull();
});

test('a pack with unsafe icon content is refused at import instead of being stored',async()=>{
  native.collection.mockResolvedValue({name:'bad.json',text:pack({icons:{bad:{body:'<script>alert(1)</script>'}},aliases:{}})});
  start();blankTab();
  fireEvent.click(collectionButton());
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Unsupported icon content'));
  expect(importedCollections()).not.toBeInTheDocument();
});

test('a pack with unsupported metadata imports and documents what was ignored',async()=>{
  native.collection.mockResolvedValue({name:'acme.json',text:pack({chars:{f000:'dot'},categories:{Shapes:['dot']}})});
  start();blankTab();
  fireEvent.click(collectionButton());
  await waitFor(()=>expect(importedCollections()).toBeInTheDocument());
  expect(screen.getByText(/Ignored collection property "chars"/)).toHaveTextContent('font character mappings are not used');
  expect(screen.getByText(/Ignored collection property "categories"/)).toBeInTheDocument();
});

test('the collection namespace can be defined at import and is used for the reference',async()=>{
  native.collection.mockResolvedValue({name:'acme.json',text:pack()});
  start();blankTab();
  fireEvent.change(screen.getByLabelText('Icon collection namespace'),{target:{value:'brand'}});
  fireEvent.click(collectionButton());
  await waitFor(()=>expect(screen.getByText(/Imported brand with 3 icons/)).toBeInTheDocument());
  fireEvent.change(search(),{target:{value:'brand:dot'}});
  fireEvent.click(screen.getByRole('button',{name:'Insert brand:dot'}));
  expect(Object.keys(storedAssets())).toEqual(['brand:dot']);
  expect(screen.getByLabelText('Icon collection namespace')).toHaveValue('');
});

test('copying a reference uses the native text clipboard without adding a definition',async()=>{
  native.collection.mockResolvedValue({name:'acme.json',text:pack()});
  start();blankTab();
  fireEvent.click(collectionButton());
  await waitFor(()=>expect(importedCollections()).toBeInTheDocument());
  fireEvent.change(search(),{target:{value:'acme:dot'}});
  fireEvent.click(screen.getByRole('button',{name:'Copy reference for acme:dot'}));
  await waitFor(()=>expect(native.text).toHaveBeenCalledWith({text:'@{ icon: "acme:dot" }'}));
  expect(screen.getByText(/Copied @\{ icon: "acme:dot" \}/)).toBeInTheDocument();
  expect(storedAssets()).toEqual({});
});

test('bundled icons search and insert without a document copy',async()=>{
  start();blankTab();
  fireEvent.change(search(),{target:{value:'lucide:house'}});
  expect(within(results()).getByText('lucide:house',{selector:'code'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Insert lucide:house'}));
  expect((screen.getByLabelText('Diagram source') as HTMLTextAreaElement).value).toContain('@{ icon: "lucide:house" }');
  expect(storedAssets()).toEqual({});
  expect(screen.getByText(/The bundled collection needs no document copy/)).toBeInTheDocument();
});

test('removing a pack keeps the definitions documents already carry',async()=>{
  native.collection.mockResolvedValue({name:'acme.json',text:pack()});
  start();blankTab();
  fireEvent.click(collectionButton());
  await waitFor(()=>expect(importedCollections()).toBeInTheDocument());
  fireEvent.change(search(),{target:{value:'acme:dot'}});
  fireEvent.click(screen.getByRole('button',{name:'Insert acme:dot'}));
  expect(storedAssets()).toHaveProperty('acme:dot');

  fireEvent.click(screen.getByRole('button',{name:'Remove icon collection acme'}));
  expect(importedCollections()).not.toBeInTheDocument();
  expect(storedAssets()).toHaveProperty('acme:dot');
  expect(JSON.parse(localStorage.getItem('orei-icon-library-v1')!).collections).toEqual([]);
  fireEvent.change(search(),{target:{value:'acme:dot'}});
  expect(screen.queryByLabelText('Icon search results')).not.toBeInTheDocument();
});

test('a recovery failure leaves the source and asset map unchanged',async()=>{
  native.collection.mockResolvedValue({name:'acme.json',text:pack()});
  start();blankTab();
  fireEvent.click(collectionButton());
  await waitFor(()=>expect(importedCollections()).toBeInTheDocument());
  fireEvent.change(search(),{target:{value:'acme:dot'}});
  const source=screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  const before=source.value;
  const setItem=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('full');});
  fireEvent.click(screen.getByRole('button',{name:'Insert acme:dot'}));
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('draft recovery is unavailable'));
  setItem.mockRestore();
  expect(source).toHaveValue(before);
  expect(storedAssets()).toEqual({});
});
