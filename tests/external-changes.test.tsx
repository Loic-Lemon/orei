import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from '../src/App';
import {ensureFixtures,seedFixtures} from './seed';
import { requestDocument, type NativeDocumentListener } from './native-document-request';
import { createMarkdownDocument } from '../src/markdown-document';

type Revisions = { source: number; css: number | null; assets: number | null };
const native = vi.hoisted(() => ({
  open: vi.fn(), write: vi.fn(), inspect: vi.fn(), reload: vi.fn(), overwrite: vi.fn(), release: vi.fn(),
  pairInspect: vi.fn(), pairReload: vi.fn(), pairOverwrite: vi.fn(), prepare: vi.fn(), create: vi.fn(), copy: vi.fn(), pairCopy: vi.fn(), documentRequests: new Set<NativeDocumentListener>(),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: unknown) => {
    switch (command) {
      case 'open_named_document': return native.open();
      case 'write_markdown_document': return {revision:await native.write(args),published:[]};
      case 'write_paired_document': return native.write(args);
      case 'inspect_named_document': return native.inspect(args);
      case 'reload_named_document': return native.reload(args);
      case 'overwrite_markdown_document': return native.overwrite(args);
      case 'inspect_paired_document': return native.pairInspect(args);
      case 'reload_paired_document': return native.pairReload(args);
      case 'overwrite_paired_document': return native.pairOverwrite(args);
      case 'release_named_document':
      case 'release_paired_document': return native.release(args);
      case 'prepare_markdown_destination': return native.prepare(args);
      case 'create_markdown_document': return native.create(args);
      case 'save_markdown_copy': return native.copy(args);
      case 'cancel_markdown_destination': return true;
      case 'save_paired_copy': return native.pairCopy(args);
      case 'close_listener_ready': return false;
      default: return undefined;
    }
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name: string, listener: NativeDocumentListener) => { if(name==='document-request'){native.documentRequests.add(listener);return()=>native.documentRequests.delete(listener);} return()=>{}; } }));
vi.mock('../src/runner', () => ({ startRunner: vi.fn() }));
vi.mock('../src/rendering', () => ({ renderDiagram: async () => ({ svg: '<svg/>', width: 100, height: 100 }) }));

beforeAll(() => { Element.prototype.scrollIntoView ??= () => {}; });
afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const mock of [native.open,native.write,native.inspect,native.reload,native.overwrite,native.release,native.pairInspect,native.pairReload,native.pairOverwrite,native.prepare,native.create,native.copy,native.pairCopy]) mock.mockReset();
  native.documentRequests.clear();
  native.prepare.mockResolvedValue({destination:'prepared-copy',attachments:'../attachments',namespace:'prepared-copy'});
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});
const start = () => { native.prepare.mockResolvedValue({destination:'prepared-copy',attachments:'../attachments',namespace:'prepared-copy'}); ensureFixtures(); Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true }); return render(<App/>); };

const markdown = (mermaid = 'graph TD\n', css = 'node { color: red; }\n') => createMarkdownDocument({ mermaid, css });
const unchanged = { revision: 2, text: null, missing: false, changed: false, error: null, retained: [] };
const changedMarkdown = (text: string, retained: { member: string; text: string; path: string }[] = []) => ({ revision: 2, text, missing: false, changed: true, error: null, retained });

async function openMarkdown(text = markdown()) {
  start();
  native.open.mockResolvedValueOnce({ handle: 'doc-1', name: 'example.md', text, revision: 2 });
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n'));
}

async function conflictedMarkdown(local: string, disk: string, retained?: { member: string; text: string; path: string }[]) {
  await openMarkdown();
  let external = false;
  native.inspect.mockImplementation(async () => external ? changedMarkdown(disk, retained) : unchanged);
  native.write.mockRejectedValue(new Error('Document changed on disk'));
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: local } });
  external = true;
  const dialog = await screen.findByRole('dialog', undefined, { timeout: 3000 });
  await waitFor(() => expect(dialog).toHaveTextContent('File changed on disk'));
  return dialog;
}

test('an external change with no unsaved edits reloads the document without a dialog or a write loop', async () => {
  await openMarkdown();
  const external = markdown('graph TD\n  EXTERNAL --> CHANGE\n');
  native.inspect.mockResolvedValue(changedMarkdown(external));
  native.reload.mockResolvedValue({ text: external, revision: 3 });
  await waitFor(() => expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n  EXTERNAL --> CHANGE\n'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(native.reload).toHaveBeenCalledOnce();
  expect(native.write).not.toHaveBeenCalled();
  expect(screen.getByText('Saved')).toBeInTheDocument();
  expect(localStorage.getItem('orei-drafts-v1')).toContain('EXTERNAL');
});

test('edits made while an external reload is in flight are kept and become a conflict, not overwritten', async () => {
  await openMarkdown();
  const external = markdown('graph TD\n  DISK --> CHANGE\n');
  let finishReload!: (value: { text: string; revision: number }) => void;
  native.inspect.mockResolvedValue(changedMarkdown(external));
  native.reload.mockImplementation(() => new Promise(resolve => { finishReload = resolve; }));
  await waitFor(() => expect(native.reload).toHaveBeenCalledOnce());
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: 'graph TD\n  TYPED --> DURING\n' } });
  finishReload({ text: external, revision: 3 });
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(dialog).toHaveTextContent('File changed on disk'));
  expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n  TYPED --> DURING\n');
  expect(within(dialog).getByLabelText('Version on disk')).toHaveTextContent('DISK --> CHANGE');
  expect(localStorage.getItem('orei-drafts-v1')).toContain('TYPED --> DURING');
});

test('an unresolved conflict that was kept paused is never auto-resolved over later local edits', async () => {
  await openMarkdown();
  native.inspect.mockResolvedValue({ revision: 2, text: null, missing: true, changed: true, error: 'gone', retained: [] });
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(dialog).toHaveTextContent('File missing on disk'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Keep paused' }));
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: 'graph TD\n  DRAFT --> WHILE PAUSED\n' } });
  native.inspect.mockResolvedValue(changedMarkdown(markdown('graph TD\n  NOW --> READABLE\n')));
  await new Promise(resolve => setTimeout(resolve, 1400));
  expect(native.reload).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n  DRAFT --> WHILE PAUSED\n');
  expect(screen.getByText('Changed on disk')).toBeInTheDocument();
});

test('a conflicting failed save pauses autosave, keeps local recovery, and Reload Disk adopts the compared disk version', async () => {
  const external = markdown('graph TD\n  DISK --> WINS\n');
  const dialog = await conflictedMarkdown('graph TD\n  LOCAL --> EDIT\n', external);
  expect(native.write).toHaveBeenCalledOnce();
  expect(localStorage.getItem('orei-drafts-v1')).toContain('LOCAL --> EDIT');
  expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n  LOCAL --> EDIT\n');
  expect(screen.getByText('Changed on disk')).toBeInTheDocument();
  expect(within(dialog).getByLabelText('Version on disk')).toHaveTextContent('DISK --> WINS');
  expect(within(dialog).getByLabelText('Local version')).toHaveTextContent('LOCAL --> EDIT');

  native.reload.mockResolvedValue({ text: external, revision: 3 });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reload Disk' }));
  await waitFor(() => expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n  DISK --> WINS\n'));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(native.reload).toHaveBeenCalledWith({ handle: 'doc-1' });
  expect(native.write).toHaveBeenCalledOnce();
});

test('Keep Local overwrites only after an explicit choice and later autosaves continue on the new revision', async () => {
  const dialog = await conflictedMarkdown('graph TD\n  KEEP --> LOCAL\n', markdown('graph TD\n  DISK --> OTHER\n'));
  native.inspect.mockResolvedValue(unchanged);
  native.overwrite.mockResolvedValue({ revision: 5, retained: [] });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Keep Local (overwrite)' }));
  await waitFor(() => expect(native.overwrite).toHaveBeenCalledOnce());
  const overwrite = native.overwrite.mock.calls[0][0];
  expect(overwrite).toMatchObject({ handle: 'doc-1' });
  expect(overwrite.text).toContain('KEEP --> LOCAL');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n  KEEP --> LOCAL\n');
  expect(screen.getByText('Saved')).toBeInTheDocument();

  native.write.mockReset();
  native.write.mockResolvedValue(6);
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: 'graph TD\n  AFTER --> RESOLVE\n' } });
  await waitFor(() => expect(native.write).toHaveBeenCalledOnce(), { timeout: 2500 });
  expect(native.write.mock.calls[0][0]).toMatchObject({ handle: 'doc-1', revision: 5 });
});

test('Save a Copy from the conflict dialog keeps both versions and does not resolve the conflict', async () => {
  const dialog = await conflictedMarkdown('graph TD\n  LOCAL --> KEEP\n', markdown('graph TD\n  DISK --> KEEP\n'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save a Copy…' }));
  const copyDialog = await screen.findByRole('dialog');
  expect(copyDialog).toHaveTextContent('Save a copy');
  expect(copyDialog).not.toHaveTextContent('File changed on disk');
  expect(screen.getByText('Changed on disk')).toBeInTheDocument();
  expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n  LOCAL --> KEEP\n');
});

test('the preserved external version from a raced save is compared and named separately from the file on disk', async () => {
  const stage = '/tmp/orei/.orei-save-123-0.tmp';
  const dialog = await conflictedMarkdown(
    'graph TD\n  LOCAL --> DRAFT\n',
    markdown('graph TD\n  PUBLISHED --> SNAPSHOT\n'),
    [{ member: 'doc.md', text: markdown('graph TD\n  EXTERNAL --> WRITER\n'), path: stage }],
  );
  expect(within(dialog).getByLabelText('Version on disk')).toHaveTextContent('PUBLISHED --> SNAPSHOT');
  const preserved = within(dialog).getByLabelText('Preserved version');
  expect(preserved).toHaveTextContent('EXTERNAL --> WRITER');
  expect(dialog).toHaveTextContent('preserved for comparison');
  expect(dialog).toHaveTextContent(stage);
  native.overwrite.mockResolvedValue({ revision: 4, retained: [] });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Keep Local (overwrite)' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('a deleted destination pauses autosave, disables Reload Disk, and can be recreated by Keep Local', async () => {
  await openMarkdown();
  native.inspect.mockResolvedValue({ revision: 2, text: null, missing: true, changed: true, error: 'The file no longer exists at its saved location', retained: [] });
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(dialog).toHaveTextContent('File missing on disk'));
  expect(within(dialog).getByRole('button', { name: 'Reload Disk' })).toBeDisabled();
  expect(within(dialog).getByText(/local version has not been deleted/i)).toBeInTheDocument();
  expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n');
  native.overwrite.mockResolvedValue({ revision: 3, retained: [] });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Keep Local (overwrite)' }));
  await waitFor(() => expect(native.overwrite).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

const pairSource = 'flowchart LR\n  A --> B\n';
const pairCSS = '.node { color: red; }\n';
const pair = (overrides: Record<string, unknown> = {}) => ({
  handle: 'pair-1', base: 'diagram', source_name: 'diagram.mmd', source: pairSource,
  css_name: 'diagram.css', css: pairCSS, assets_name: null, assets: null,
  revisions: { source: 1, css: 1, assets: null },
  ...overrides,
});
const cleanPair = { revisions: { source: 1, css: 1, assets: null }, source: pairSource, css: pairCSS, assets: null, missing: [], changed: false, error: null, retained: [] };
const savedPair = (revisions: Revisions, written: string[] = ['source', 'stylesheet']) => ({ revisions, written, failure: null });

async function openPair() {
  start();
  native.open.mockResolvedValueOnce(pair());
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(screen.getByLabelText('Diagram source')).toHaveValue(pairSource));
}

test('paired conflicts compare every member and Reload Disk refreshes source and stylesheet together', async () => {
  await openPair();
  let external = false;
  native.pairInspect.mockImplementation(async () => external
    ? { ...cleanPair, changed: true, source: 'flowchart LR\n  EXTERNAL --> SOURCE\n', css: '.external { color: blue; }\n' }
    : cleanPair);
  native.write.mockRejectedValue(new Error('source could not be saved: Document changed on disk.'));
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: 'flowchart LR\n  LOCAL --> SOURCE\n' } });
  external = true;
  const dialog = await screen.findByRole('dialog', undefined, { timeout: 3000 });
  await waitFor(() => expect(dialog).toHaveTextContent('File changed on disk'));
  expect(screen.getByText('Changed on disk')).toBeInTheDocument();
  expect(within(dialog).getByLabelText('Version on disk')).toHaveTextContent('EXTERNAL --> SOURCE');
  fireEvent.click(within(dialog).getByLabelText('Compare file'));
  const options = await screen.findByRole('listbox');
  fireEvent.click(within(options).getByText('Stylesheet companion'));
  await waitFor(() => expect(within(dialog).getByLabelText('Version on disk')).toHaveTextContent('.external { color: blue; }'));

  native.pairReload.mockResolvedValue(pair({
    source: 'flowchart LR\n  EXTERNAL --> SOURCE\n', css: '.external { color: blue; }\n',
    revisions: { source: 2, css: 2, assets: null },
  }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reload Disk' }));
  await waitFor(() => expect(screen.getByLabelText('Diagram source')).toHaveValue('flowchart LR\n  EXTERNAL --> SOURCE\n'));
  expect(screen.getByLabelText('Diagram stylesheet')).toHaveValue('.external { color: blue; }\n');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('paired Keep Local writes the whole local group and resumes autosave with the reported revisions', async () => {
  await openPair();
  let external = false;
  native.pairInspect.mockImplementation(async () => external
    ? { ...cleanPair, changed: true, source: 'flowchart LR\n  DISK --> SOURCE\n' }
    : cleanPair);
  native.write.mockRejectedValue(new Error('source could not be saved: Document changed on disk.'));
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: 'flowchart LR\n  LOCAL --> SOURCE\n' } });
  external = true;
  const dialog = await screen.findByRole('dialog', undefined, { timeout: 3000 });
  await waitFor(() => expect(dialog).toHaveTextContent('File changed on disk'));
  native.pairOverwrite.mockResolvedValue(savedPair({ source: 2, css: 2, assets: null }));
  native.pairInspect.mockResolvedValue({ ...cleanPair, revisions: { source: 2, css: 2, assets: null } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Keep Local (overwrite)' }));
  await waitFor(() => expect(native.pairOverwrite).toHaveBeenCalledOnce());
  const overwrite = native.pairOverwrite.mock.calls[0][0];
  expect(overwrite).toMatchObject({ handle: 'pair-1' });
  expect(overwrite.source).toBe('flowchart LR\n  LOCAL --> SOURCE\n');
  expect(overwrite.css).toBe(pairCSS);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByText('Saved')).toBeInTheDocument();

  native.write.mockReset();
  native.write.mockResolvedValue(savedPair({ source: 3, css: 3, assets: null }));
  native.pairInspect.mockResolvedValue({ ...cleanPair, revisions: { source: 2, css: 2, assets: null } });
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: 'flowchart LR\n  AFTER --> RESOLVE\n' } });
  await waitFor(() => expect(screen.getByLabelText('Diagram source')).toHaveValue('flowchart LR\n  AFTER --> RESOLVE\n'));
  expect(localStorage.getItem('orei-drafts-v1')).toContain('AFTER --> RESOLVE');
  await waitFor(() => expect(native.write).toHaveBeenCalledOnce(), { timeout: 2500 });
  expect(native.write.mock.calls[0][0]).toMatchObject({ expected: { source: 2, css: 2, assets: null } });
});

test('switching tabs inspects the newly active document handle rather than the previous one', async () => {
  start();
  native.open
    .mockResolvedValueOnce({ handle: 'doc-1', name: 'first.md', text: markdown(), revision: 2 })
    .mockResolvedValueOnce({ handle: 'doc-2', name: 'second.md', text: markdown('graph TD\n  B --> C\n'), revision: 4 });
  native.inspect.mockResolvedValue(unchanged);
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(screen.getByRole('tab',{name:'first.md'})).toHaveAttribute('aria-selected', 'true'));
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(screen.getByRole('tab',{name:'second.md'})).toHaveAttribute('aria-selected', 'true'));
  native.inspect.mockClear();
  fireEvent.click(screen.getByRole('tab',{name:'first.md'}));
  await waitFor(() => expect(native.inspect).toHaveBeenCalledWith({ handle: 'doc-1' }));
  expect(native.inspect).not.toHaveBeenCalledWith({ handle: 'doc-2' });
  expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n');
});

test('Save As releases the previous handle, so the new path is the only one watched and autosaved', async () => {
  await openMarkdown();
  native.inspect.mockResolvedValue(unchanged);
  native.write.mockResolvedValue(3);
  await requestDocument(native.documentRequests, 'save-as');
  native.create.mockImplementation(async(args:{text:string})=>({ handle: 'doc-2', name: 'renamed.md', text: args.text, revision: 1 }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose destination…' }));
  await waitFor(() => expect(screen.getByRole('tab',{name:'renamed.md'})).toHaveAttribute('aria-selected', 'true'));
  await waitFor(() => expect(native.release).toHaveBeenCalledWith({ handle: 'doc-1' }));
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: 'graph TD\n  NEW --> PATH\n' } });
  await waitFor(() => expect(native.write).toHaveBeenCalledOnce(), { timeout: 2500 });
  expect(native.write.mock.calls[0][0]).toMatchObject({ handle: 'doc-2', revision: 1 });
});

test('a reload that cannot be applied keeps the conflict live and its adopted revision savable', async () => {
  await openMarkdown();
  const broken = 'not an orei document';
  native.inspect.mockResolvedValue(changedMarkdown(broken));
  native.reload.mockResolvedValue({ text: broken, revision: 3 });
  const dialog = await screen.findByRole('dialog', undefined, { timeout: 3000 });
  await waitFor(() => expect(dialog).toHaveTextContent(/cannot be applied/));
  // The registry adopted the unparseable file, so the next poll reports no change. That must
  // not clear the conflict and leave the queue expecting a revision the registry no longer has.
  native.inspect.mockResolvedValue({ revision: 3, text: broken, missing: false, changed: false, error: null, retained: [] });
  await new Promise(resolve => setTimeout(resolve, 1400));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n');

  // Fixing the file recovers the document from the same dialog...
  native.reload.mockResolvedValue({ text: markdown('graph TD\n  FIXED --> DISK\n'), revision: 4 });
  native.inspect.mockResolvedValue({ ...unchanged, revision: 4 });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reload Disk' }));
  await waitFor(() => expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n  FIXED --> DISK\n'));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  // ...and the following autosave uses the adopted revision instead of looping on a conflict.
  native.write.mockResolvedValue(5);
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: 'graph TD\n  SAVED --> AFTER\n' } });
  await waitFor(() => expect(native.write).toHaveBeenCalledOnce(), { timeout: 2500 });
  expect(native.write.mock.calls[0][0]).toMatchObject({ handle: 'doc-1', revision: 4 });
});

test('an edit kept over an adopted reload stays a live conflict instead of being autosaved over it', async () => {
  await openMarkdown();
  const external = markdown('graph TD\n  DISK --> ADOPTED\n');
  let finishReload!: (value: { text: string; revision: number }) => void;
  native.inspect.mockResolvedValue(changedMarkdown(external));
  native.reload.mockImplementation(() => new Promise(resolve => { finishReload = resolve; }));
  await waitFor(() => expect(native.reload).toHaveBeenCalledOnce());
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: 'graph TD\n  LOCAL --> NEWER\n' } });
  finishReload({ text: external, revision: 3 });
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(dialog).toHaveTextContent('File changed on disk'));
  // Native adopted the disk version, so inspection now reports no change; the conflict must
  // survive so the external version cannot be overwritten by autosave without a decision.
  native.inspect.mockResolvedValue({ revision: 3, text: external, missing: false, changed: false, error: null, retained: [] });
  native.write.mockResolvedValue(4);
  await new Promise(resolve => setTimeout(resolve, 1400));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(native.write).not.toHaveBeenCalled();
  expect(within(dialog).getByLabelText('Version on disk')).toHaveTextContent('DISK --> ADOPTED');
});

test('Keep Local names a version displaced by a late external edit and keeps it for Reload Disk', async () => {
  const disk = markdown('graph TD\n  SHOWN --> DISK\n');
  const dialog = await conflictedMarkdown('graph TD\n  LOCAL --> WIN\n', disk);
  const stage = '/tmp/orei/.orei-save-99-0.tmp';
  const late = markdown('graph TD\n  LATE --> WRITER\n');
  native.overwrite.mockResolvedValue({ revision: 6, retained: [{ member: 'doc.md', text: late, path: stage }] });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Keep Local (overwrite)' }));
  await waitFor(() => expect(native.overwrite).toHaveBeenCalledOnce());
  expect(native.overwrite.mock.calls[0][0]).toMatchObject({ handle: 'doc-1', shown: disk });
  await waitFor(() => expect(within(dialog).getByLabelText('Preserved version')).toHaveTextContent('LATE --> WRITER'));
  expect(dialog).toHaveTextContent(stage);
  expect(dialog).toHaveTextContent(/replaced on disk/i);
  expect(screen.getByLabelText('Diagram source')).toHaveValue('graph TD\n  LOCAL --> WIN\n');

  // The conflict (and the preserved copy) stays until the displaced version is acknowledged.
  native.inspect.mockResolvedValue({ ...unchanged, revision: 7 });
  await new Promise(resolve => setTimeout(resolve, 1400));
  expect(screen.getByRole('dialog')).toBeInTheDocument();

  // A second explicit Keep Local replaces only the version now shown, so nothing is retained.
  native.overwrite.mockResolvedValue({ revision: 7, retained: [] });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Keep Local (overwrite)' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  const second = native.overwrite.mock.calls[1][0] as { shown: string };
  expect(second.shown).toContain('LOCAL --> WIN');
  expect(second.shown).not.toContain('SHOWN --> DISK');
});

test('Keep Local surfaces a draft-recovery failure and Save still retries with the adopted revision', async () => {
  const dialog = await conflictedMarkdown('graph TD\n  RECOVERY --> KEEP\n', markdown('graph TD\n  DISK --> LOST\n'));
  native.overwrite.mockResolvedValue({ revision: 5, retained: [] });
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
  let failure!: HTMLElement;
  try {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep Local (overwrite)' }));
    failure = await screen.findByRole('dialog', { name: 'Could not save document' });
    expect(failure).toHaveTextContent('Draft recovery failed');
    expect(screen.getByText('Save failed')).toBeInTheDocument();
  } finally { write.mockRestore(); }
  fireEvent.click(within(failure).getByRole('button', { name: 'OK' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  native.write.mockReset();
  native.write.mockResolvedValue(6);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(native.write).toHaveBeenCalledOnce());
  expect(native.write.mock.calls[0][0]).toMatchObject({ handle: 'doc-1', revision: 5 });
});

test('a conflict paused on a background tab opens its dialog when the tab becomes active again', async () => {
  start();
  native.open
    .mockResolvedValueOnce({ handle: 'doc-1', name: 'first.md', text: markdown(), revision: 2 })
    .mockResolvedValueOnce({ handle: 'doc-2', name: 'second.md', text: markdown('graph TD\n  B --> C\n'), revision: 2 });
  native.inspect.mockResolvedValue(unchanged);
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(screen.getByRole('tab',{name:'first.md'})).toHaveAttribute('aria-selected', 'true'));

  native.write.mockRejectedValue(new Error('Document changed on disk'));
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: 'graph TD\n  LOCAL --> EDIT\n' } });
  native.inspect.mockImplementation(async (args: { handle: string }) => args.handle === 'doc-1'
    ? changedMarkdown(markdown('graph TD\n  DISK --> CHANGE\n'))
    : unchanged);
  const dialog = await screen.findByRole('dialog', undefined, { timeout: 3000 });
  await waitFor(() => expect(dialog).toHaveTextContent('File changed on disk'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Keep paused' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  // The tab stays paused in the background without a dialog forcing itself over another tab.
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(screen.getByRole('tab',{name:'second.md'})).toHaveAttribute('aria-selected', 'true'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

  // Returning to it surfaces the unresolved conflict instead of a silently paused tab.
  fireEvent.click(screen.getByRole('tab',{name:'first.md'}));
  const reopened = await screen.findByRole('dialog');
  await waitFor(() => expect(reopened).toHaveTextContent('File changed on disk'));
  expect(within(reopened).getByRole('button', { name: 'Reload Disk' })).toBeEnabled();
});
