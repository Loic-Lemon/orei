import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {App,APP_THEME_KEY} from '../src/App';
import {ensureFixtures,seedFixtures} from './seed';

const native = vi.hoisted(() => ({
  enabled: false,
  deferred: false,
  pending: [] as Array<() => void>,
  listeners: new Set<() => void>(),
  settingsListeners: new Set<() => void>(),
  editListeners: new Set<(event:{payload:'undo'|'redo'}) => void>(),
  undoEnabled: false,
  redoEnabled: false,
  preferences: {defaultNotesFolder:null as string|null,defaultAttachmentsFolder:null as string|null},
  pickedFolder: null as string|null,
  preferenceWrites: [] as unknown[],
  deferPreferences: false,
  preferenceCompletions: [] as Array<() => void>,
}));

vi.mock('@tauri-apps/api/window',()=>({getCurrentWindow:()=>({onCloseRequested:async()=>()=>{}})}));
vi.mock('../src/runner', () => ({startRunner: vi.fn()}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: {enabled: boolean;undo:boolean;redo:boolean;preferences?:typeof native.preferences}) => {
    if (command === 'set_export_enabled') native.enabled = args!.enabled;
    if (command === 'set_edit_enabled') {native.undoEnabled=args!.undo;native.redoEnabled=args!.redo;}
    if (command === 'get_markdown_preferences') return native.preferences;
    if (command === 'set_markdown_preferences') {
      native.preferenceWrites.push(args!.preferences);
      if(native.deferPreferences)await new Promise<void>(resolve=>native.preferenceCompletions.push(resolve));
      native.preferences=args!.preferences!;
    }
    if (command === 'pick_folder') return native.pickedFolder;
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, listener: () => void) => {
    if (native.deferred) await new Promise<void>(resolve => native.pending.push(resolve));
    if(name==='document-request'||name==='window-close-request')return () => {};
    if(name==='edit-request'){
      native.editListeners.add(listener);
      return () => native.editListeners.delete(listener);
    }
    if(name==='settings-request'){
      native.settingsListeners.add(listener);
      return () => native.settingsListeners.delete(listener);
    }
    native.listeners.add(listener);
    return () => native.listeners.delete(listener);
  }),
}));

beforeEach(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {value: {}, configurable: true});
  native.enabled = false;
  native.deferred = false;
  native.pending.length = 0;
  native.listeners.clear();
  native.settingsListeners.clear();
  native.editListeners.clear();
  native.undoEnabled=false;native.redoEnabled=false;
  native.preferences={defaultNotesFolder:null,defaultAttachmentsFolder:null};native.pickedFolder=null;native.preferenceWrites.length=0;
  native.deferPreferences=false;native.preferenceCompletions.length=0;
  localStorage.removeItem(APP_THEME_KEY);
  seedFixtures();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

test('native Export availability agrees with the current preview', async () => {
  render(<App/>);
  await screen.findByText('Current preview');
  await waitFor(() => expect(native.enabled).toBe(true), {timeout: 1000});

  fireEvent.change(screen.getByLabelText('Diagram source'), {target: {value: 'not a diagram'}});
  await screen.findByText(/Preview out of date/, {}, { timeout: 3000 });
  await waitFor(() => expect(native.enabled).toBe(false));
  expect(screen.getByRole('button', {name: 'Export'})).toBeDisabled();
});

test('a late native menu subscription cannot open export for stale content', async () => {
  native.deferred = true;
  render(<App/>);
  await screen.findByText('Current preview');
  await waitFor(() => expect(native.pending.length).toBeGreaterThan(0));

  fireEvent.change(screen.getByLabelText('Diagram source'), {target: {value: 'not a diagram'}});
  await screen.findByText(/Preview out of date/, {}, { timeout: 3000 });
  await act(async () => {
    for (const resolve of native.pending.splice(0)) resolve();
  });
  act(() => { for (const listener of native.listeners) listener(); });

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('closing the app releases a native subscription that finishes registering late', async () => {
  native.deferred = true;
  const app = render(<App/>);
  await screen.findByText('Current preview');
  await waitFor(() => expect(native.pending.length).toBeGreaterThan(0));

  app.unmount();
  await act(async () => {
    for (const resolve of native.pending.splice(0)) resolve();
  });

  expect(native.listeners.size).toBe(0);
  expect(native.editListeners.size).toBe(0);
});

test('native Undo and Redo use the current document history and expose availability', async () => {
  render(<App/>);
  await screen.findByText('Current preview');
  const editor=screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  const original=editor.value;
  fireEvent.change(editor,{target:{value:'flowchart LR\n A[Native edit] --> B'}});
  await waitFor(()=>expect(native.undoEnabled).toBe(true));
  expect(native.redoEnabled).toBe(false);
  act(()=>{for(const listener of native.editListeners)listener({payload:'undo'});});
  expect(editor.value).toBe(original);
  await waitFor(()=>expect(native.redoEnabled).toBe(true));
  act(()=>{for(const listener of native.editListeners)listener({payload:'redo'});});
  expect(editor.value).toContain('Native edit');
});

const openSettings = async () => {
  await waitFor(()=>expect(native.settingsListeners.size).toBeGreaterThan(0));
  act(()=>{for(const listener of native.settingsListeners)listener();});
  return screen.findByRole('dialog',{name:'Settings'});
};

test('settings opens over the mounted editor, focuses the first setting and restores the editor caret', async () => {
  const {userEvent}=await import('@testing-library/user-event');
  const user=userEvent.setup();
  render(<App/>);
  const editor=await screen.findByLabelText('Diagram source') as HTMLTextAreaElement;
  fireEvent.change(editor,{target:{value:'flowchart LR\n A[Keep me] --> B'}});
  editor.focus();editor.setSelectionRange(2,4);
  const settings=await openSettings();
  expect(settings).toBeVisible();
  expect(editor).toBeInTheDocument();
  expect(editor.value).toContain('Keep me');
  await waitFor(()=>expect(within(settings).getAllByRole('radio')[0]).toHaveFocus());

  native.pickedFolder='/Users/example/Notes';
  await user.click(within(settings).getAllByRole('button',{name:'Choose Folder…'})[0]);
  await waitFor(()=>expect(native.preferences.defaultNotesFolder).toBe('/Users/example/Notes'));
  expect(native.preferences.defaultAttachmentsFolder).toBeNull();
  native.pickedFolder=null;
  await user.click(within(settings).getAllByRole('button',{name:'Choose Folder…'})[0]);
  expect(native.preferences.defaultNotesFolder).toBe('/Users/example/Notes');

  // A second menu activation focuses the open dialog instead of stacking another one.
  within(settings).getAllByRole('button',{name:'Choose Folder…'})[1].focus();
  act(()=>{for(const listener of native.settingsListeners)listener();});
  await waitFor(()=>expect(within(settings).getAllByRole('radio')[0]).toHaveFocus());
  expect(screen.getAllByRole('dialog')).toHaveLength(1);

  await user.click(within(settings).getByRole('button',{name:'Done'}));
  await waitFor(()=>expect(editor).toHaveFocus());
  expect(editor.selectionStart).toBe(2);
  expect(editor.selectionEnd).toBe(4);
});

test('settings leaves the current modal in control until it closes', async () => {
  render(<App/>);
  await screen.findByText('Current preview');
  await waitFor(()=>expect(native.settingsListeners.size).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole('button',{name:'Export'}));
  const exportDialog=await screen.findByRole('dialog',{name:'Export diagram'});
  act(()=>{for(const listener of native.settingsListeners)listener();});
  expect(screen.queryByRole('dialog',{name:'Settings'})).not.toBeInTheDocument();
  expect(exportDialog).toBeVisible();
  fireEvent.keyDown(exportDialog,{key:'Escape'});
  await waitFor(()=>expect(exportDialog).not.toBeInTheDocument());
  expect(await openSettings()).toBeVisible();
});

test('overlapping folder changes save both preferences', async () => {
  native.preferences={defaultNotesFolder:'/Users/example/Notes',defaultAttachmentsFolder:'/Users/example/Attachments'};
  native.deferPreferences=true;
  render(<App/>);
  const settings=await openSettings();
  const clear=within(settings).getAllByRole('button',{name:'Clear'});
  fireEvent.click(clear[0]);
  fireEvent.click(clear[1]);
  await waitFor(()=>expect(native.preferenceCompletions).toHaveLength(1));
  await act(async()=>native.preferenceCompletions.shift()!());
  expect(native.preferenceWrites).toEqual([
    {defaultNotesFolder:null,defaultAttachmentsFolder:'/Users/example/Attachments'},
    {defaultNotesFolder:null,defaultAttachmentsFolder:null},
  ]);
  await act(async()=>native.preferenceCompletions.shift()!());
  expect(native.preferences).toEqual({defaultNotesFolder:null,defaultAttachmentsFolder:null});
});

test('appearance choices apply immediately, persist, and survive relaunch', async () => {
  const {userEvent}=await import('@testing-library/user-event');
  const user=userEvent.setup();
  const app=render(<App/>);
  await screen.findByText('Current preview');
  let settings=await openSettings();
  const options=within(settings).getByRole('region',{name:'Settings options'});
  expect(within(options).getByRole('heading',{name:'Markdown Saving'})).toBeInTheDocument();
  expect(within(options).queryByRole('button',{name:'Done'})).not.toBeInTheDocument();
  await user.click(within(options).getByRole('radio',{name:/Warm Dark/}));
  expect(localStorage.getItem(APP_THEME_KEY)).toBe('warm-dark');
  expect(document.querySelector('.workspace')).toHaveAttribute('data-appearance','dark');
  await user.click(within(settings).getByRole('button',{name:'Done'}));
  app.unmount();

  render(<App/>);
  await screen.findByText('Current preview');
  expect(document.querySelector('.workspace')).toHaveAttribute('data-appearance','dark');
  settings=await openSettings();
  expect(within(settings).getByRole('radio',{name:/Warm Dark/})).toHaveAttribute('aria-checked','true');
});

test('absent or unknown stored appearance falls back to System', async () => {
  localStorage.setItem(APP_THEME_KEY,'sepia');
  render(<App/>);
  await screen.findByText('Current preview');
  const settings=await openSettings();
  expect(within(settings).getByRole('radio',{name:/System/})).toHaveAttribute('aria-checked','true');
  expect(document.querySelector('.workspace')).toHaveAttribute('data-appearance','light');
});

test('a storage read failure is surfaced in Appearance', async () => {
  const original=Storage.prototype.getItem;
  const spy=vi.spyOn(Storage.prototype,'getItem').mockImplementation(function(this:Storage,key:string){
    if(key===APP_THEME_KEY)throw new Error('storage denied');
    return original.call(this,key);
  });
  try {
    render(<App/>);
    await screen.findByText('Current preview');
    const settings=await openSettings();
    expect(within(settings).getByRole('alert')).toHaveTextContent('Could not read the saved appearance.');
  } finally { spy.mockRestore(); }
});

test('native editing shortcuts stay out of the editor while Settings is open', async () => {
  render(<App/>);
  const editor=await screen.findByLabelText('Diagram source') as HTMLTextAreaElement;
  fireEvent.change(editor,{target:{value:'flowchart LR\n A[Native edit] --> B'}});
  await waitFor(()=>expect(native.undoEnabled).toBe(true));
  const before=editor.value;
  await openSettings();
  act(()=>{for(const listener of native.editListeners)listener({payload:'undo'});});
  expect(editor.value).toBe(before);
});
