import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from '../src/App';
import {ensureFixtures,seedFixtures} from './seed';
import { requestDocument, type NativeDocumentListener } from './native-document-request';
import { defaultCSS } from '../src/fixtures';

type Revisions = { source: number; css: number | null; assets: number | null };
const native = vi.hoisted(() => ({ open: vi.fn(), restore: vi.fn(), write: vi.fn(), overwrite: vi.fn(), asset: vi.fn(), copy: vi.fn(), pairCopy: vi.fn(), release: vi.fn(), documentRequests: new Set<NativeDocumentListener>() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: unknown) => {
    if (command === 'open_named_document') return native.open(args);
    if (command === 'restore_paired_document') return native.restore(args);
    if (command === 'write_paired_document') return native.write(args);
    if (command === 'overwrite_paired_document') return native.overwrite(args);
    if (command === 'read_paired_asset') return native.asset(args);
    if (command === 'write_named_document') return 2;
    if (command === 'save_document_copy') return native.copy(args);
    if (command === 'save_paired_copy') return native.pairCopy(args);
    if (command === 'release_paired_document') return native.release(args);
    if (command === 'close_listener_ready') return false;
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name: string, listener: NativeDocumentListener) => { if(name==='document-request'){native.documentRequests.add(listener);return()=>native.documentRequests.delete(listener);} return()=>{}; } }));
vi.mock('../src/runner', () => ({ startRunner: vi.fn() }));
vi.mock('../src/rendering', () => ({ renderDiagram: async () => ({ svg: '<svg/>', width: 100, height: 100 }) }));

afterEach(() => {
  cleanup();
  localStorage.clear();
  native.open.mockReset();
  native.restore.mockReset();
  native.write.mockReset();
  native.overwrite.mockReset();
  native.asset.mockReset();
  native.copy.mockReset();
  native.pairCopy.mockReset();
  native.release.mockReset();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});
const start = () => { ensureFixtures(); Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true }); return render(<App />); };

const source = '%% authored comment\nflowchart LR\n\n   A[ Keep spacing ] --> B %% trailing\n';
const css = '/* authored */\n.node {\n  color : red ;\n}\n\n';
const pair = (overrides: Record<string, unknown> = {}) => ({
  handle: 'pair-1', base: 'diagram', source_name: 'diagram.mmd', source,
  css_name: 'diagram.css', css, assets_name: null, assets: null,
  revisions: { source: 1, css: 1, assets: null },
  ...overrides,
});
const saved = (revisions: Revisions, written: string[] = ['source', 'stylesheet']) => ({ revisions, written, failure: null });

test('opening a Mermaid file while closing the last draft does not reopen the discarded tab', async () => {
  localStorage.setItem('orei-drafts-v1', JSON.stringify({documents:{draft:{source,css,assets:{}}},active:'draft'}));
  native.open.mockResolvedValue(pair({source:'flowchart LR\n A@{ img: "assets/photo.png" }\n'}));
  let loadImage!:(value:string)=>void;
  native.asset.mockImplementation(()=>new Promise<string>(resolve=>{loadImage=resolve;}));
  start();
  fireEvent.click(screen.getByRole('button',{name:'Open'}));
  await waitFor(()=>expect(native.asset).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button',{name:'Close draft'}));
  fireEvent.click(screen.getByRole('button',{name:'Discard draft'}));
  expect(screen.getByRole('region',{name:'No documents open'})).toBeInTheDocument();
  await act(async()=>loadImage('data:image/png;base64,iVBORw0KGgo='));
  expect(screen.getByRole('tab',{name:'diagram.mmd'})).toHaveAttribute('aria-selected','true');
  expect(screen.queryByRole('tab',{name:'draft'})).not.toBeInTheDocument();
});

test('opens a paired document with exact text, indicates the pair, and writes nothing', async () => {
  native.open.mockResolvedValue(pair());
  start();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(screen.getByLabelText('Diagram source')).toHaveValue(source));
  expect(screen.getByLabelText('Diagram stylesheet')).toHaveValue(css);
  expect(screen.getByRole('tab',{name:'diagram.mmd'})).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText(/Paired diagram\.mmd with stylesheet companion/)).toBeInTheDocument();
  expect(native.write).not.toHaveBeenCalled();
  expect(native.asset).not.toHaveBeenCalled();
});

test('autosaves the source and stylesheet as one group with advancing revisions', async () => {
  native.open.mockResolvedValue(pair());
  native.write.mockResolvedValueOnce(saved({ source: 2, css: 2, assets: null })).mockResolvedValueOnce(saved({ source: 3, css: 3, assets: null }, ['source']));
  start();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(screen.getByLabelText('Diagram source')).toHaveValue(source));
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: source + '  C --> D\n' } });
  await waitFor(() => expect(native.write).toHaveBeenCalledOnce(), { timeout: 2500 });
  expect(native.write.mock.calls[0][0]).toMatchObject({ handle: 'pair-1', expected: { source: 1, css: 1, assets: null }, source: source + '  C --> D\n', css });
  fireEvent.change(screen.getByLabelText('Diagram stylesheet'), { target: { value: css + '.extra { color: blue; }\n' } });
  await waitFor(() => expect(native.write).toHaveBeenCalledTimes(2), { timeout: 2500 });
  expect(native.write.mock.calls[1][0]).toMatchObject({ expected: { source: 2, css: 2, assets: null } });
  expect(native.write.mock.calls[1][0].css).toBe(css + '.extra { color: blue; }\n');
  expect(native.write.mock.calls[1][0].source).toBe(source + '  C --> D\n');
});

test('loads an adjacent asset index and keeps custom icons and local images across autosave', async () => {
  const icon = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>';
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  native.open.mockResolvedValue(pair({
    source: 'flowchart LR\n A@{ icon: "fixture:star" }\n B@{ img: "assets/local.png" }\n',
    assets_name: 'diagram.orei-assets.json',
    assets: JSON.stringify({
      format: 'orei-paired-assets', version: 1,
      assets: {
        'fixture:star': { kind: 'icon', mediaType: 'image/svg+xml', encoding: 'text', data: icon },
        'assets/local.png': { kind: 'image', mediaType: 'image/png', encoding: 'data-url', data: image },
      },
    }),
    revisions: { source: 1, css: 1, assets: 1 },
  }));
  native.write.mockResolvedValue(saved({ source: 2, css: 2, assets: 2 }));
  start();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(screen.getByLabelText('Diagram source')).toHaveValue('flowchart LR\n A@{ icon: "fixture:star" }\n B@{ img: "assets/local.png" }\n'));
  expect(screen.getByText(/Paired diagram\.mmd with stylesheet companion/)).toBeInTheDocument();
  expect(native.asset).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: 'flowchart LR\n A@{ icon: "fixture:star" }\n B@{ img: "assets/local.png" }\n C@{ icon: "fixture:star" }\n' } });
  await waitFor(() => expect(native.write).toHaveBeenCalledOnce(), { timeout: 2500 });
  const savedAssets = JSON.parse(native.write.mock.calls[0][0].assets);
  expect(savedAssets.assets['fixture:star'].data).toBe(icon);
  expect(savedAssets.assets['assets/local.png'].data).toBe(image);
});

test('a standalone Mermaid file opens with in-memory defaults and creates no companion until CSS is edited', async () => {
  native.open.mockResolvedValue(pair({
    source_name: 'standalone.mmd', base: 'standalone', source: 'graph TD\n', css_name: null, css: null,
    revisions: { source: 1, css: null, assets: null },
  }));
  native.write.mockResolvedValueOnce(saved({ source: 2, css: null, assets: null }, ['source'])).mockResolvedValueOnce(saved({ source: 3, css: 1, assets: null }));
  start();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n'));
  expect(screen.getByLabelText('Diagram stylesheet')).toHaveValue(defaultCSS);
  expect(screen.getByText(/Paired standalone\.mmd with in-memory stylesheet/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: 'graph TD\n  A --> B\n' } });
  await waitFor(() => expect(native.write).toHaveBeenCalledOnce(), { timeout: 2500 });
  expect(native.write.mock.calls[0][0]).toMatchObject({ css: null, assets: null });
  fireEvent.change(screen.getByLabelText('Diagram stylesheet'), { target: { value: '.pele { --pele-bg: #ffffff; }\n' } });
  await waitFor(() => expect(native.write).toHaveBeenCalledTimes(2), { timeout: 2500 });
  expect(native.write.mock.calls[1][0]).toMatchObject({ expected: { source: 2, css: null, assets: null }, css: '.pele { --pele-bg: #ffffff; }\n' });
});

test('an invalid adjacent asset index refuses to open and leaves the workspace intact', async () => {
  native.open.mockResolvedValue(pair({ assets: '{broken', assets_name: 'diagram.orei-assets.json' }));
  start();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  expect(await screen.findByRole('dialog')).toHaveTextContent('Invalid document asset index');
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  expect(screen.getByRole('tab',{name:'small'})).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByRole('tab',{name:'diagram.mmd'})).not.toBeInTheDocument();
  expect(native.write).not.toHaveBeenCalled();
});

test('a missing adjacent image keeps the reference and surfaces a diagnostic', async () => {
  native.open.mockResolvedValue(pair({ source: 'flowchart LR\n A@{ img: "assets/missing.png" }\n', css: null, css_name: null }));
  native.asset.mockRejectedValue(new Error('Missing document asset: assets/missing.png'));
  start();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(screen.getByLabelText('Diagram source')).toHaveValue('flowchart LR\n A@{ img: "assets/missing.png" }\n'));
  expect(native.asset).toHaveBeenCalledWith({ handle: 'pair-1', reference: 'assets/missing.png' });
  expect(screen.getByText(/Missing adjacent document assets/)).toBeInTheDocument();
  expect(screen.getByText(/Missing adjacent document assets/)).toHaveTextContent('assets/missing.png (Error: Missing document asset: assets/missing.png)');
  expect(native.write).not.toHaveBeenCalled();
});

test('a partial group write is surfaced, retains recovery, and retries with advanced revisions', async () => {
  native.open.mockResolvedValue(pair());
  native.write.mockResolvedValueOnce({
    revisions: { source: 2, css: 1, assets: null },
    written: ['source'],
    failure: { member: 'stylesheet', message: 'destination already exists' },
  }).mockResolvedValueOnce(saved({ source: 3, css: 2, assets: null }));
  start();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(screen.getByLabelText('Diagram source')).toHaveValue(source));
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: source + 'partial edit\n' } });
  await waitFor(() => expect(native.write).toHaveBeenCalledOnce(), { timeout: 2500 });
  expect(await screen.findByText(/stylesheet could not be saved: destination already exists/)).toBeInTheDocument();
  expect(screen.getByText(/The source reached disk/)).toBeInTheDocument();
  expect(screen.getByText(/not as one atomic transaction/)).toBeInTheDocument();
  expect(screen.getByText('Save failed')).toBeInTheDocument();
  const recovery = JSON.parse(localStorage.getItem('orei-drafts-v1')!).documents['diagram.mmd'];
  expect(recovery.source).toBe(source + 'partial edit\n');
  expect(recovery.pair).toEqual({ base: 'diagram', cssCompanion: true, assetsCompanion: false });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(native.write).toHaveBeenCalledTimes(2), { timeout: 2500 });
  expect(native.write.mock.calls[1][0]).toMatchObject({ expected: { source: 2, css: 1, assets: null } });
});

test('saves incomplete Mermaid text verbatim instead of refusing the edit', async () => {
  const incomplete = 'flowchart LR\n A[unfinished\n';
  native.open.mockResolvedValue(pair({ source: incomplete, css: null, css_name: null, revisions: { source: 1, css: null, assets: null } }));
  native.write.mockResolvedValue(saved({ source: 2, css: null, assets: null }, ['source']));
  start();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(screen.getByLabelText('Diagram source')).toHaveValue(incomplete));
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: incomplete + '  B[more\n' } });
  await waitFor(() => expect(native.write).toHaveBeenCalledOnce(), { timeout: 2500 });
  expect(native.write.mock.calls[0][0].source).toBe(incomplete + '  B[more\n');
});

test('embeds a newly read adjacent PNG into the index so the image reopens without the original file', async () => {
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  native.open.mockResolvedValue(pair({ source: 'flowchart LR\n A@{ img: "assets/new.png" }\n', assets: null, assets_name: null }));
  native.asset.mockResolvedValue(image);
  native.write.mockResolvedValue(saved({ source: 2, css: 2, assets: 1 }));
  start();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(screen.getByLabelText('Diagram source')).toHaveValue('flowchart LR\n A@{ img: "assets/new.png" }\n'));
  expect(native.asset).toHaveBeenCalledWith({ handle: 'pair-1', reference: 'assets/new.png' });
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: 'flowchart LR\n A@{ img: "assets/new.png" }\n B[Edited]\n' } });
  await waitFor(() => expect(native.write).toHaveBeenCalledOnce(), { timeout: 2500 });
  const index = JSON.parse(native.write.mock.calls[0][0].assets);
  expect(index.assets['assets/new.png']).toEqual({ kind: 'image', mediaType: 'image/png', encoding: 'data-url', data: image });
});

function seedRecoveredPair(locationId?: string, recoveredSource = source, cssCompanion = true) {
  localStorage.setItem('orei-drafts-v1', JSON.stringify({
    documents: { 'diagram.mmd': { source: recoveredSource, css, assets: {}, pair: { base: 'diagram', cssCompanion, assetsCompanion: false, locationId } } },
    active: 'diagram.mmd',
  }));
}

test('Save reconnects a legacy restored paired tab and writes only the new edit', async () => {
  seedRecoveredPair();
  native.open.mockResolvedValue(pair({ location_id: 'remembered-pair' }));
  native.write.mockResolvedValue(saved({ source: 2, css: 1, assets: null }));
  start();
  expect(screen.getByLabelText('Diagram source')).toHaveValue(source);
  const edited = source + '  C --> D\n';
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: edited } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(native.write).toHaveBeenCalledWith({
    handle: 'pair-1', expected: { source: 1, css: 1, assets: null }, source: edited, css, assets: null,
  }));
  expect(native.open).toHaveBeenCalledWith({ pairedName: 'diagram.mmd' });
  expect(screen.queryByRole('dialog', { name: 'Could not save document' })).not.toBeInTheDocument();
  expect(screen.getByRole('tab',{name:'diagram.mmd'})).toHaveAttribute('aria-selected', 'true');
  expect(within(screen.getByRole('tablist', { name: 'Document tabs' })).getAllByRole('tab')).toHaveLength(1);
  expect(JSON.parse(localStorage.getItem('orei-drafts-v1')!).documents['diagram.mmd'].pair.locationId).toBe('remembered-pair');
});

test('a remembered paired tab reconnects on launch and resumes autosave without a picker', async () => {
  seedRecoveredPair('remembered-pair');
  native.restore.mockResolvedValue(pair({ location_id: 'remembered-pair' }));
  native.write.mockResolvedValue(saved({ source: 2, css: 1, assets: null }));
  start();
  expect(await screen.findByText('Saved')).toBeInTheDocument();
  expect(native.restore).toHaveBeenCalledWith({ locationId: 'remembered-pair' });
  expect(native.open).not.toHaveBeenCalled();
  expect(native.write).not.toHaveBeenCalled();

  const edited = source + '  C --> D\n';
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: edited } });
  await waitFor(() => expect(native.write).toHaveBeenCalledWith(expect.objectContaining({ source: edited })), { timeout: 2500 });
});

test('reconnecting a paired tab with edits waits to save until recovery succeeds', async () => {
  seedRecoveredPair();
  native.open.mockResolvedValue(pair({ location_id: 'remembered-pair' }));
  native.write.mockResolvedValue(saved({ source: 2, css: 1, assets: null }));
  start();
  const edited = source + '  C --> D\n';
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: edited } });

  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', { name: 'Could not save document' });
    expect(dialog).toHaveTextContent('Draft recovery failed');
    await new Promise(resolve => setTimeout(resolve, 900));
    expect(native.write).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
  } finally { storage.mockRestore(); }

  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(native.write).toHaveBeenCalledWith(expect.objectContaining({ source: edited })));
});

test('a differing recovered pair waits for conflict resolution without writing either version', async () => {
  const recovered = source + '  RECOVERED --> EDIT\n';
  seedRecoveredPair('remembered-pair', recovered);
  native.restore.mockResolvedValue(pair({ location_id: 'remembered-pair' }));
  start();
  expect(await screen.findByRole('dialog', { name: 'File changed on disk' })).toBeInTheDocument();
  expect(screen.getByLabelText('Diagram source')).toHaveValue(recovered);
  expect(screen.getByLabelText('Version on disk')).toHaveTextContent('Keep spacing');
  expect(native.write).not.toHaveBeenCalled();
  expect(native.open).not.toHaveBeenCalled();
});

test('a missing remembered location falls back to the picker and cancelling keeps the draft', async () => {
  seedRecoveredPair('missing-pair');
  native.restore.mockResolvedValue(null);
  native.open.mockResolvedValueOnce(null).mockResolvedValueOnce(pair({ location_id: 'new-pair' }));
  start();

  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
  expect(native.open).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Diagram source')).toHaveValue(source);
  expect(native.write).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Saved')).toBeInTheDocument();
  expect(native.write).not.toHaveBeenCalled();
});

test('Keep Local adopts a stylesheet added on disk before the recovered pair reopens', async () => {
  seedRecoveredPair('remembered-pair', source, false);
  const addedCss = '.node { color: blue; }';
  native.restore.mockResolvedValue(pair({ location_id: 'remembered-pair', css: addedCss }));
  native.overwrite.mockResolvedValue({
    ...saved({ source: 2, css: 1, assets: null }, ['source']),
    untouched_companions: { css: addedCss, assets: null },
  });
  native.write.mockResolvedValue(saved({ source: 3, css: 2, assets: null }));
  start();
  const dialog = await screen.findByRole('dialog', { name: 'File changed on disk' });
  fireEvent.click(within(dialog).getByRole('button', { name: /Keep Local/ }));
  await waitFor(() => expect(screen.getByLabelText('Diagram stylesheet')).toHaveValue(addedCss));
  expect(native.overwrite).toHaveBeenCalledWith(expect.objectContaining({ css: null, shown: expect.objectContaining({ css: addedCss }) }));

  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: source + '  C --> D\n' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(native.write).toHaveBeenCalledWith(expect.objectContaining({
    css: addedCss, expected: { source: 2, css: 1, assets: null },
  })));
});

test('Save Copy offers paired files for a paired document and keeps its association', async () => {
  native.open.mockResolvedValue(pair());
  native.pairCopy.mockResolvedValue(true);
  start();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(screen.getByLabelText('Diagram source')).toHaveValue(source));
  await requestDocument(native.documentRequests, 'save-copy');
  expect(await screen.findByRole('dialog')).toHaveTextContent('Destination format');
  fireEvent.click(screen.getByRole('radio', { name: 'Paired Mermaid + CSS' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save copy…' }));
  await waitFor(() => expect(native.pairCopy).toHaveBeenCalledOnce());
  expect(native.pairCopy.mock.calls[0][0]).toMatchObject({
    source,
    css,
    assets: null,
    defaultName: 'diagram.mmd',
  });
  expect(native.copy).not.toHaveBeenCalled();
  expect(await screen.findByText(/Copy saved\./)).toBeInTheDocument();
  expect(screen.getByRole('tab',{name:'diagram.mmd'})).toHaveAttribute('aria-selected', 'true');
});
