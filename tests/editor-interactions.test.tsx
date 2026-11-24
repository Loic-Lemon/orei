import {afterEach, beforeAll, beforeEach, expect, test, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import {App} from '../src/App';
import {ensureFixtures,seedFixtures} from './seed';

beforeAll(()=>{Element.prototype.scrollIntoView ??= ()=>{};});
beforeEach(()=>seedFixtures());
afterEach(() => {cleanup();Reflect.deleteProperty(document, 'execCommand');});

test('Tab indents the diagram source and keeps the editor focused', async () => {
  const user = userEvent.setup();
  render(<App/>);
  const editor = screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  editor.focus();
  editor.setSelectionRange(0, 0);
  await user.keyboard('{Tab}');

  expect(editor).toHaveFocus();
  expect(editor.value).toMatch(/^  flowchart/);
  expect(editor.selectionStart).toBe(2);
});

test.each([
  ['Diagram', 'Diagram source', 'flowchart LR\n\t  A --> B'],
  ['Styling', 'Diagram stylesheet', '.pele {\n\t  --pele-bg: #fafafa;'],
])('Enter carries the indentation forward in %s and Undo restores the caret',async(view,label,original)=>{
  const user=userEvent.setup();
  render(<App/>);
  if(view==='Styling')await user.click(screen.getByRole('radio',{name:view}));
  const editor=screen.getByLabelText(label) as HTMLTextAreaElement;
  fireEvent.change(editor,{target:{value:original}});
  editor.focus();
  editor.setSelectionRange(original.length,original.length);
  await user.keyboard('{Enter}');

  expect(editor.value).toBe(original+'\n\t  ');
  expect(editor.selectionStart).toBe(editor.value.length);
  fireEvent.keyDown(editor,{key:'z',metaKey:true});
  expect(editor.value).toBe(original);
  expect(editor.selectionStart).toBe(original.length);
});

test('the gutter counts blank lines and tracks the editor scroll',()=>{
  render(<App/>);
  const editor=screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  fireEvent.change(editor,{target:{value:'flowchart LR\n\n  A --> B\n'}});
  const gutter=editor.closest('.code-editor')!.querySelector('pre')!;
  expect(gutter.textContent).toBe('1\n2\n3\n4');
  expect(gutter).toHaveAttribute('aria-hidden','true');
  editor.scrollLeft=32;
  editor.scrollTop=22;
  fireEvent.scroll(editor);
  expect(gutter.querySelector('span')).toHaveStyle({transform:'translateY(-22px)'});
  expect(editor.closest('.code-editor')!.querySelector('.editor-highlight > span'))
    .toHaveStyle({transform:'translate(-32px, -22px)'});
});

test('syntax colors distinguish Mermaid directions, identifiers, labels and connectors, and CSS values',async()=>{
  const user=userEvent.setup();
  render(<App/>);
  const source=screen.getByLabelText('Diagram source');
  const diagram=[
    'flowchart TD',
    '  A([Mermaid text]) --> B{Supported?}',
    '  B -- Yes --> C["Parse"]',
    '  B -. No .-> H[Fall back]',
    '  C -->|API| D[(SVG)]',
    '  D[Typing a label',
  ].join('\n');
  fireEvent.change(source,{target:{value:diagram}});
  const highlighted=source.closest('.code-editor')!.querySelector('.editor-highlight')!;
  expect(highlighted).toHaveAttribute('aria-hidden','true');
  expect(highlighted.textContent).toBe(diagram);
  const tokens=(kind:string)=>[...highlighted.querySelectorAll(`.tok-${kind}`)].map(token=>token.textContent);
  expect(tokens('keyword')).toEqual(['flowchart']);
  expect(tokens('direction')).toEqual(['TD']);
  expect(tokens('identifier')).toEqual(['A','B','B','C','B','H','C','D','D']);
  expect(tokens('label')).toEqual(['Mermaid text','Supported?','Yes','Parse','No','Fall back','API','SVG','Typing a label']);
  expect(tokens('connector')).toEqual(['-->','-->','.->','-->']);
  expect(source).toHaveValue(diagram);

  await user.click(screen.getByRole('radio',{name:'Styling'}));
  const css=screen.getByLabelText('Diagram stylesheet');
  fireEvent.change(css,{target:{value:'.pele { --pele-bg: #fafafa; }'}});
  const cssHighlight=css.closest('.code-editor')!.querySelector('.editor-highlight')!;
  expect(cssHighlight.querySelector('.tok-variable')).toHaveTextContent('--pele-bg');
  expect(cssHighlight.querySelector('.tok-color')).toHaveTextContent('#fafafa');
});

test('a color scheme preserves custom CSS and can be undone in one step',async()=>{
  const user=userEvent.setup();
  render(<App/>);
  await user.click(screen.getByRole('radio',{name:'Styling'}));
  const css=screen.getByLabelText('Diagram stylesheet') as HTMLTextAreaElement;
  const original=css.value+'\n.pele-node { opacity: .9; }';
  fireEvent.change(css,{target:{value:original}});
  fireEvent.click(screen.getByRole('combobox',{name:'Color scheme'}));
  fireEvent.click(await screen.findByRole('option',{name:'Monochrome'}));
  expect(css.value).toContain('--pele-surface: #ededed;');
  expect(css.value).toContain('.pele-node { opacity: .9; }');
  expect(screen.getByRole('combobox',{name:'Color scheme'})).toHaveTextContent('Monochrome');
  fireEvent.keyDown(css,{key:'z',metaKey:true});
  expect(css.value).toBe(original);
  expect(screen.getByRole('combobox',{name:'Color scheme'})).toHaveTextContent('Custom');
});

test('selecting a template creates a new draft and preserves the current diagram',async()=>{
  const user=userEvent.setup();
  render(<App/>);
  const source=screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  const original=source.value;
  await user.click(screen.getByRole('button',{name:'Templates'}));
  await user.click(screen.getByRole('menuitem',{name:'Sequence diagram'}));
  expect(screen.getByRole('tab',{name:'Untitled 1'})).toHaveAttribute('aria-selected','true');
  expect(source.value).toMatch(/^sequenceDiagram\n/);
  await user.click(screen.getByRole('radio',{name:'Styling'}));
  expect(screen.getByRole('combobox',{name:'Color scheme'})).toHaveTextContent('Paper');
  await user.click(screen.getByRole('radio',{name:'Diagram'}));
  await user.click(screen.getByRole('tab',{name:'small'}));
  expect(source.value).toBe(original);
});

test('Tab and Shift+Tab indent selected CSS lines without replacing their contents', async () => {
  const user = userEvent.setup();
  render(<App/>);
  await user.click(screen.getByRole('radio', {name: 'Styling'}));
  const editor = screen.getByLabelText('Diagram stylesheet') as HTMLTextAreaElement;
  const original = '.pele {\n  --pele-bg: #ffffff;\n}\n';
  fireEvent.change(editor, {target: {value: original}});
  editor.focus();
  editor.setSelectionRange(0, original.length - 2);
  await user.keyboard('{Tab}');
  expect(editor.value).toBe('  .pele {\n    --pele-bg: #ffffff;\n}\n');

  await user.keyboard('{Shift>}{Tab}{/Shift}');
  expect(editor.value).toBe(original);
  expect(editor.selectionStart).toBe(0);
  expect(editor.selectionEnd).toBe(original.length - 2);
});

test('Escape then Tab lets the keyboard leave either editor', async () => {
  const user = userEvent.setup();
  render(<App/>);
  const editor = screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  const original = editor.value;
  editor.focus();
  await user.keyboard('{Escape}{Tab}');
  expect(editor).not.toHaveFocus();
  expect(editor.value).toBe(original);
});

test('toolbar Undo and Redo restore source edits without relying on browser undo', async () => {
  Object.defineProperty(document, 'execCommand', {value: () => false, configurable: true});
  const user = userEvent.setup();
  render(<App/>);
  const editor = screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  const original = editor.value;
  fireEvent.change(editor, {target: {value: 'flowchart LR\n A[Changed] --> B'}});

  await user.click(screen.getByRole('button', {name: 'Undo'}));
  expect(editor.value).toBe(original);
  await user.click(screen.getByRole('button', {name: 'Redo'}));
  expect(editor.value).toBe('flowchart LR\n A[Changed] --> B');
});

test('Command/Ctrl+Z and Shift+Z use the same source history as the toolbar', () => {
  render(<App/>);
  const editor = screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  const original = editor.value;
  fireEvent.change(editor, {target: {value: 'flowchart LR\n A[Keyboard edit] --> B'}});
  fireEvent.keyDown(editor, {key: 'z', metaKey: true});
  expect(editor.value).toBe(original);
  fireEvent.keyDown(editor, {key: 'z', metaKey: true, shiftKey: true});
  expect(editor.value).toContain('Keyboard edit');
  fireEvent.keyDown(editor, {key: 'z', ctrlKey: true});
  expect(editor.value).toBe(original);
});

test('the divider snaps near halfway, holds briefly and releases as dragging continues', () => {
  render(<App/>);
  const divider=screen.getByLabelText('Editor pane width');
  const panes=divider.parentElement!;
  const workspace=panes.parentElement!;
  vi.spyOn(panes,'getBoundingClientRect').mockReturnValue({left:100,width:1000} as DOMRect);
  Object.defineProperty(divider,'setPointerCapture',{value:vi.fn()});
  Object.defineProperty(divider,'releasePointerCapture',{value:vi.fn()});
  fireEvent.pointerDown(divider,{pointerId:1,clientX:504,clientY:100,button:0});
  expect(workspace.style.getPropertyValue('--editor-width')).toBe('50%');
  fireEvent.pointerMove(divider,{pointerId:1,clientX:604,clientY:400});
  expect(workspace.style.getPropertyValue('--editor-width')).toBe('60%');
  fireEvent.pointerMove(divider,{pointerId:1,clientX:510});
  expect(workspace.style.getPropertyValue('--editor-width')).toBe('50%');
  fireEvent.pointerMove(divider,{pointerId:1,clientX:493});
  expect(workspace.style.getPropertyValue('--editor-width')).toBe('50%');
  fireEvent.pointerMove(divider,{pointerId:1,clientX:484});
  expect(workspace.style.getPropertyValue('--editor-width')).toBe('48%');
  fireEvent.pointerUp(divider,{pointerId:1,clientX:484,button:0});
  fireEvent.pointerMove(divider,{pointerId:1,clientX:704});
  expect(workspace.style.getPropertyValue('--editor-width')).toBe('48%');
});

test('double-clicking the divider restores the 50/50 split', () => {
  render(<App/>);
  const divider=screen.getByRole('separator',{name:'Editor pane width'});
  vi.spyOn(divider.parentElement!,'getBoundingClientRect').mockReturnValue({width:1000} as DOMRect);
  fireEvent.keyDown(divider,{key:'End'});
  expect(divider).toHaveAttribute('aria-valuenow','65');
  fireEvent.doubleClick(divider);
  expect(divider).toHaveAttribute('aria-valuenow','50');
});

test('CSS and palette share undo while diagram source keeps a separate history', async () => {
  const user=userEvent.setup();
  render(<App/>);
  const source=screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  const originalSource=source.value;
  fireEvent.change(source,{target:{value:'flowchart LR\n A[Keep source edit] --> B'}});
  await user.click(screen.getByRole('radio',{name:'Styling'}));
  const css=screen.getByLabelText('Diagram stylesheet') as HTMLTextAreaElement;
  const originalCss=css.value;
  fireEvent.change(css,{target:{value:originalCss+'\n/* authored CSS */'}});
  const palette=screen.getByLabelText('--pele-surface value');
  fireEvent.change(palette,{target:{value:'#fef3c7'}});
  fireEvent.keyDown(palette,{key:'z',metaKey:true});
  expect(css.value).toBe(originalCss+'\n/* authored CSS */');
  fireEvent.keyDown(css,{key:'z',metaKey:true});
  expect(css.value).toBe(originalCss);
  await user.click(screen.getByRole('radio',{name:'Diagram'}));
  expect(source.value).toContain('Keep source edit');
  await user.click(screen.getByRole('button',{name:'Undo'}));
  expect(source.value).toBe(originalSource);
});

test('source undo remains attached to its fixture when switching diagrams', async () => {
  const user=userEvent.setup();
  render(<App/>);
  const source=screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  const original=source.value;
  fireEvent.change(source,{target:{value:'flowchart LR\n A[Small edit] --> B'}});
  await user.click(screen.getByRole('tab',{name:'medium'}));
  fireEvent.change(source,{target:{value:'flowchart LR\n A[Medium edit] --> B'}});
  await user.click(screen.getByRole('tab',{name:'small'}));
  await user.click(screen.getByRole('button',{name:'Undo'}));
  expect(source.value).toBe(original);
  await user.click(screen.getByRole('tab',{name:'medium'}));
  expect(source.value).toContain('Medium edit');
});

test('the divider supports arrow keys and stays within its usable bounds', () => {
  render(<App/>);
  const divider=screen.getByRole('separator',{name:'Editor pane width'});
  vi.spyOn(divider.parentElement!,'getBoundingClientRect').mockReturnValue({left:0,width:1000} as DOMRect);
  fireEvent.keyDown(divider,{key:'ArrowRight'});
  expect(divider).toHaveAttribute('aria-valuenow','51');
  fireEvent.keyDown(divider,{key:'End'});
  fireEvent.keyDown(divider,{key:'ArrowRight'});
  expect(divider).toHaveAttribute('aria-valuenow','65');
  fireEvent.keyDown(divider,{key:'Home'});
  expect(divider).toHaveAttribute('aria-valuenow','26');
});

test.each([0,1])('outdenting with the caret at column %i keeps a collapsed caret at the line start', async column => {
  const user=userEvent.setup();
  render(<App/>);
  const editor=screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  fireEvent.change(editor,{target:{value:'  flowchart LR\n A --> B'}});
  editor.focus();editor.setSelectionRange(column,column);
  await user.keyboard('{Shift>}{Tab}{/Shift}');
  expect(editor.value).toBe('flowchart LR\n A --> B');
  expect(editor.selectionStart).toBe(0);
  expect(editor.selectionEnd).toBe(0);
});

test('undo and redo keep the editing position so continued typing stays at the edit', async () => {
  const user=userEvent.setup();
  render(<App/>);
  const editor=screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  const original=editor.value;
  editor.focus();editor.setSelectionRange(0,0);
  await user.keyboard('X');
  await user.keyboard('{Meta>}z{/Meta}');
  expect(editor.value).toBe(original);
  expect(editor.selectionStart).toBe(0);
  expect(editor.selectionEnd).toBe(0);
  await user.keyboard('{Meta>}{Shift>}z{/Shift}{/Meta}');
  expect(editor.selectionStart).toBe(1);
  await user.keyboard('Y');
  expect(editor.value).toBe('XY'+original);
});

test('a palette color gesture is one styling undo step', async () => {
  const user=userEvent.setup();render(<App/>);
  await user.click(screen.getByRole('radio',{name:'Styling'}));
  const css=screen.getByLabelText('Diagram stylesheet') as HTMLTextAreaElement;
  const original=css.value;
  const swatch=screen.getByLabelText('--pele-bg swatch');
  fireEvent.pointerDown(swatch,{pointerId:1});
  fireEvent.change(swatch,{target:{value:'#112233'}});
  fireEvent.change(swatch,{target:{value:'#445566'}});
  fireEvent.pointerUp(swatch,{pointerId:1});
  expect(css.value).toContain('#445566');
  await user.click(screen.getByRole('button',{name:'Undo'}));
  expect(css.value).toBe(original);
});

test('find selects text in the active editor and returns focus', async () => {
  const user=userEvent.setup();render(<App/>);
  const editor=screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  editor.focus();fireEvent.keyDown(editor,{key:'f',metaKey:true});
  const find=await screen.findByLabelText('Find in editor');
  await user.type(find,'flowchart');await user.click(screen.getByRole('button',{name:'Find next'}));
  expect(editor).toHaveFocus();expect(editor.value.slice(editor.selectionStart,editor.selectionEnd)).toBe('flowchart');
});

test('undo during a palette gesture starts a new undo step for subsequent changes', async () => {
  const user=userEvent.setup();render(<App/>);
  await user.click(screen.getByRole('radio',{name:'Styling'}));
  const css=screen.getByLabelText('Diagram stylesheet') as HTMLTextAreaElement;
  const original=css.value;
  const swatch=screen.getByLabelText('--pele-bg swatch');
  fireEvent.pointerDown(swatch,{pointerId:1});
  fireEvent.change(swatch,{target:{value:'#112233'}});
  fireEvent.keyDown(swatch,{key:'z',metaKey:true});
  expect(css.value).toBe(original);
  fireEvent.change(swatch,{target:{value:'#445566'}});
  fireEvent.pointerUp(swatch,{pointerId:1});
  fireEvent.keyDown(swatch,{key:'z',metaKey:true});
  expect(css.value).toBe(original);
});

test('palette remains usable when a variable is missing and its value is cleared', async () => {
  const user=userEvent.setup();render(<App/>);
  await user.click(screen.getByRole('radio',{name:'Styling'}));
  const css=screen.getByLabelText('Diagram stylesheet') as HTMLTextAreaElement;
  fireEvent.change(css,{target:{value:'.pele { color: red; }'}});
  const value=screen.getByLabelText('--pele-bg value');
  expect(value).toBeEnabled();
  fireEvent.change(value,{target:{value:'#123456'}});
  fireEvent.change(value,{target:{value:''}});
  expect(value).toBeEnabled();
  fireEvent.change(value,{target:{value:'#abcdef'}});
  expect(css.value).toContain('#abcdef');
});

test('preview drag pans both axes and stops after release', () => {
  render(<App/>);
  const canvas=screen.getByLabelText('Preview canvas');
  const capture=vi.fn();
  Object.defineProperty(canvas,'setPointerCapture',{value:capture});
  Object.defineProperty(canvas,'releasePointerCapture',{value:vi.fn()});
  canvas.scrollLeft=100;canvas.scrollTop=80;
  fireEvent.pointerDown(canvas,{pointerId:1,button:0,clientX:100,clientY:100});
  expect(capture).not.toHaveBeenCalled();
  fireEvent.pointerMove(canvas,{pointerId:1,clientX:70,clientY:60});
  expect(capture).toHaveBeenCalledWith(1);
  expect(canvas.scrollLeft).toBe(130);expect(canvas.scrollTop).toBe(120);
  fireEvent.pointerUp(canvas,{pointerId:1});
  fireEvent.pointerMove(canvas,{pointerId:1,clientX:0,clientY:0});
  expect(canvas.scrollLeft).toBe(130);expect(canvas.scrollTop).toBe(120);
});

test('double-clicking a preview image opens Diagram and selects its source line', async () => {
  render(<App/>);
  await screen.findByText('Current preview');
  const svg=screen.getByTestId('preview').shadowRoot!.querySelector('svg')!;
  const source=screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  source.style.lineHeight='20px';
  Object.defineProperty(source,'clientHeight',{value:40});
  const original=source.value;
  const styling=screen.getByRole('radio',{name:'Styling'});
  fireEvent.click(styling);

  fireEvent.doubleClick(svg,{composed:true});
  expect(styling).toBeChecked();
  fireEvent.doubleClick(svg.querySelector('image')!,{composed:true});

  expect(screen.getByRole('radio',{name:'Diagram'})).toBeChecked();
  expect(source).toHaveFocus();
  expect(source).toHaveValue(original);
  expect(source.scrollTop).toBeGreaterThan(0);
  expect(source.value.slice(source.selectionStart,source.selectionEnd))
    .toBe(' E --> F@{ img: "assets/local.png", label: "Local image", w: 64, h: 48 }');
});

test('a retained preview cannot navigate an edited source', async () => {
  render(<App/>);
  await screen.findByText('Current preview');
  const node=screen.getByTestId('preview').shadowRoot!.querySelector('[data-id="A"] text')!;
  const source=screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  fireEvent.change(source,{target:{value:`\n\n${source.value}\n F -->`}});
  const styling=screen.getByRole('radio',{name:'Styling'});
  fireEvent.click(styling);

  fireEvent.doubleClick(node,{composed:true});
  expect(styling).toBeChecked();

  await screen.findByText('Preview out of date');
  fireEvent.doubleClick(node,{composed:true});
  expect(styling).toBeChecked();
});

test('duplicate palette declarations pause controls without showing misleading values', async () => {
  const user=userEvent.setup();render(<App/>);
  await user.click(screen.getByRole('radio',{name:'Styling'}));
  const css=screen.getByLabelText('Diagram stylesheet') as HTMLTextAreaElement;
  const duplicate='.pele { --pele-bg: red; --pele-bg: blue; }';
  fireEvent.change(css,{target:{value:duplicate}});
  expect(screen.getByText(/Palette paused/)).toBeVisible();
  expect(screen.queryByLabelText('--pele-bg value')).not.toBeInTheDocument();
  expect(css.value).toBe(duplicate);
  fireEvent.change(css,{target:{value:'.pele { --pele-bg: blue; }'}});
  expect(screen.getByLabelText('--pele-bg value')).toHaveValue('blue');
});

test.each(['pointerCancel','lostPointerCapture','blur'] as const)('interrupted pan stops on %s', event => {
  render(<App/>);
  const canvas=screen.getByLabelText('Preview canvas');
  Object.defineProperty(canvas,'setPointerCapture',{value:vi.fn()});
  canvas.scrollLeft=100;
  fireEvent.pointerDown(canvas,{pointerId:1,button:0,clientX:100});
  fireEvent[event](event==='blur'?window:canvas,{pointerId:1});
  fireEvent.pointerMove(canvas,{pointerId:1,clientX:50});
  expect(canvas.scrollLeft).toBe(100);
});

test.each(['pointerUp','pointerCancel','lostPointerCapture','blur'] as const)('palette gesture ends on %s', async event => {
  const user=userEvent.setup();render(<App/>);
  await user.click(screen.getByRole('radio',{name:'Styling'}));
  const css=screen.getByLabelText('Diagram stylesheet') as HTMLTextAreaElement;
  const original=css.value;
  const swatch=screen.getByLabelText('--pele-bg swatch');
  fireEvent.pointerDown(swatch,{pointerId:1});
  fireEvent.change(swatch,{target:{value:'#112233'}});
  const first=css.value;
  fireEvent[event](swatch,{pointerId:1});
  fireEvent.change(swatch,{target:{value:'#445566'}});
  fireEvent.keyDown(swatch,{key:'z',metaKey:true});
  expect(css.value).toBe(first);
  fireEvent.keyDown(swatch,{key:'z',metaKey:true});
  expect(css.value).toBe(original);
});

test.each([
  ['(', ')', 'Diagram source', 'Diagram'],
  ['[', ']', 'Diagram source', 'Diagram'],
  ['{', '}', 'Diagram stylesheet', 'Styling'],
  ['"', '"', 'Diagram stylesheet', 'Styling'],
  ["'", "'", 'Diagram source', 'Diagram'],
])('typing %s inserts its closer %s in %s', async (open,close,label,view) => {
  const user=userEvent.setup();
  render(<App/>);
  if(view==='Styling')await user.click(screen.getByRole('radio',{name:view}));
  const editor=screen.getByLabelText(label) as HTMLTextAreaElement;
  fireEvent.change(editor,{target:{value:''}});
  editor.focus();
  await user.keyboard(open==='[' || open==='{' ? open.repeat(2) : open);

  expect(editor.value).toBe(open+close);
  expect(editor.selectionStart).toBe(1);
  expect(editor.selectionEnd).toBe(1);
  await user.keyboard('text'+close);
  expect(editor.value).toBe(open+'text'+close);
  expect(editor.selectionStart).toBe(6);
  await user.keyboard('{Backspace}');
  expect(editor.value).toBe(open+'text');
});

test.each([['Backspace',1],['Delete',0]] as const)('paired delimiter deletion with %s keeps the contents and an authored closer',async(key,caret)=>{
  const user=userEvent.setup();
  render(<App/>);
  const editor=screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  fireEvent.change(editor,{target:{value:')'}});
  editor.focus();
  editor.setSelectionRange(0,0);
  await user.keyboard('(text');
  expect(editor.value).toBe('(text))');
  editor.setSelectionRange(caret,caret);
  await user.keyboard(`{${key}}`);
  expect(editor.value).toBe('text)');
  expect(editor.selectionStart).toBe(0);

  fireEvent.keyDown(editor,{key:'z',metaKey:true});
  expect(editor.value).toBe('(text))');
  expect(editor.selectionStart).toBe(caret);
  await user.keyboard(`{${key}}`);
  expect(editor.value).toBe('text)');
});

test('paired delimiter deletion is directional even when the pair is empty',async()=>{
  const user=userEvent.setup();
  render(<App/>);
  const editor=screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  fireEvent.change(editor,{target:{value:''}});
  editor.focus();
  await user.keyboard('({Delete}');
  expect(editor.value).toBe('(');
  await user.keyboard('({Backspace}');
  expect(editor.value).toBe('(');
});

test('paired delimiters keep authored punctuation, apostrophes and escaped quotes literal',async()=>{
  const user=userEvent.setup();
  render(<App/>);
  const editor=screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  fireEvent.change(editor,{target:{value:'()'}});
  editor.focus();
  editor.setSelectionRange(1,1);
  await user.keyboard('{Backspace}');
  expect(editor.value).toBe(')');
  editor.setSelectionRange(0,0);
  await user.keyboard('It\'s \\"');
  expect(editor.value).toBe('It\'s \\"' + ')');
});

test('paired delimiters let a literal quote finish an existing string',async()=>{
  const user=userEvent.setup();
  render(<App/>);
  const editor=screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  fireEvent.change(editor,{target:{value:'A["label]'}});
  editor.focus();
  editor.setSelectionRange(8,8);
  await user.keyboard('"');
  expect(editor.value).toBe('A["label"]');
});
