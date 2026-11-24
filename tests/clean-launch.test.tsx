import {afterEach,beforeAll,beforeEach,expect,test,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import {App,APP_THEME_KEY} from '../src/App';
import {diagramSchemes} from '../src/diagram-presets';
import {fixtures} from '../src/fixtures';
import {paletteValues} from '../src/palette';
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
  expect(paletteValues(stored.css)).toMatchObject(diagramSchemes.paper.colors);
  expect(JSON.stringify(stored)).not.toContain('fixture:');
  await waitFor(()=>expect(screen.getAllByText('Current preview').length).toBeGreaterThan(0));
  const footer=document.querySelector('.status-bar')!;
  expect(footer.textContent).not.toMatch(/\d+ ms render/);
  expect(screen.getByRole('radio',{name:'Responsive'})).toBeChecked();
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
  expect(screen.getByRole('spinbutton',{name:'Preview zoom'})).toHaveValue(100);
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

test('document controls stay grouped and destination actions remain native menu commands',()=>{
  render(<App/>);
  expect(screen.getByRole('group',{name:'Document commands'})).toContainElement(screen.getByRole('button',{name:'New document'}));
  expect(screen.getByRole('group',{name:'New and save document'})).toContainElement(screen.getByRole('button',{name:'Open'}));
  for(const name of ['New document','Open','Save','Export'])expect(screen.getByRole('button',{name})).toBeInTheDocument();
  for(const name of ['Save As','Save Copy'])expect(screen.queryByRole('button',{name})).not.toBeInTheDocument();
  // Quiet secondary commands share one variant; Save is the single solid command.
  expect(screen.getByRole('button',{name:'New document'}).className).toContain('rt-variant-ghost');
  expect(screen.getByRole('button',{name:'Open'}).className).toContain('rt-variant-ghost');
  expect(screen.getByRole('button',{name:'Save'}).className).toContain('rt-variant-solid');
  expect(screen.getByText('orei').querySelector('svg')).toHaveAttribute('aria-hidden','true');
  // Appearance and Settings live in the native app menu, not the workspace toolbar.
  const toolbar=screen.getByRole('group',{name:'Document commands'});
  expect(within(toolbar).queryByLabelText('App appearance')).not.toBeInTheDocument();
  expect(within(toolbar).queryByRole('button',{name:'Settings'})).not.toBeInTheDocument();
  expect(screen.queryByLabelText('App appearance')).not.toBeInTheDocument();
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
  expect(preview).toHaveStyle({transform:'scale(1)'});
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

test('zoom buttons step immediately and fit returns to automatic zoom',async()=>{
  render(<App/>);
  const zoom=screen.getByRole('spinbutton',{name:'Preview zoom'});
  const fit=screen.getByRole('button',{name:'Fit preview to pane width'});
  await waitFor(()=>expect(screen.getByTestId('preview').shadowRoot?.querySelector('svg')).toBeTruthy());
  expect(fit).toHaveAttribute('aria-pressed','true');
  fireEvent.blur(zoom);
  expect(fit).toHaveAttribute('aria-pressed','true');
  fireEvent.click(screen.getByRole('button',{name:'Zoom in'}));
  expect(zoom).toHaveValue(110);
  expect(fit).toHaveAttribute('aria-pressed','false');
  fireEvent.click(screen.getByRole('button',{name:'Zoom out'}));
  expect(zoom).toHaveValue(100);
  expect(fit).toHaveAttribute('aria-pressed','false');
  fireEvent.click(screen.getByRole('button',{name:'Zoom out'}));
  expect(zoom).toHaveValue(90);
  fireEvent.click(fit);
  expect(zoom).toHaveValue(100);
  expect(fit).toHaveAttribute('aria-pressed','true');
});

test('legacy preview wheel keeps scrolling when one axis hits its limit',()=>{
  vi.stubGlobal('CSS',{supports:()=>false});
  try{
    render(<App/>);
    fireEvent.click(screen.getByRole('radio',{name:'Responsive'}));
    const canvas=screen.getByRole('region',{name:'Preview canvas'});
    Object.defineProperties(canvas,{
      clientWidth:{value:300},scrollWidth:{value:300,configurable:true},
      clientHeight:{value:300},scrollHeight:{value:500},
    });

    fireEvent.wheel(canvas,{deltaX:3,deltaY:40});
    expect(canvas.scrollTop).toBe(40);
    expect(canvas.scrollLeft).toBe(0);

    Object.defineProperty(canvas,'scrollWidth',{value:500});
    canvas.scrollTop=190;
    fireEvent.wheel(canvas,{deltaX:20,deltaY:40});
    expect(canvas.scrollTop).toBe(200);
    expect(canvas.scrollLeft).toBe(20);

    fireEvent.wheel(canvas,{shiftKey:true,deltaY:30});
    expect(canvas.scrollLeft).toBe(50);
    expect(canvas.scrollTop).toBe(200);

    expect(fireEvent.wheel(canvas,{deltaX:10,deltaY:-30})).toBe(true);
  }finally{vi.unstubAllGlobals();}
});

test('the app color scheme stays scoped to workspace surfaces, not the document root',async()=>{
  localStorage.setItem(APP_THEME_KEY,'slate-dark');
  render(<App/>);
  expect(document.documentElement.style.colorScheme).toBe('');
  expect(screen.getByRole('region',{name:'Preview canvas'})).toBeInTheDocument();
  const workspace=document.querySelector('.workspace')!;
  expect(workspace).toHaveAttribute('data-appearance','dark');
  expect(workspace.closest('.radix-themes')).toHaveClass('dark');
  expect(localStorage.getItem(WORKSPACE_VERSION_KEY)).toBe(WORKSPACE_VERSION);
});

test('recovered stylesheets are preserved instead of being replaced by the starter scheme',()=>{
  const custom='.pele {\n  --pele-bg: #101820;\n  --pele-fg: #f0e6d2;\n}\n.note { color: tomato; }';
  localStorage.setItem(DRAFTS_KEY,JSON.stringify({documents:{Recovered:{source:'flowchart LR\n A --> B',css:custom,assets:{}}},active:'Recovered'}));
  localStorage.setItem(WORKSPACE_VERSION_KEY,WORKSPACE_VERSION);
  render(<App/>);
  expect(screen.getByLabelText('Diagram source')).toHaveValue('flowchart LR\n A --> B');
  expect(screen.getByRole('radio',{name:'Styling'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio',{name:'Styling'}));
  expect(screen.getByLabelText('Diagram stylesheet')).toHaveValue(custom);
  expect(paletteValues(custom)).not.toMatchObject(diagramSchemes.paper.colors);
});

test('choosing a diagram color scheme is one undo step and keeps unrelated CSS',async()=>{
  render(<App/>);
  fireEvent.click(screen.getByRole('radio',{name:'Styling'}));
  const stylesheet=screen.getByLabelText('Diagram stylesheet') as HTMLTextAreaElement;
  const original=stylesheet.value;
  fireEvent.click(screen.getByLabelText('Color scheme'));
  await screen.findByRole('listbox');
  fireEvent.click(screen.getByRole('option',{name:/Dusk/}));
  expect(stylesheet.value).toContain(diagramSchemes.dusk.colors['--pele-bg']);
  expect(stylesheet.value).toContain('.pele');
  fireEvent.click(screen.getByRole('button',{name:'Undo'}));
  expect(stylesheet.value).toBe(original);
});
