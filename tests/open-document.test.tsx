import {afterEach,expect,test,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {App} from '../src/App';
import {ensureFixtures,seedFixtures} from './seed';
import {createMarkdownDocument,parseMarkdownDocument} from '../src/markdown-document';

const native=vi.hoisted(()=>({open:vi.fn(),save:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async(command:string,args?:{text:string})=>command==='open_named_document'?native.open():command==='save_document_copy'?native.save(args):false)}));
vi.mock('@tauri-apps/api/event',()=>({listen:async()=>()=>{}}));
vi.mock('../src/runner',()=>({startRunner:vi.fn()}));
vi.mock('../src/rendering',()=>({renderDiagram:async()=>({svg:'<svg/>',width:100,height:100})}));
afterEach(()=>{cleanup();localStorage.clear();native.open.mockReset();native.save.mockReset();Reflect.deleteProperty(window,'__TAURI_INTERNALS__');});
const start=()=>{ensureFixtures();Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{},configurable:true});return render(<App/>);};
const markdown=createMarkdownDocument({mermaid:'graph TD\n',css:'node { color: red; }\n'});

test('opens a file from an empty workspace without creating an untitled tab',async()=>{
  localStorage.setItem('orei-drafts-v1',JSON.stringify({documents:{},active:''}));
  native.open.mockResolvedValue({handle:'doc-1',name:'example.md',text:markdown,revision:0});
  start();
  expect(screen.getByRole('button',{name:'Save'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Open file'}));
  expect(await screen.findByRole('tab',{name:'example.md'})).toHaveAttribute('aria-selected','true');
  expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n');
  expect(screen.queryByRole('tab',{name:'Untitled 1'})).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Save'})).toBeEnabled();
});

test('opens Markdown beside another draft, edits both blocks, restores, and saves exact surrounding prose',async()=>{
  const original=`---\ntitle: "Example"\ntags: [one, two]\n---\n\nKeep this prose exactly.\n\n${markdown}\nMore prose after the diagram.\n`;
  native.open.mockResolvedValue({handle:'doc-1',name:'example.md',text:original,revision:0});
  const app=start();
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'existing draft'}});
  fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n'));
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'graph TD\n  A-->B\n'}});
  fireEvent.change(screen.getByLabelText('Diagram stylesheet'),{target:{value:'node { color: blue; }\n'}});
  expect(JSON.parse(localStorage.getItem('orei-drafts-v1')!).documents.small.source).toBe('existing draft');
  app.unmount();start();
  expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n  A-->B\n');
  native.save.mockResolvedValue(true);
  fireEvent.click(screen.getByRole('button',{name:'Save Copy'}));
  fireEvent.click(screen.getByRole('button',{name:'Save copy…'}));
  await waitFor(()=>expect(native.save).toHaveBeenCalledOnce());
  const saved=native.save.mock.calls[0][0].text;
  expect(saved).toBe(original.replace('graph TD\n','graph TD\n  A-->B\n').replace('node { color: red; }','node { color: blue; }'));
  expect(parseMarkdownDocument(saved)).toEqual({mermaid:'graph TD\n  A-->B\n',css:'node { color: blue; }\n'});
});

test('save cancellation and failure retain the Markdown draft and recovery',async()=>{
  native.open.mockResolvedValue({handle:'doc-1',name:'example.md',text:markdown,revision:0});
  native.save.mockResolvedValueOnce(false).mockRejectedValueOnce(Error('destination exists'));
  start();fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n'));
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'unfinished'}});
  const before=localStorage.getItem('orei-drafts-v1');
  fireEvent.click(screen.getByRole('button',{name:'Save Copy'}));
  fireEvent.click(screen.getByRole('button',{name:'Save copy…'}));
  await waitFor(()=>expect(native.save).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button',{name:'Save Copy'}));
  fireEvent.click(screen.getByRole('button',{name:'Save copy…'}));
  expect(await screen.findByRole('dialog')).toHaveTextContent('destination exists');
  expect(screen.getByLabelText('Diagram source')).toHaveValue('unfinished');
  expect(localStorage.getItem('orei-drafts-v1')).toBe(before);
});

test('rejects malformed Markdown without changing the workspace',async()=>{
  native.open.mockResolvedValue({handle:'doc-1',name:'unsafe.md',text:'---\ntitle: broken\n\nnot a diagram',revision:0});
  start();const before=localStorage.getItem('orei-drafts-v1');
  fireEvent.click(screen.getByRole('button',{name:'Open'}));
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect(localStorage.getItem('orei-drafts-v1')).toBe(before);
  expect(screen.queryByRole('tab',{name:'unsafe.md'})).not.toBeInTheDocument();
});

test('cancel and native read errors leave drafts intact',async()=>{
  native.open.mockResolvedValueOnce(null).mockRejectedValueOnce(Error('read failed'));
  start();const before=localStorage.getItem('orei-drafts-v1');
  fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(native.open).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button',{name:'Open'}));
  expect(await screen.findByRole('dialog')).toHaveTextContent('read failed');
  expect(localStorage.getItem('orei-drafts-v1')).toBe(before);
});

test('warns when edits arrive while the save picker is open',async()=>{
  let finish!:(saved:boolean)=>void;
  native.save.mockReturnValue(new Promise<boolean>(resolve=>{finish=resolve;}));
  start();fireEvent.click(screen.getByRole('button',{name:'New document'}));
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'before'}});
  fireEvent.click(screen.getByRole('button',{name:'Save Copy'}));
  fireEvent.click(screen.getByRole('button',{name:'Save copy…'}));
  await waitFor(()=>expect(native.save).toHaveBeenCalledOnce());
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'after'}});
  finish(true);
  expect(await screen.findByText(/earlier version/i)).toBeInTheDocument();
  expect(screen.getByLabelText('Diagram source')).toHaveValue('after');
});
