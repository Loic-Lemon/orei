import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from '../src/App';
import { applyImageStyle, imageStyleControlLabel } from '../src/image-styling';
import { markdownAssetPaths } from '../src/markdown-assets';
import { encodePairedAssets } from '../src/paired-document';
import { DRAFTS_KEY, WORKSPACE_VERSION, WORKSPACE_VERSION_KEY } from '../src/workspace';
import { ensureFixtures } from './seed';
import { pngDataUrl } from './png-fixture';

type AssetFile = { path: string; data: string; kind: string };
type MarkdownRow = { handle: string; name: string; text: string; revision: number; files: AssetFile[] };
type PairRow = {
  handle: string; base: string; source_name: string; source: string;
  css_name: string | null; css: string | null;
  assets_name: string | null; assets: string | null;
  revisions: { source: number; css: number | null; assets: number | null };
};

const native = vi.hoisted(() => ({
  rows: [] as MarkdownRow[],
  open: vi.fn(), prepare: vi.fn(), create: vi.fn(), write: vi.fn(), paired: vi.fn(),
  copy: vi.fn(), pairCopy: vi.fn(), image: vi.fn(), asset: vi.fn(), readAssets: vi.fn(),
  preferences: { defaultNotesFolder: null as string | null, defaultAttachmentsFolder: null as string | null },
  listeners: new Map<string, Set<(event: unknown) => void>>(),
}));

const rendered = vi.hoisted(() => ({ documents: [] as Array<{ source: string; css: string; assets: Record<string, string> }> }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: any) => {
    if (command === 'get_markdown_preferences') return native.preferences;
    if (command === 'set_markdown_preferences') { native.preferences = args.preferences; return true; }
    if (command === 'open_named_document') return native.open();
    if (command === 'prepare_markdown_destination') return native.prepare(args);
    if (command === 'create_markdown_document') return native.create(args);
    if (command === 'write_markdown_document') return { revision: await native.write(args), published: [] };
    if (command === 'write_paired_document') return native.paired(args);
    if (command === 'save_markdown_copy') return native.copy(args);
    if (command === 'save_paired_copy') return native.pairCopy(args);
    if (command === 'choose_markdown_attachments') return '../attachments';
    if (command === 'cancel_markdown_destination') return true;
    if (command === 'read_markdown_assets') return native.readAssets(args);
    if (command === 'read_paired_asset') return native.asset(args);
    if (command === 'import_image_file') return native.image();
    if (command === 'markdown_root_ready') return false;
    if (command === 'close_listener_ready') return false;
    if (command === 'release_named_document' || command === 'release_paired_document') return true;
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, listener: (event: unknown) => void) => {
    const set = native.listeners.get(name) ?? new Set();
    set.add(listener);
    native.listeners.set(name, set);
    return () => { set.delete(listener); };
  },
}));

vi.mock('../src/runner', () => ({ startRunner: vi.fn() }));
vi.mock('../src/rendering', () => ({
  renderDiagram: async (document: { source: string; css: string; assets: Record<string, string> }) => {
    rendered.documents.push(document);
    return { svg: '<svg/>', width: 100, height: 100 };
  },
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const spy of [native.open, native.prepare, native.create, native.write, native.paired, native.copy, native.pairCopy, native.image, native.asset, native.readAssets]) spy.mockReset();
  native.rows = [];
  native.preferences = { defaultNotesFolder: null, defaultAttachmentsFolder: null };
  native.listeners.clear();
  rendered.documents = [];
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

const reference = 'photo.png';
const baseCss = '.pele {\n  --pele-border: #0284c7;\n}\n';
const doc = (source = `flowchart LR\n  A@{ img: "${reference}", w: 8, h: 8, constraint: "on" }\n`, css = baseCss, data = pngDataUrl(8, 8)) => ({
  source,
  css,
  assets: { [reference]: data },
});
const cssWith = (values: { radius: number; borderWidth: number; borderColor: string }): string => {
  const result = applyImageStyle(baseCss, reference, values);
  if ('problem' in result) throw new Error(result.problem);
  return result.css;
};
const pair = (overrides: Partial<PairRow> = {}): PairRow => ({
  handle: 'pair-handle', base: 'pick', source_name: 'pick.mmd',
  source: doc().source, css_name: null, css: null,
  assets_name: null, assets: null,
  revisions: { source: 1, css: null, assets: null },
  ...overrides,
});

function renderApp() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  return render(<App />);
}
function start(documents?: Record<string, ReturnType<typeof doc>>, active?: string) {
  native.prepare.mockResolvedValue({ destination: 'destination', attachments: '../attachments', namespace: 'saved-note' });
  if (documents) {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify({ documents, active: active ?? Object.keys(documents)[0] }));
    localStorage.setItem(WORKSPACE_VERSION_KEY, WORKSPACE_VERSION);
  } else ensureFixtures();
  return renderApp();
}
const styling = () => fireEvent.click(screen.getByRole('radio', { name: 'Styling' }));
const diagram = () => fireEvent.click(screen.getByRole('radio', { name: 'Diagram' }));
const stylesheet = () => screen.getByLabelText('Diagram stylesheet') as HTMLTextAreaElement;
const cog = (value = reference) => screen.getByRole('button', { name: imageStyleControlLabel(value) });
const openStyle = async (value = reference) => {
  fireEvent.click(cog(value));
  return screen.findByRole('dialog');
};
const apply = async (dialog: HTMLElement) => {
  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
};

test('each imported or pasted PNG has a thumbnail and a cog whose dialog previews it', async () => {
  native.image.mockResolvedValue({ name: 'photo.png', data: pngDataUrl(8, 8) });
  start();
  fireEvent.click(screen.getByRole('button', { name: 'New document' }));
  styling();
  fireEvent.click(screen.getByRole('button', { name: 'Import PNG…' }));
  await waitFor(() => expect(within(screen.getByLabelText('Local images')).getByText('photo.png', { selector: 'code' })).toBeInTheDocument());

  diagram();
  const data = pngDataUrl(480, 240);
  const file = new File([Uint8Array.from(atob(data.split(',')[1]), byte => byte.charCodeAt(0))], 'clip.png', { type: 'image/png' });
  const editor = screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  editor.setSelectionRange(editor.value.length, editor.value.length);
  fireEvent.paste(editor, { clipboardData: { files: [file] } });
  await waitFor(() => expect((screen.getByLabelText('Diagram source') as HTMLTextAreaElement).value).toContain('pasted-image.png'));
  styling();

  expect(screen.getByRole('img', { name: 'Thumbnail of photo.png' })).toHaveAttribute('src', pngDataUrl(8, 8));
  expect(screen.getByRole('img', { name: 'Thumbnail of pasted-image.png' })).toBeInTheDocument();
  expect(cog('photo.png')).toBeInTheDocument();
  expect(cog('pasted-image.png')).toBeInTheDocument();

  const dialog = await openStyle('pasted-image.png');
  expect(dialog).toHaveTextContent('Every node that uses pasted-image.png');
  expect(within(dialog).getByRole('img', { name: 'Preview of pasted-image.png' })).toBeInTheDocument();
  await waitFor(() => expect(within(dialog).getByLabelText('Corner radius')).toHaveFocus());
});

test('Apply previews live, records one Styling undo step, and Undo/Redo restore it', async () => {
  start({ Styled: doc(doc().source, baseCss, pngDataUrl(200, 150)) });
  styling();
  const dialog = await openStyle();
  const preview = within(dialog).getByAltText(`Preview of ${reference}`);
  fireEvent.change(within(dialog).getByLabelText('Corner radius'), { target: { value: '12' } });
  fireEvent.change(within(dialog).getByLabelText('Border width'), { target: { value: '3' } });
  fireEvent.change(within(dialog).getByLabelText('Border color'), { target: { value: '#235d56' } });
  expect(preview.parentElement).toHaveStyle({ borderRadius: '12px' });
  expect(preview.parentElement?.querySelector('.image-style-preview-border')).toHaveStyle({ borderWidth: '3px', borderColor: '#235d56' });
  expect(stylesheet().value).toBe(baseCss);

  await apply(dialog);
  expect(stylesheet().value).toContain('orei:image-styles:v1');
  expect(stylesheet().value).toContain('"radius":12');
  await waitFor(() => expect(rendered.documents.at(-1)?.css).toContain('orei:image-styles:v1'));
  expect(JSON.parse(localStorage.getItem('orei-drafts-v1')!).documents.Styled.css).toContain('orei:image-styles:v1');

  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(stylesheet().value).toBe(baseCss);
  expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
  expect(stylesheet().value).toContain('orei:image-styles:v1');
  // One Apply is exactly one step in each direction.
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(stylesheet().value).toBe(baseCss);
});

test('Cancel, Escape and Reset discard the draft; Reset then Apply restores defaults', async () => {
  const seeded = cssWith({ radius: 12, borderWidth: 3, borderColor: '#235d56' });
  start({ Styled: doc(doc().source, seeded) });
  styling();

  let dialog = await openStyle();
  fireEvent.change(within(dialog).getByLabelText('Corner radius'), { target: { value: '30' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(stylesheet().value).toBe(seeded);
  await waitFor(() => expect(cog()).toHaveFocus());

  dialog = await openStyle();
  expect(within(dialog).getByLabelText('Corner radius')).toHaveValue(12);
  fireEvent.change(within(dialog).getByLabelText('Corner radius'), { target: { value: '4' } });
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(stylesheet().value).toBe(seeded);
  await waitFor(() => expect(cog()).toHaveFocus());

  dialog = await openStyle();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reset' }));
  expect(within(dialog).getByLabelText('Corner radius')).toHaveValue(0);
  expect(within(dialog).getByLabelText('Border width')).toHaveValue(0);
  expect(within(dialog).getByLabelText('Border color')).toBeDisabled();
  await apply(dialog);
  expect(stylesheet().value).toBe(baseCss);
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(stylesheet().value).toBe(seeded);
});

test('Apply with default values does not dirty a document', async () => {
  start({ Plain: doc() });
  styling();
  const dialog = await openStyle();
  await apply(dialog);
  expect(stylesheet().value).toBe(baseCss);
  expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
  expect(JSON.parse(localStorage.getItem('orei-drafts-v1')!).documents.Plain.css).toBe(baseCss);
});

test('styles stay with the document and reference that opened the cog', async () => {
  const other = pngDataUrl(9, 9);
  start({
    Alpha: doc(doc().source, `${baseCss}.alpha { color: red; }\n`),
    Beta: doc(doc().source, `${baseCss}.beta { color: blue; }\n`, other),
  }, 'Alpha');
  styling();
  const dialog = await openStyle();
  fireEvent.change(within(dialog).getByLabelText('Corner radius'), { target: { value: '5' } });
  await apply(dialog);
  expect(stylesheet().value).toContain('"radius":5');

  fireEvent.click(screen.getByRole('tab', { name: 'Beta' }));
  styling();
  expect(stylesheet().value).not.toContain('orei:image-styles');
  expect(screen.getByRole('img', { name: `Thumbnail of ${reference}` })).toHaveAttribute('src', other);

  fireEvent.click(screen.getByRole('tab', { name: 'Alpha' }));
  styling();
  expect(stylesheet().value).toContain('"radius":5');
});

test('Apply refuses an image removed while the dialog is open', async () => {
  start({ Styled: doc() });
  styling();
  const dialog = await openStyle();
  fireEvent.change(within(dialog).getByLabelText('Corner radius'), { target: { value: '8' } });
  // The modal hides the app from assistive technology, but a programmatic action can still
  // remove the asset before Apply; the write must validate the image again.
  fireEvent.click(screen.getByRole('button', { name: `Remove image ${reference}`, hidden: true }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(dialog).toHaveTextContent('no longer stored in this document'));
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(stylesheet().value).toBe(baseCss);
});

test('Apply refuses a different PNG imported under the same reference', async () => {
  const replacement = pngDataUrl(16, 8);
  native.image.mockResolvedValue({ name: reference, data: replacement });
  start({ Styled: doc() });
  styling();
  const dialog = await openStyle();
  fireEvent.change(within(dialog).getByLabelText('Corner radius'), { target: { value: '8' } });
  fireEvent.click(screen.getByRole('button', { name: `Remove image ${reference}`, hidden: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Import PNG…', hidden: true }));
  await waitFor(() => expect(screen.getByAltText(`Thumbnail of ${reference}`)).toHaveAttribute('src', replacement));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(dialog).toHaveTextContent('changed while this dialog was open'));
  expect(stylesheet().value).toBe(baseCss);
});

test('Apply refuses a changed active document instead of writing its stylesheet', async () => {
  start({
    Alpha: doc(doc().source, `${baseCss}.alpha {}\n`),
    Beta: doc(doc().source, `${baseCss}.beta {}\n`),
  }, 'Alpha');
  styling();
  const dialog = await openStyle();
  fireEvent.change(within(dialog).getByLabelText('Corner radius'), { target: { value: '8' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Beta', hidden: true }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(dialog).toHaveTextContent('active document changed'));
  expect(JSON.parse(localStorage.getItem('orei-drafts-v1')!).documents.Beta.css).toBe(`${baseCss}.beta {}\n`);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('styling survives draft recovery and malformed metadata reports defaults', async () => {
  const seeded = cssWith({ radius: 12, borderWidth: 3, borderColor: '#235d56' });
  const first = start({ Recovered: doc(doc().source, seeded) });
  first.unmount();
  renderApp();
  expect(screen.getByRole('tab', { name: 'Recovered' })).toHaveAttribute('aria-selected', 'true');
  styling();
  expect(stylesheet().value).toBe(seeded);
  let dialog = await openStyle();
  expect(within(dialog).getByLabelText('Corner radius')).toHaveValue(12);
  expect(within(dialog).getByLabelText('Border width')).toHaveValue(3);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  cleanup();
  localStorage.clear();
  const malformed = `${baseCss}/* orei:image-styles:v1 {"images": */\n`;
  start({ Malformed: doc(doc().source, malformed) });
  styling();
  expect(screen.getByRole('alert')).toHaveTextContent(/malformed/);
  dialog = await openStyle();
  expect(within(dialog).getByRole('alert')).toHaveTextContent(/malformed/);
  expect(within(dialog).getByLabelText('Corner radius')).toHaveValue(0);
  expect(within(dialog).getByLabelText('Border width')).toHaveValue(0);
  expect(within(dialog).getByRole('button', { name: 'Apply' })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(stylesheet().value).toBe(malformed);
});

test('native edit, settings, document and export commands wait while the image dialog is open', async () => {
  start({ Styled: doc() });
  await waitFor(() => expect(native.listeners.get('edit-request')?.size).toBeGreaterThan(0));
  styling();
  const dialog = await openStyle();
  fireEvent.change(within(dialog).getByLabelText('Corner radius'), { target: { value: '20' } });
  const before = stylesheet().value;
  act(() => { for (const listener of native.listeners.get('edit-request')!) listener({ payload: 'undo' }); });
  expect(stylesheet().value).toBe(before);
  act(() => { for (const listener of native.listeners.get('settings-request')!) listener({}); });
  act(() => { for (const listener of native.listeners.get('document-request')!) listener({ payload: 'save-as' }); });
  act(() => { for (const listener of native.listeners.get('export-request')!) listener({}); });
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByRole('dialog')).toBe(dialog);

  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  // Once the modal is gone, Settings can open normally.
  act(() => { for (const listener of native.listeners.get('settings-request')!) listener({}); });
  expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
});

test('a Markdown save attaches the unchanged PNG and carries the style through reopen', async () => {
  const data = pngDataUrl(8, 8);
  native.create.mockImplementation(async (args: { destination: string; text: string; files: AssetFile[] }) => {
    const row = { handle: 'styled-note', name: 'Styled.md', text: args.text, revision: 1, files: args.files };
    native.rows.push(row);
    return row;
  });
  native.readAssets.mockImplementation(async (args: { references: { path: string; kind: string }[] }) => {
    const row = native.rows[0];
    return args.references.map(item => {
      const file = row.files.find(candidate => item.path.endsWith(candidate.path))!;
      return { path: item.path, data: file.data, kind: item.kind };
    });
  });
  const first = start({ Styled: doc(doc().source, baseCss, data) });
  styling();
  let dialog = await openStyle();
  fireEvent.change(within(dialog).getByLabelText('Corner radius'), { target: { value: '9' } });
  fireEvent.change(within(dialog).getByLabelText('Border width'), { target: { value: '2' } });
  fireEvent.change(within(dialog).getByLabelText('Border color'), { target: { value: '#235d56' } });
  await apply(dialog);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(native.create).toHaveBeenCalledOnce());

  const saved = native.rows[0];
  const imageFile = saved.files.find(file => file.kind === 'image')!;
  const cssFile = saved.files.find(file => file.kind === 'css')!;
  expect(imageFile.data).toBe(data);
  expect(cssFile.data).toContain('orei:image-styles:v1');
  expect(cssFile.data).toContain('"radius":9');
  expect(markdownAssetPaths(saved.text)?.assets[reference]).toBeDefined();
  expect(markdownAssetPaths(saved.text)?.css).toBeTruthy();
  expect(saved.text).not.toContain(data);

  first.unmount();
  localStorage.clear();
  native.open.mockResolvedValue({ handle: 'styled-note', name: 'Styled.md', text: saved.text, revision: 2 });
  renderApp();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Styled.md' })).toHaveAttribute('aria-selected', 'true'));
  styling();
  expect(stylesheet().value).toContain('orei:image-styles:v1');
  dialog = await openStyle();
  expect(within(dialog).getByLabelText('Corner radius')).toHaveValue(9);
  expect(within(dialog).getByLabelText('Border width')).toHaveValue(2);
});

test('styling a paired document without a stylesheet companion creates one and keeps the PNG bytes', async () => {
  const data = pngDataUrl(8, 8);
  const opened = pair({
    source: doc().source,
    assets_name: 'pick.orei-assets.json',
    assets: encodePairedAssets({ [reference]: data }),
    revisions: { source: 1, css: null, assets: 1 },
  });
  native.open.mockResolvedValue(opened);
  native.paired.mockResolvedValue({ revisions: { source: 2, css: 1, assets: 1 }, written: ['source', 'stylesheet', 'asset index'], failure: null });
  const first = start();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect((screen.getByLabelText('Diagram source') as HTMLTextAreaElement).value).toContain(reference));
  styling();
  const dialog = await openStyle();
  fireEvent.change(within(dialog).getByLabelText('Corner radius'), { target: { value: '10' } });
  await apply(dialog);

  await waitFor(() => expect(native.paired).toHaveBeenCalled(), { timeout: 2500 });
  const written = native.paired.mock.calls.at(-1)![0] as { source: string; css: string | null; assets: string | null };
  expect(written.css).toContain('orei:image-styles:v1');
  expect(written.css).toContain('"radius":10');
  expect(written.source).toContain(`img: "${reference}"`);
  expect(JSON.parse(written.assets!).assets[reference].data).toBe(data);

  first.unmount();
  localStorage.clear();
  native.open.mockResolvedValue(pair({
    source: written.source,
    css_name: 'pick.css',
    css: written.css,
    assets_name: 'pick.orei-assets.json',
    assets: written.assets,
    revisions: { source: 2, css: 1, assets: 1 },
  }));
  renderApp();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(screen.getByRole('tab', { name: 'pick.mmd' })).toHaveAttribute('aria-selected', 'true'));
  styling();
  expect(stylesheet().value).toContain('"radius":10');
  const reopened = await openStyle();
  expect(within(reopened).getByLabelText('Corner radius')).toHaveValue(10);
});
