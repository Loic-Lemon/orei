import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {App} from '../src/App';
import {ensureFixtures,seedFixtures} from './seed';

const native = vi.hoisted(() => ({
  enabled: false,
  deferred: false,
  pending: [] as Array<() => void>,
  listeners: new Set<() => void>(),
  editListeners: new Set<(event:{payload:'undo'|'redo'}) => void>(),
  undoEnabled: false,
  redoEnabled: false,
}));

vi.mock('@tauri-apps/api/window',()=>({getCurrentWindow:()=>({onCloseRequested:async()=>()=>{}})}));
vi.mock('../src/runner', () => ({startRunner: vi.fn()}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: {enabled: boolean;undo:boolean;redo:boolean}) => {
    if (command === 'set_export_enabled') native.enabled = args!.enabled;
    if (command === 'set_edit_enabled') {native.undoEnabled=args!.undo;native.redoEnabled=args!.redo;}
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
  native.editListeners.clear();
  native.undoEnabled=false;native.redoEnabled=false;
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
