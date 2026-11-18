import {afterEach,beforeAll,beforeEach,expect,test,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import {App} from '../src/App';
import {fixtures} from '../src/fixtures';
import {DRAFTS_KEY, WORKSPACE_VERSION, WORKSPACE_VERSION_KEY} from '../src/workspace';

vi.mock('../src/rendering',()=>({renderDiagram:async()=>({svg:'<svg><text>Clean</text></svg>',width:100,height:100})}));
vi.mock('../src/runner',()=>({startRunner:vi.fn()}));

beforeAll(()=>{Element.prototype.scrollIntoView ??= ()=>{};});
beforeEach(()=>localStorage.clear());
afterEach(()=>{cleanup();localStorage.clear();Reflect.deleteProperty(window,'__TAURI_INTERNALS__');});

const tab=(name:string)=>screen.getByRole('tab',{name});

test('clean launch opens one Untitled 1 with no sample assets or sample tabs',async()=>{
  render(<App/>);
  expect(tab('Untitled 1')).toHaveAttribute('aria-selected','true');
  expect(screen.queryByRole('tab',{name:'small'})).not.toBeInTheDocument();
  expect(screen.queryByRole('tab',{name:'medium'})).not.toBeInTheDocument();
  expect(screen.getByLabelText('Diagram source')).toHaveValue('flowchart TD\n  A[Start] --> B[End]');
  const stored=JSON.parse(localStorage.getItem(DRAFTS_KEY)!).documents['Untitled 1'];
  expect(stored.assets).toEqual({});
  expect(JSON.stringify(stored)).not.toContain('fixture:');
  await waitFor(()=>expect(screen.getAllByText('Current preview').length).toBeGreaterThan(0));
  const footer=document.querySelector('.status-bar')!;
  expect(footer.textContent).not.toMatch(/\d+ ms render/);
});

test('saving a template as a draft completes recovery and clears the pending badge',async()=>{
  const user=userEvent.setup();
  render(<App/>);
  await user.click(screen.getByRole('button',{name:'Templates'}));
  await user.click(screen.getByRole('menuitem',{name:'Sequence diagram'}));
  expect(JSON.parse(localStorage.getItem(DRAFTS_KEY)!).documents['Untitled 2'].source).toMatch(/^sequenceDiagram/);
  expect(screen.queryByText('Drafts saved locally')).not.toBeInTheDocument();
  expect(tab('Untitled 2')).toHaveAccessibleDescription('Draft');
  expect(screen.queryByText('Recovery pending')).not.toBeInTheDocument();
});

test('closing the last tab leaves an empty workspace across relaunch and New starts a fresh diagram',async()=>{
  const app=render(<App/>);
  fireEvent.click(screen.getByRole('button',{name:'Close Untitled 1'}));
  fireEvent.click(screen.getByRole('button',{name:'Discard draft'}));
  const empty=()=>screen.getByRole('region',{name:'No documents open'});
  expect(screen.queryByRole('tablist',{name:'Document tabs'})).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Diagram source')).not.toBeInTheDocument();
  expect(within(empty()).getByRole('button',{name:'Open file'})).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem(DRAFTS_KEY)!)).toEqual({documents:{},active:''});
  app.unmount();

  render(<App/>);
  fireEvent.click(within(empty()).getByRole('button',{name:'New diagram'}));
  expect(tab('Untitled 1')).toHaveAttribute('aria-selected','true');
  expect(screen.getByLabelText('Diagram source')).toHaveValue('flowchart TD\n  A[Start] --> B[End]');
  expect(await screen.findByText('Current preview')).toBeInTheDocument();
});

test('the renderer starts on Preview and keeps the canvas when using Pele Docs',async()=>{
  const user=userEvent.setup();
  render(<App/>);
  const viewTabs=within(screen.getByRole('tablist',{name:'Preview pane view'}));
  const previewTab=viewTabs.getByRole('tab',{name:/^Preview/});
  const docsTab=viewTabs.getByRole('tab',{name:/^Docs/});
  const preview=screen.getByTestId('preview');
  await waitFor(()=>expect(preview.shadowRoot?.querySelector('svg')).toBeTruthy());
  const svg=preview.shadowRoot?.querySelector('svg');
  expect(previewTab).toHaveAttribute('aria-selected','true');
  expect(screen.queryByTitle('Pele documentation')).not.toBeInTheDocument();

  await user.click(docsTab);
  expect(docsTab).toHaveAttribute('aria-selected','true');
  const docs=within(screen.getByRole('tabpanel',{name:/^Docs/})).getByTitle('Pele documentation');
  expect(docs).toHaveAttribute('src','https://pele.run/');
  expect(docs).toHaveAttribute('sandbox','');
  expect(screen.queryByRole('region',{name:'Preview canvas'})).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Doc sections'}));
  await user.click(screen.getByRole('menuitem',{name:'Theming'}));
  expect(docs).toHaveAttribute('src','https://pele.run/theming');

  await user.click(previewTab);
  expect(previewTab).toHaveAttribute('aria-selected','true');
  expect(screen.getByRole('region',{name:'Preview canvas'})).toContainElement(preview);
  expect(preview.shadowRoot?.querySelector('svg')).toBe(svg);
  expect(screen.getByRole('spinbutton',{name:'Preview zoom'})).toHaveValue(115);
  await user.click(docsTab);
  expect(screen.getByTitle('Pele documentation')).toBe(docs);
  expect(docs).toHaveAttribute('src','https://pele.run/theming');
});

test('evidence runs request samples explicitly without replacing normal drafts',async()=>{
  render(<App/>);
  const normal=localStorage.getItem(DRAFTS_KEY);
  window.dispatchEvent(new CustomEvent('orei-evidence-samples',{detail:{documents:fixtures,active:'small'}}));
  await waitFor(()=>expect(screen.getByRole('tab',{name:'small'})).toBeInTheDocument());
  expect(screen.getByRole('tab',{name:'small'})).toHaveAttribute('aria-selected','true');
  expect(screen.getByLabelText('Diagram source')).toHaveValue(fixtures.small.source);
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'evidence edit'}});
  expect(localStorage.getItem(DRAFTS_KEY)).toBe(normal);
});

test('document controls stay grouped and discoverable',()=>{
  render(<App/>);
  expect(screen.getByRole('group',{name:'Document commands'})).toContainElement(screen.getByRole('button',{name:'New document'}));
  expect(screen.getByRole('group',{name:'New and save document'})).toContainElement(screen.getByRole('button',{name:'Open'}));
  expect(screen.getByRole('group',{name:'Save to another destination'})).toContainElement(screen.getByRole('button',{name:'Save As'}));
  for(const name of ['New document','Open','Save','Save As','Save Copy','Export'])expect(screen.getByRole('button',{name})).toBeInTheDocument();
  // Quiet secondary commands share one variant; Save is the single solid command.
  expect(screen.getByRole('button',{name:'New document'}).className).toContain('rt-variant-ghost');
  expect(screen.getByRole('button',{name:'Open'}).className).toContain('rt-variant-ghost');
  expect(screen.getByRole('button',{name:'Save'}).className).toContain('rt-variant-solid');
  expect(screen.getByRole('button',{name:'Save As'}).className).toContain('rt-variant-ghost');
  expect(screen.getByRole('button',{name:'Save Copy'}).className).toContain('rt-variant-ghost');
  // Appearance sits with the header settings, outside the command group, and remains reachable.
  const settings=screen.getByLabelText('App appearance').closest('.toolbar-settings');
  expect(settings).not.toBeNull();
  expect(settings!.closest('.toolbar')).toBeNull();
});

test('inactive tabs use quiet dots and hide routine status text from sight',async()=>{
  render(<App/>);
  fireEvent.click(screen.getByRole('button',{name:'New document'}));
  const inactive=tab('Untitled 1');
  const active=tab('Untitled 2');
  expect(active).toHaveAttribute('aria-selected','true');
  expect(inactive).toHaveAttribute('aria-describedby');
  const inactiveStatus=document.getElementById(inactive.getAttribute('aria-describedby')!)!;
  expect(inactiveStatus).toHaveClass('visually-hidden');
  expect(within(inactive.parentElement!).getByText('Draft')).toBe(inactiveStatus);
  const activeStatus=document.getElementById(active.getAttribute('aria-describedby')!)!;
  expect(activeStatus).not.toHaveClass('visually-hidden');
  for(const name of ['Untitled 1','Untitled 2']){
    expect(tab(name).parentElement!.querySelector('.status-dot')).not.toBeNull();
  }
});

test('tabs use selection semantics and arrow keys move between them',async()=>{
  render(<App/>);
  fireEvent.click(screen.getByRole('button',{name:'New document'}));
  expect(tab('Untitled 2')).toHaveAttribute('aria-selected','true');
  expect(tab('Untitled 2')).toHaveAttribute('aria-controls','document-panel');
  expect(screen.getByRole('tabpanel',{name:'Untitled 2'})).toHaveAttribute('id','document-panel');
  tab('Untitled 2').focus();
  fireEvent.keyDown(tab('Untitled 2'),{key:'ArrowLeft'});
  await waitFor(()=>expect(tab('Untitled 1')).toHaveFocus());
  expect(tab('Untitled 1')).toHaveAttribute('aria-selected','true');
  fireEvent.keyDown(tab('Untitled 1'),{key:'End'});
  await waitFor(()=>expect(tab('Untitled 2')).toHaveFocus());
});

test('Icons and Local images start collapsed and the editor describes its shortcuts',()=>{
  render(<App/>);
  fireEvent.click(screen.getByRole('radio',{name:'Styling'}));
  expect(screen.getByText('Icons',{selector:'summary'}).closest('details')).not.toHaveAttribute('open');
  expect(screen.getByText('Local images',{selector:'summary'}).closest('details')).not.toHaveAttribute('open');
  expect(screen.getByLabelText('Diagram source')).toHaveAccessibleDescription(/Tab indents/);
});

test('zoom keeps raw typing until commit, steps by 5 and clamps',()=>{
  render(<App/>);
  const zoom=screen.getByLabelText('Preview zoom');
  const preview=screen.getByTestId('preview');
  fireEvent.change(zoom,{target:{value:'15'}});
  expect(zoom).toHaveValue(15);
  expect(preview).toHaveStyle({transform:'scale(1.15)'});
  fireEvent.keyDown(zoom,{key:'Enter'});
  expect(zoom).toHaveValue(25);
  expect(preview).toHaveStyle({transform:'scale(0.25)'});
  fireEvent.change(zoom,{target:{value:'999'}});
  expect(zoom).toHaveValue(999);
  fireEvent.blur(zoom);
  expect(zoom).toHaveValue(200);
  expect(preview).toHaveStyle({transform:'scale(2)'});
  fireEvent.change(zoom,{target:{value:'150'}});
  fireEvent.keyDown(zoom,{key:'ArrowUp'});
  expect(zoom).toHaveValue(155);
  expect(preview).toHaveStyle({transform:'scale(1.55)'});
  fireEvent.keyDown(zoom,{key:'ArrowUp'});
  expect(zoom).toHaveValue(160);
  fireEvent.change(zoom,{target:{value:'25'}});
  fireEvent.keyDown(zoom,{key:'ArrowDown'});
  expect(zoom).toHaveValue(25);
  fireEvent.keyDown(zoom,{key:'Escape'});
  expect(zoom).toHaveValue(25);
});

test('color-scheme follows the selected app appearance and the preview is a region',async()=>{
  render(<App/>);
  expect(document.documentElement.style.colorScheme).toBe('light');
  expect(screen.getByRole('region',{name:'Preview canvas'})).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('App appearance'));
  await screen.findByRole('listbox');
  fireEvent.click([...screen.getAllByRole('option')].find(option=>option.textContent==='Dark')!);
  await waitFor(()=>expect(document.documentElement.style.colorScheme).toBe('dark'));
  expect(localStorage.getItem(WORKSPACE_VERSION_KEY)).toBe(WORKSPACE_VERSION);
});
