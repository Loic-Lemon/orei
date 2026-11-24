import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {App} from '../src/App';
import {ensureFixtures,seedFixtures} from './seed';
import {fixtures} from '../src/fixtures';

vi.mock('../src/rendering',()=>({renderDiagram:async()=>({svg:'<svg/>',width:100,height:100})}));
const native=vi.hoisted(()=>({close:undefined as (()=>void)|undefined, fail:false, pending:false, exit:vi.fn(async()=>{})}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async(command:string)=>{if(command==='close_listener_ready')return native.pending;if(command==='exit_after_recovery')return native.exit();})}));
vi.mock('@tauri-apps/api/event',()=>({listen:async(name:string,listener:()=>void)=>{
  if(name==='window-close-request'){if(native.fail)throw Error('registration failed');native.close=listener;return()=>{native.close=undefined;};}
  return()=>{};
}}));
vi.mock('../src/runner',()=>({startRunner:vi.fn()}));
beforeEach(()=>seedFixtures());
afterEach(()=>{cleanup();localStorage.clear();vi.restoreAllMocks();Reflect.deleteProperty(window,'__TAURI_INTERNALS__');native.close=undefined;native.fail=false;native.pending=false;native.exit.mockClear();});

test.each([undefined, null, [], {icon:42}])('malformed restored assets %s are preserved without restoring',assets=>{
  const raw=JSON.stringify({documents:{broken:{source:'graph TD',css:'',assets}},active:'broken'});
  localStorage.setItem('orei-drafts-v1',raw);
  render(<App/>);
  expect(screen.getAllByText('Recovery failed').length).toBeGreaterThan(0);
  expect(localStorage.getItem('orei-drafts-v1')).toBe(raw);
});

test.each([[[fixtures.small]], [{'constructor':fixtures.small}], [{'':fixtures.small}]])('invalid document collections are preserved without restoring',documents=>{
  const raw=JSON.stringify({documents,active:'constructor'});
  localStorage.setItem('orei-drafts-v1',raw);
  render(<App/>);
  expect(screen.getAllByText('Recovery failed').length).toBeGreaterThan(0);
  expect(localStorage.getItem('orei-drafts-v1')).toBe(raw);
});

test('an early native close request is handled after listener registration',async()=>{
  Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{},configurable:true});
  native.pending=true;
  render(<App/>);
  await waitFor(()=>expect(native.exit).toHaveBeenCalledOnce());
});

test('restores a consistent active document and immediately persists edits',()=>{
  localStorage.setItem('orei-drafts-v1',JSON.stringify({documents:{one:fixtures.small,two:fixtures.small},active:'missing'}));
  const app=render(<App/>);
  expect(screen.getByRole('tab',{name:'one'})).toHaveAttribute('aria-selected','true');
  fireEvent.click(screen.getByRole('tab',{name:'two'}));
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'unfinished'}});
  app.unmount();
  render(<App/>);
  expect(screen.getByRole('tab',{name:'two'})).toHaveAttribute('aria-selected','true');
  expect(screen.getByLabelText('Diagram source')).toHaveValue('unfinished');
});

test('close requires discard and a failed write offers retry or keeping work',()=>{
  render(<App/>);
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'my draft'}});
  fireEvent.click(screen.getByRole('button',{name:'Close small'}));
  fireEvent.click(screen.getByRole('button',{name:'Keep open'}));
  expect(screen.getByLabelText('Diagram source')).toHaveValue('my draft');
  const write=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('full');});
  fireEvent.click(screen.getByRole('button',{name:'Close small'}));
  fireEvent.click(screen.getByRole('button',{name:'Discard draft'}));
  expect(screen.getByRole('dialog')).toHaveTextContent('The file save or draft recovery could not be completed');
  fireEvent.click(screen.getByRole('button',{name:'Keep open'}));
  expect(screen.getByLabelText('Diagram source')).toHaveValue('my draft');
  write.mockRestore();
  fireEvent.click(screen.getByRole('button',{name:'Close small'}));
  fireEvent.click(screen.getByRole('button',{name:'Discard draft'}));
  expect(screen.queryByRole('tab',{name:'small'})).not.toBeInTheDocument();
});

test('new identities do not collide and view settings and undo stay with their tabs',async()=>{
  render(<App/>);
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'first edit'}});
  fireEvent.click(screen.getByRole('radio',{name:'Styling'}));
  fireEvent.change(screen.getByLabelText('Preview zoom'),{target:{value:'150'}});
  fireEvent.blur(screen.getByLabelText('Preview zoom'));
  fireEvent.click(screen.getByRole('button',{name:'New document'}));
  expect(screen.getByLabelText('Preview zoom')).toHaveValue(100);
  fireEvent.click(screen.getByRole('button',{name:'New document'}));
  expect(screen.getByRole('tab',{name:'Untitled 2'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab',{name:'small'}));
  expect(screen.getByLabelText('Preview zoom')).toHaveValue(150);
  expect(screen.getByRole('radio',{name:'Styling'})).toBeChecked();
  fireEvent.click(screen.getByRole('radio',{name:'Diagram'}));
  fireEvent.click(screen.getByRole('button',{name:'Undo'}));
  expect(screen.getByLabelText('Diagram source')).toHaveValue(fixtures.small.source);
  await waitFor(()=>expect(screen.getByText('Current preview')).toBeInTheDocument());
});

test.each(['{broken',''])('unreadable recovery data is not overwritten: %j',raw=>{
  localStorage.setItem('orei-drafts-v1',raw);
  render(<App/>);
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'edit'}});
  expect(localStorage.getItem('orei-drafts-v1')).toBe(raw);
  expect(screen.getAllByText('Recovery failed').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button',{name:'Close Untitled 1'}));
  fireEvent.click(screen.getByRole('button',{name:'Discard draft'}));
  expect(screen.getByRole('dialog')).toHaveTextContent('Keep the document open');
  expect(screen.queryByRole('button',{name:'Discard anyway'})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Keep open'}));
  expect(screen.getByLabelText('Diagram source')).toHaveValue('edit');
  expect(localStorage.getItem('orei-drafts-v1')).toBe(raw);
});

test('failed discard of the last tab retains its work and existing recovery',()=>{
  localStorage.setItem('orei-drafts-v1',JSON.stringify({documents:{'Untitled 1':fixtures.small},active:'Untitled 1'}));
  render(<App/>);
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'last draft'}});
  const saved=localStorage.getItem('orei-drafts-v1');
  const write=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('full');});
  fireEvent.click(screen.getByRole('button',{name:'Close Untitled 1'}));
  fireEvent.click(screen.getByRole('button',{name:'Discard draft'}));
  expect(screen.getByRole('dialog')).toHaveTextContent('Keep the document open');
  expect(localStorage.getItem('orei-drafts-v1')).toBe(saved);
  fireEvent.click(screen.getByRole('button',{name:'Keep open'}));
  expect(screen.getByLabelText('Diagram source')).toHaveValue('last draft');
  write.mockRestore();
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'last draft with recovery restored'}});
  expect(screen.queryByText('Draft recovery failed')).not.toBeInTheDocument();
  expect(screen.getByRole('tab',{name:'Untitled 1'})).toHaveAccessibleDescription('Draft');
  fireEvent.click(screen.getByRole('button',{name:'Close Untitled 1'}));
  fireEvent.click(screen.getByRole('button',{name:'Discard draft'}));
  expect(screen.queryByLabelText('Diagram source')).not.toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem('orei-drafts-v1')!)).toEqual({documents:{},active:''});
});

test('native close and quit requests flush before closing and retain work on failure',async()=>{
  Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{},configurable:true});
  render(<App/>);
  await waitFor(()=>expect(native.close).toBeDefined());
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'close draft'}});
  const write=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('full');});
  await act(async()=>native.close!());
  expect(native.exit).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toHaveTextContent('Keep the window open');
  fireEvent.click(screen.getByRole('button',{name:'Keep open'}));
  expect(screen.getByLabelText('Diagram source')).toHaveValue('close draft');
  write.mockRestore();
  act(()=>native.close!());
  await waitFor(()=>expect(native.exit).toHaveBeenCalledOnce());
  expect(JSON.parse(localStorage.getItem('orei-drafts-v1')!).documents.small.source).toBe('close draft');
});

test('failure to register the native close listener is visible and keeps work accessible',async()=>{
  Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{},configurable:true});
  native.fail=true;
  render(<App/>);
  expect(await screen.findByRole('dialog')).toHaveTextContent('close handler could not be registered');
  expect(screen.queryByRole('button',{name:'Close without saving'})).not.toBeInTheDocument();
  expect(native.exit).not.toHaveBeenCalled();
});

test('a rejected exit command is reported separately from recovery failure',async()=>{
  Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{},configurable:true});
  native.exit.mockRejectedValueOnce(new Error('exit rejected'));
  render(<App/>);
  await waitFor(()=>expect(native.close).toBeDefined());
  act(()=>native.close!());
  expect(await screen.findByRole('dialog')).toHaveTextContent('The close request failed');
  expect(screen.getByRole('dialog')).not.toHaveTextContent('Recovery could not be saved');
  fireEvent.click(screen.getByRole('button',{name:'Keep open'}));
});
