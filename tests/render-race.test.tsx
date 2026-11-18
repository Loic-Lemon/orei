import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {App} from '../src/App';
import {ensureFixtures,seedFixtures} from './seed';
import {fixtures} from '../src/fixtures';
const calls=vi.hoisted(()=>[] as Array<{source:string;resolve:(value:{svg:string;width:number;height:number})=>void;reject:(error:unknown)=>void}>);
vi.mock('../src/rendering',()=>({renderDiagram:(doc:{source:string})=>new Promise((resolve,reject)=>calls.push({source:doc.source,resolve:resolve as (value:{svg:string;width:number;height:number})=>void,reject}))}));
beforeEach(()=>seedFixtures());
afterEach(()=>{cleanup();calls.length=0;});
const result=(label:string)=>({svg:`<svg xmlns="http://www.w3.org/2000/svg"><text>${label}</text></svg>`,width:100,height:100});
test('an older resource preparation cannot replace the latest preview',async()=>{
  render(<App/>);
  await waitFor(()=>expect(calls.length).toBe(1));
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'new revision'}});
  await waitFor(()=>expect(calls.length).toBe(2));
  await act(async()=>calls[1].resolve(result('new')));
  expect(screen.getByTestId('preview').shadowRoot?.textContent).toContain('new');
  await act(async()=>calls[0].resolve(result('old')));
  expect(screen.getByTestId('preview').shadowRoot?.textContent).toContain('new');
  expect(screen.getByRole('button',{name:'Export'})).toBeEnabled();
});

test('line-aware errors retain the preview and navigate to the source line',async()=>{
  const actual=await vi.importActual<typeof import('../src/rendering')>('../src/rendering');
  let rendererError:unknown;
  try{await actual.renderDiagram({...fixtures.small,source:'flowchart LR\n A -->'},{mode:'fixed',width:800});}catch(error){rendererError=error;}
  expect(rendererError).toMatchObject({name:'PeleError',line:2});
  calls.length=0;
  render(<App/>);
  await waitFor(()=>expect(calls.length).toBe(1));
  await act(async()=>calls[0].resolve(result('valid')));
  const editor=screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  fireEvent.change(editor,{target:{value:'flowchart LR\n A -->'}});
  await waitFor(()=>expect(calls.length).toBe(2));
  await act(async()=>calls[1].reject(rendererError));
  expect(screen.getByTestId('preview').shadowRoot?.textContent).toContain('valid');
  expect(screen.getByRole('button',{name:'Export'})).toBeDisabled();
  fireEvent.click(screen.getByRole('radio',{name:'Styling'}));
  fireEvent.click(await screen.findByRole('button',{name:'Go to line 2'},{timeout:3000}));
  expect(editor).toHaveFocus();
  expect(editor.value.slice(editor.selectionStart,editor.selectionEnd)).toBe(' A -->');
});

test('unlocated renderer errors have no line action, and zoom resizes the preview',async()=>{
  render(<App/>);
  await waitFor(()=>expect(calls.length).toBe(1));
  await act(async()=>calls[0].resolve(result('valid')));
  fireEvent.change(screen.getByLabelText('Preview zoom'),{target:{value:'150'}});
  fireEvent.blur(screen.getByLabelText('Preview zoom'));
  const preview=screen.getByTestId('preview');
  expect(preview).toHaveStyle({transform:'scale(1.5)'});
  expect(preview.parentElement).toHaveStyle({width:'150px',height:'150px'});
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'nonsense'}});
  await waitFor(()=>expect(calls.length).toBe(2));
  const actual=await vi.importActual<typeof import('../src/rendering')>('../src/rendering');
  let rendererError:unknown;
  try{await actual.renderDiagram({...fixtures.small,source:'nonsense'},{mode:'fixed',width:800});}catch(error){rendererError=error;}
  expect(rendererError).toMatchObject({name:'PeleError',line:0});
  await act(async()=>calls[1].reject(rendererError));
  await screen.findByText(/Preview out of date/, {}, { timeout: 3000 });
  expect(screen.queryByRole('button',{name:/Go to line/})).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Export'})).toBeDisabled();
});


test('late results from a different tab cannot replace its preview',async()=>{
  render(<App/>);
  await waitFor(()=>expect(calls.length).toBe(1));
  fireEvent.click(screen.getByRole('tab',{name:'medium'}));
  await waitFor(()=>expect(calls.length).toBe(2));
  await act(async()=>calls[1].resolve(result('medium')));
  await act(async()=>calls[0].resolve(result('small late')));
  expect(screen.getByTestId('preview').shadowRoot?.textContent).toContain('medium');
  expect(screen.getByTestId('preview').shadowRoot?.textContent).not.toContain('small late');
});
