import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from '../src/App';
import {ensureFixtures,seedFixtures} from './seed';
import { createMarkdownDocument, parseMarkdownDocument } from '../src/markdown-document';
import { defaultCSS } from '../src/fixtures';

type Revisions = { source: number; css: number | null; assets: number | null };
const native = vi.hoisted(() => ({
  open: vi.fn(),
  createNamed: vi.fn(),
  createPair: vi.fn(),
  writeNamed: vi.fn(),
  writePair: vi.fn(),
  copy: vi.fn(),
  pairCopy: vi.fn(),
  asset: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: unknown) => {
    if (command === 'open_named_document') return native.open();
    if (command === 'create_named_document') return native.createNamed(args);
    if (command === 'create_paired_destination') return native.createPair(args);
    if (command === 'write_named_document') return native.writeNamed(args);
    if (command === 'write_paired_document') return native.writePair(args);
    if (command === 'read_paired_asset') return native.asset(args);
    if (command === 'save_document_copy') return native.copy(args);
    if (command === 'save_paired_copy') return native.pairCopy(args);
    if (command === 'close_listener_ready') return false;
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('../src/runner', () => ({ startRunner: vi.fn() }));
vi.mock('../src/rendering', () => ({ renderDiagram: async () => ({ svg: '<svg/>', width: 100, height: 100 }) }));

afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const fn of Object.values(native)) fn.mockReset();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});
const start = () => { ensureFixtures(); Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true }); return render(<App />); };
const source = () => screen.getByLabelText('Diagram source');
const stylesheet = () => screen.getByLabelText('Diagram stylesheet');
const open = async (file: unknown) => {
  start();
  native.open.mockResolvedValue(file);
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
};
const openSaveAs = () => fireEvent.click(screen.getByRole('button', { name: 'Save As' }));
const openCopy = () => fireEvent.click(screen.getByRole('button', { name: 'Save Copy' }));

const note = createMarkdownDocument({ mermaid: 'flowchart LR\n  A --> B\n', css: '.node { color: red; }\n' });
const openedNote = (text = `# Notes\n\nKeep this prose.\n\n${note}\nTail prose.\n`) => ({ handle: 'md-1', name: 'note.md', text, revision: 1 });
const openedPair = (overrides: Record<string, unknown> = {}) => ({
  handle: 'pair-1', base: 'diagram', source_name: 'diagram.mmd',
  source: '%% keep\nflowchart LR\n  A --> B\n', css: '/* keep */\n.node { color: red; }\n',
  css_name: 'diagram.css', assets_name: null, assets: null,
  revisions: { source: 1, css: 1, assets: null },
  ...overrides,
});

test('Save As offers both destinations and switches a Markdown note to paired files without touching the original', async () => {
  await open(openedNote());
  await waitFor(() => expect(source()).toHaveValue('flowchart LR\n  A --> B\n'));
  fireEvent.change(source(), { target: { value: 'flowchart LR\n  A --> C\n' } });
  fireEvent.change(stylesheet(), { target: { value: '.node { color: blue; }\n' } });
  native.createPair.mockImplementation(async (args: { source: string; css: string; assets: string | null }) => ({
    handle: 'pair-new', base: 'note', source_name: 'note.mmd', source: args.source, css: args.css,
    css_name: 'note.css', assets_name: null, assets: args.assets,
    revisions: { source: 1, css: 1, assets: null },
  }));
  native.writePair.mockResolvedValue({ revisions: { source: 2, css: 2, assets: null }, written: ['source', 'stylesheet'], failure: null });

  openSaveAs();
  expect(await screen.findByRole('dialog')).toHaveTextContent('Destination format');
  expect(screen.getByRole('radio', { name: 'Markdown note' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: 'Paired Mermaid + CSS' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose destination…' }));

  await waitFor(() => expect(native.createPair).toHaveBeenCalledOnce());
  expect(native.createPair.mock.calls[0][0]).toMatchObject({
    source: 'flowchart LR\n  A --> C\n',
    css: '.node { color: blue; }\n',
    assets: null,
    defaultName: 'note.mmd',
  });
  expect(native.createNamed).not.toHaveBeenCalled();
  expect(await screen.findByRole('tab',{name:'note.mmd'})).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText(/Paired note\.mmd with stylesheet companion/)).toBeInTheDocument();

  const recovery = JSON.parse(localStorage.getItem('orei-drafts-v1')!);
  expect(Object.keys(recovery.documents)).toContain('note.mmd');
  expect(recovery.documents['note.md']).toBeUndefined();
  expect(recovery.documents['note.mmd'].pair).toEqual({ base: 'note', cssCompanion: true, assetsCompanion: false });
  expect(recovery.documents['note.mmd'].originalMarkdown).toBeUndefined();

  const namedWrites=native.writeNamed.mock.calls.length;
  fireEvent.change(source(), { target: { value: 'flowchart LR\n  A --> D\n' } });
  await waitFor(() => expect(native.writePair).toHaveBeenCalledOnce(), { timeout: 2500 });
  expect(native.writePair.mock.calls[0][0]).toMatchObject({
    handle: 'pair-new',
    expected: { source: 1, css: 1, assets: null },
    source: 'flowchart LR\n  A --> D\n',
  });
  expect(native.writeNamed.mock.calls.length).toBe(namedWrites);
});

test('Save As converts a paired document to a Markdown note and continues autosaving it', async () => {
  await open(openedPair());
  await waitFor(() => expect(source()).toHaveValue('%% keep\nflowchart LR\n  A --> B\n'));
  native.createNamed.mockImplementation(async (args: { text: string; defaultName: string }) => ({
    handle: 'md-new', name: 'diagram.md', text: args.text, revision: 1,
  }));
  native.writeNamed.mockResolvedValue(2);

  openSaveAs();
  expect(await screen.findByRole('radio', { name: 'Paired Mermaid + CSS' })).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(screen.getByRole('radio', { name: 'Markdown note' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose destination…' }));

  await waitFor(() => expect(native.createNamed).toHaveBeenCalledOnce());
  const converted = native.createNamed.mock.calls[0][0];
  expect(converted.defaultName).toBe('diagram.md');
  expect(parseMarkdownDocument(converted.text)).toEqual({
    mermaid: '%% keep\nflowchart LR\n  A --> B\n',
    css: '/* keep */\n.node { color: red; }\n',
  });
  expect(native.createPair).not.toHaveBeenCalled();
  expect(await screen.findByRole('tab',{name:'diagram.md'})).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByText('Markdown working document')).not.toBeInTheDocument();

  fireEvent.change(source(), { target: { value: '%% keep\nflowchart LR\n  A --> C\n' } });
  await waitFor(() => expect(native.writeNamed).toHaveBeenCalledOnce(), { timeout: 2500 });
  expect(native.writeNamed.mock.calls[0][0]).toMatchObject({ handle: 'md-new', revision: 1 });
  expect(parseMarkdownDocument(native.writeNamed.mock.calls[0][0].text).mermaid).toBe('%% keep\nflowchart LR\n  A --> C\n');
  expect(native.writePair).not.toHaveBeenCalled();
});

test('cancelling the Save As picker keeps the current identity, association, and recovery', async () => {
  await open(openedNote());
  await waitFor(() => expect(source()).toHaveValue('flowchart LR\n  A --> B\n'));
  native.createNamed.mockResolvedValue(null);
  native.writeNamed.mockResolvedValue(2);

  openSaveAs();
  fireEvent.click(screen.getByRole('button', { name: 'Choose destination…' }));
  await waitFor(() => expect(native.createNamed).toHaveBeenCalledOnce());
  expect(screen.getByRole('tab',{name:'note.md'})).toHaveAttribute('aria-selected', 'true');
  expect(JSON.parse(localStorage.getItem('orei-drafts-v1')!).documents['note.md'].originalMarkdown).toContain(note);

  fireEvent.change(source(), { target: { value: 'flowchart LR\n  A --> After\n' } });
  await waitFor(() => expect(native.writeNamed).toHaveBeenCalledOnce(), { timeout: 2500 });
  expect(native.writeNamed.mock.calls[0][0]).toMatchObject({ handle: 'md-1', revision: 1 });
});

test('Save As writes a new Markdown note, keeps surrounding prose, and rebinds autosave', async () => {
  await open(openedNote());
  await waitFor(() => expect(source()).toHaveValue('flowchart LR\n  A --> B\n'));
  native.createNamed.mockImplementation(async (args: { text: string; defaultName: string }) => ({
    handle: 'md-copy', name: 'note-copy.md', text: args.text, revision: 1,
  }));
  native.writeNamed.mockResolvedValue(2);

  openSaveAs();
  expect(await screen.findByRole('radio', { name: 'Markdown note' })).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Choose destination…' }));

  await waitFor(() => expect(native.createNamed).toHaveBeenCalledOnce());
  const created = native.createNamed.mock.calls[0][0];
  expect(created.defaultName).toBe('note.md');
  expect(created.text).toContain('# Notes');
  expect(created.text).toContain('Keep this prose.');
  expect(created.text).toContain('Tail prose.');
  expect(created.text).toContain('flowchart LR\n  A --> B\n');
  expect(native.writeNamed).not.toHaveBeenCalled();
  expect(await screen.findByRole('tab',{name:'note-copy.md'})).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByRole('tab',{name:'note.md'})).not.toBeInTheDocument();

  const recovery = JSON.parse(localStorage.getItem('orei-drafts-v1')!);
  expect(Object.keys(recovery.documents)).toContain('note-copy.md');
  expect(recovery.documents['note.md']).toBeUndefined();

  fireEvent.change(source(), { target: { value: 'flowchart LR\n  A --> Rebounded\n' } });
  await waitFor(() => expect(native.writeNamed).toHaveBeenCalledOnce(), { timeout: 2500 });
  expect(native.writeNamed.mock.calls[0][0]).toMatchObject({ handle: 'md-copy', revision: 1 });
  expect(parseMarkdownDocument(native.writeNamed.mock.calls[0][0].text).mermaid).toBe('flowchart LR\n  A --> Rebounded\n');
});

test('cancelling a paired Save As picker keeps the paired association and recovery', async () => {
  await open(openedPair());
  await waitFor(() => expect(source()).toHaveValue('%% keep\nflowchart LR\n  A --> B\n'));
  native.createPair.mockResolvedValue(null);
  native.writePair.mockResolvedValue({ revisions: { source: 2, css: 2, assets: null }, written: ['source', 'stylesheet'], failure: null });

  openSaveAs();
  expect(await screen.findByRole('radio', { name: 'Paired Mermaid + CSS' })).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Choose destination…' }));
  await waitFor(() => expect(native.createPair).toHaveBeenCalledOnce());
  expect(screen.getByRole('tab',{name:'diagram.mmd'})).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByRole('tab',{name:'diagram.md'})).not.toBeInTheDocument();

  fireEvent.change(source(), { target: { value: '%% keep\nflowchart LR\n  A --> After\n' } });
  await waitFor(() => expect(native.writePair).toHaveBeenCalledOnce(), { timeout: 2500 });
  expect(native.writePair.mock.calls[0][0]).toMatchObject({ handle: 'pair-1', expected: { source: 1, css: 1, assets: null } });
});

test('an existing destination conflict keeps the original active and recoverable', async () => {
  await open(openedNote());
  await waitFor(() => expect(source()).toHaveValue('flowchart LR\n  A --> B\n'));
  native.createPair.mockRejectedValue(new Error('A destination file already exists: note.css. Choose an unused name; nothing was written.'));

  openSaveAs();
  fireEvent.click(screen.getByRole('radio', { name: 'Paired Mermaid + CSS' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose destination…' }));
  expect(await screen.findByRole('dialog')).toHaveTextContent('A destination file already exists: note.css');
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));

  expect(source()).toHaveValue('flowchart LR\n  A --> B\n');
  expect(screen.getByRole('tab',{name:'note.md'})).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByRole('tab',{name:'note.mmd'})).not.toBeInTheDocument();
  const recovery = JSON.parse(localStorage.getItem('orei-drafts-v1')!);
  expect(Object.keys(recovery.documents)).toContain('note.md');
  expect(recovery.documents['note.md'].source).toBe('flowchart LR\n  A --> B\n');
  expect(recovery.documents['note.md'].pair).toBeUndefined();
});

test('a document with icons or images cannot be converted to Markdown and names what would be lost', async () => {
  const icon = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>';
  await open(openedPair({
    source: 'flowchart LR\n  A@{ icon: "fixture:star" }\n',
    assets_name: 'diagram.orei-assets.json',
    assets: JSON.stringify({
      format: 'orei-paired-assets', version: 1,
      assets: { 'fixture:star': { kind: 'icon', mediaType: 'image/svg+xml', encoding: 'text', data: icon } },
    }),
    revisions: { source: 1, css: 1, assets: 1 },
  }));
  await waitFor(() => expect(source()).toHaveValue('flowchart LR\n  A@{ icon: "fixture:star" }\n'));

  fireEvent.click(screen.getByRole('button', { name: 'Save As' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Markdown note' }));
  expect(await screen.findByText(/Markdown asset storage is not specified yet/)).toBeInTheDocument();
  expect(screen.getByText(/saving would lose 1 embedded asset \(fixture:star\)/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Choose destination…' })).toBeDisabled();
  expect(native.createNamed).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('radio', { name: 'Paired Mermaid + CSS' }));
  expect(screen.getByRole('button', { name: 'Choose destination…' })).toBeEnabled();
});

test('a missing embedded image blocks a paired Save As and leaves the paired document untouched', async () => {
  start();
  native.open.mockResolvedValue(openedPair({ source: 'flowchart LR\n  A@{ img: "assets/missing.png" }\n' }));
  native.asset.mockRejectedValue(new Error('Missing document asset: assets/missing.png'));
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(source()).toHaveValue('flowchart LR\n  A@{ img: "assets/missing.png" }\n'));

  openSaveAs();
  expect(await screen.findByText(/assets\/missing\.png has no embedded content/)).toBeInTheDocument();
  expect(screen.getByText(/kept in the original document/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Choose destination…' })).toBeDisabled();
  expect(native.createPair).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem('orei-drafts-v1')!).documents['diagram.mmd'].source)
    .toBe('flowchart LR\n  A@{ img: "assets/missing.png" }\n');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('tab',{name:'diagram.mmd'})).toHaveAttribute('aria-selected', 'true');
});

test('closing the Save As dialog restores focus to its initiating control', async () => {
  await open(openedNote());
  await waitFor(() => expect(source()).toHaveValue('flowchart LR\n  A --> B\n'));
  const trigger = screen.getByRole('button', { name: 'Save As' });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = await screen.findByRole('dialog');
  fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());
});

test('edits made while the Save As picker is open are written to the new destination', async () => {
  await open(openedNote());
  await waitFor(() => expect(source()).toHaveValue('flowchart LR\n  A --> B\n'));
  let finish!: (opened: Record<string, unknown>) => void;
  native.createPair.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  native.writePair.mockResolvedValue({ revisions: { source: 2, css: 2, assets: null }, written: ['source', 'stylesheet'], failure: null });

  openSaveAs();
  fireEvent.click(screen.getByRole('radio', { name: 'Paired Mermaid + CSS' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose destination…' }));
  await waitFor(() => expect(native.createPair).toHaveBeenCalledOnce());
  const written = native.createPair.mock.calls[0][0];
  fireEvent.change(source(), { target: { value: 'flowchart LR\n  A --> Late\n' } });
  await act(async () => {
    finish({
      handle: 'pair-late', base: 'note', source_name: 'note.mmd', source: written.source, css: written.css,
      css_name: 'note.css', assets_name: null, assets: null,
      revisions: { source: 1, css: 1, assets: null },
    });
  });
  await waitFor(() => expect(screen.getByRole('tab',{name:'note.mmd'})).toBeInTheDocument());
  await waitFor(() => expect(native.writePair).toHaveBeenCalledOnce(), { timeout: 2500 });
  expect(native.writePair.mock.calls[0][0]).toMatchObject({ handle: 'pair-late', expected: { source: 1, css: 1, assets: null } });
  expect(native.writePair.mock.calls[0][0].source).toBe('flowchart LR\n  A --> Late\n');
  expect(source()).toHaveValue('flowchart LR\n  A --> Late\n');
});

test('Save As on a restored paired draft reconnects it to a freshly written destination', async () => {
  localStorage.setItem('orei-drafts-v1', JSON.stringify({
    documents: {
      'diagram.mmd': {
        source: 'flowchart LR\n  A --> B\n', css: defaultCSS, assets: {},
        pair: { base: 'diagram', cssCompanion: true, assetsCompanion: false },
      },
    },
    active: 'diagram.mmd',
  }));
  start();
  expect(source()).toHaveValue('flowchart LR\n  A --> B\n');
  native.createPair.mockImplementation(async (args: { source: string; css: string; assets: string | null }) => ({
    handle: 'pair-restored', base: 'diagram', source_name: 'diagram.mmd', source: args.source, css: args.css,
    css_name: 'diagram.css', assets_name: null, assets: args.assets,
    revisions: { source: 1, css: 1, assets: null },
  }));
  native.writePair.mockResolvedValue({ revisions: { source: 2, css: 2, assets: null }, written: ['source', 'stylesheet'], failure: null });

  openSaveAs();
  fireEvent.click(screen.getByRole('radio', { name: 'Paired Mermaid + CSS' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose destination…' }));
  await waitFor(() => expect(native.createPair).toHaveBeenCalledOnce());
  fireEvent.change(source(), { target: { value: 'flowchart LR\n  A --> Reconnected\n' } });
  await waitFor(() => expect(native.writePair).toHaveBeenCalledOnce(), { timeout: 2500 });
  expect(native.writePair.mock.calls[0][0]).toMatchObject({ handle: 'pair-restored' });
});

test('Save Copy to Markdown refuses a paired document with embedded images without opening a picker', async () => {
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  await open(openedPair({
    source: 'flowchart LR\n  A@{ img: "assets/local.png" }\n',
    assets_name: 'diagram.orei-assets.json',
    assets: JSON.stringify({
      format: 'orei-paired-assets', version: 1,
      assets: { 'assets/local.png': { kind: 'image', mediaType: 'image/png', encoding: 'data-url', data: image } },
    }),
    revisions: { source: 1, css: 1, assets: 1 },
  }));
  await waitFor(() => expect(source()).toHaveValue('flowchart LR\n  A@{ img: "assets/local.png" }\n'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Copy' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Markdown note' }));
  expect(await screen.findByText(/saving would lose 1 embedded asset \(assets\/local\.png\)/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save copy…' })).toBeDisabled();
  expect(native.copy).not.toHaveBeenCalled();
});

test('Save Copy converts an asset-free paired document to Markdown without changing its association', async () => {
  await open(openedPair());
  await waitFor(() => expect(source()).toHaveValue('%% keep\nflowchart LR\n  A --> B\n'));
  native.copy.mockResolvedValue(true);

  openCopy();
  fireEvent.click(screen.getByRole('radio', { name: 'Markdown note' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save copy…' }));
  await waitFor(() => expect(native.copy).toHaveBeenCalledOnce());
  expect(native.copy.mock.calls[0][0].defaultName).toBe('diagram.md');
  expect(parseMarkdownDocument(native.copy.mock.calls[0][0].text)).toEqual({
    mermaid: '%% keep\nflowchart LR\n  A --> B\n',
    css: '/* keep */\n.node { color: red; }\n',
  });
  expect(native.pairCopy).not.toHaveBeenCalled();
  expect(await screen.findByText(/Copy saved\./)).toBeInTheDocument();
  expect(screen.getByRole('tab',{name:'diagram.mmd'})).toHaveAttribute('aria-selected', 'true');
});

test('Save Copy converts a Markdown note to paired files without changing its association', async () => {
  await open(openedNote());
  await waitFor(() => expect(source()).toHaveValue('flowchart LR\n  A --> B\n'));
  native.pairCopy.mockResolvedValue(true);

  openCopy();
  fireEvent.click(screen.getByRole('radio', { name: 'Paired Mermaid + CSS' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save copy…' }));
  await waitFor(() => expect(native.pairCopy).toHaveBeenCalledOnce());
  expect(native.pairCopy.mock.calls[0][0]).toMatchObject({
    source: 'flowchart LR\n  A --> B\n',
    css: '.node { color: red; }\n',
    assets: null,
    defaultName: 'note.mmd',
  });
  expect(native.copy).not.toHaveBeenCalled();
  expect(await screen.findByText(/Copy saved\./)).toBeInTheDocument();
  expect(screen.getByRole('tab',{name:'note.md'})).toHaveAttribute('aria-selected', 'true');
});

test('Save Copy to paired files writes a copy and leaves the open document association alone', async () => {
  await open(openedPair());
  await waitFor(() => expect(source()).toHaveValue('%% keep\nflowchart LR\n  A --> B\n'));
  native.pairCopy.mockResolvedValue(true);
  native.writePair.mockResolvedValue({ revisions: { source: 2, css: 2, assets: null }, written: ['source', 'stylesheet'], failure: null });

  openCopy();
  fireEvent.click(screen.getByRole('radio', { name: 'Paired Mermaid + CSS' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save copy…' }));
  await waitFor(() => expect(native.pairCopy).toHaveBeenCalledOnce());
  expect(native.pairCopy.mock.calls[0][0]).toMatchObject({
    source: '%% keep\nflowchart LR\n  A --> B\n',
    css: '/* keep */\n.node { color: red; }\n',
    defaultName: 'diagram.mmd',
  });
  expect(await screen.findByText(/Copy saved\./)).toBeInTheDocument();
  expect(screen.getByRole('tab',{name:'diagram.mmd'})).toHaveAttribute('aria-selected', 'true');

  fireEvent.change(source(), { target: { value: '%% keep\nflowchart LR\n  A --> After\n' } });
  await waitFor(() => expect(native.writePair).toHaveBeenCalledOnce(), { timeout: 2500 });
  expect(native.writePair.mock.calls[0][0]).toMatchObject({ handle: 'pair-1', expected: { source: 1, css: 1, assets: null } });
});
