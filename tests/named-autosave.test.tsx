import {afterEach,expect,test,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {App} from '../src/App';
import {ensureFixtures,seedFixtures} from './seed';
import {createMarkdownDocument} from '../src/markdown-document';

const native=vi.hoisted(()=>({open:vi.fn(),write:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async(command:string,args?:{handle:string;revision:number;text:string})=>command==='open_named_document'?native.open():command==='write_markdown_document'?{revision:await native.write(args),published:[]}:false)}));
vi.mock('@tauri-apps/api/event',()=>({listen:async()=>()=>{}}));
vi.mock('../src/runner',()=>({startRunner:vi.fn()}));
vi.mock('../src/rendering',()=>({renderDiagram:async()=>({svg:'<svg/>',width:100,height:100})}));
afterEach(()=>{cleanup();localStorage.clear();native.open.mockReset();native.write.mockReset();Reflect.deleteProperty(window,'__TAURI_INTERNALS__');});
const start=()=>{ensureFixtures();Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{},configurable:true});return render(<App/>);};
const markdown=createMarkdownDocument({mermaid:'graph TD\n',css:'node { color: red; }\n'});

test('opening a named document does not write it; edits autosave Markdown with the expected revision',async()=>{
  const original=`---\ntitle: "Example"\n---\n\nKeep this prose exactly.\n\n${markdown}\nMore prose after the diagram.\n`;
  native.open.mockResolvedValue({handle:'doc-1',name:'example.md',text:original,revision:7});
  native.write.mockImplementation(async({text}:{text:string})=>{expect(localStorage.getItem('orei-drafts-v1')).not.toBeNull();return 8;});
  start();fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n'));
  expect(native.write).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'graph TD\n  A-->B\n'}});
  await waitFor(()=>expect(native.write).toHaveBeenCalledOnce(),{timeout:2500});
  const args=native.write.mock.calls[0][0];
  expect(args).toMatchObject({handle:'doc-1',revision:7});
  expect(args.text).toContain('Keep this prose exactly.');
  expect(args.text).toContain('More prose after the diagram.');
  expect(args.text).toContain('A-->B');
});

test('rejected named-document write keeps editor content and persisted recovery',async()=>{
  native.open.mockResolvedValue({handle:'doc-1',name:'example.md',text:markdown,revision:2});
  native.write.mockRejectedValue(Error('revision conflict'));
  start();fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n'));
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'unsaved edit'}});
  await waitFor(()=>expect(native.write).toHaveBeenCalledOnce(),{timeout:2500});
  expect(screen.getByLabelText('Diagram source')).toHaveValue('unsaved edit');
  expect(localStorage.getItem('orei-drafts-v1')).not.toBeNull();
});

test('undo after an edit autosaves the reverted Markdown',async()=>{
  native.open.mockResolvedValue({handle:'doc-1',name:'example.md',text:markdown,revision:2});
  native.write.mockResolvedValue(3);
  start();fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n'));
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'graph TD\n  A-->B\n'}});
  await waitFor(()=>expect(native.write).toHaveBeenCalledOnce(),{timeout:2500});
  fireEvent.click(screen.getByRole('button',{name:'Undo'}));
  await waitFor(()=>expect(native.write).toHaveBeenCalledTimes(2),{timeout:2500});
  expect(native.write.mock.calls[1][0]).toMatchObject({handle:'doc-1',revision:3});
  expect(native.write.mock.calls[1][0].text).toContain('graph TD\n');
  expect(native.write.mock.calls[1][0].text).not.toContain('A-->B');
});

test('closing a named tab waits for its write and keeps it open when the write rejects',async()=>{
  native.open.mockResolvedValue({handle:'doc-1',name:'example.md',text:markdown,revision:2});
  let rejectWrite!:(error:Error)=>void;
  native.write.mockImplementation(()=>new Promise((_,reject)=>{rejectWrite=reject;}));
  start();fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n'));
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'pending edit'}});
  await waitFor(()=>expect(native.write).toHaveBeenCalledOnce(),{timeout:2500});
  fireEvent.click(screen.getByRole('button',{name:'Close example.md'}));
  fireEvent.click(screen.getByRole('button',{name:'Discard draft'}));
  await waitFor(()=>expect(screen.getByRole('dialog')).toHaveTextContent('Close example.md?'));
  expect(screen.getByRole('dialog')).toHaveTextContent('Close example.md?');
  rejectWrite(Error('write failed'));
  await waitFor(()=>expect(screen.getByRole('dialog')).toHaveTextContent('The file save or draft recovery could not be completed'));
  expect(screen.getByRole('dialog')).toHaveTextContent('Keep the document open');
});
