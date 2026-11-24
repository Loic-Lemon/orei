import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from '../src/App';
import {ensureFixtures,seedDocument,seedFixtures} from './seed';
import { defaultCSS } from '../src/fixtures';

const native = vi.hoisted(() => ({ save: vi.fn(), write: vi.fn(), open: vi.fn(), settingsListeners: new Set<() => void>() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: (options: unknown) => native.save(options) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async (command: string, args?: { path: string; bytes: number[] }) => {
  if (command === 'save_output') return native.write(args);
  if (command === 'open_named_document') return native.open();
  if (command === 'close_listener_ready') return false;
}) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name: string, listener: () => void) => {
  if (name === 'settings-request') { native.settingsListeners.add(listener); return () => native.settingsListeners.delete(listener); }
  return () => {};
} }));
vi.mock('../src/runner', () => ({ startRunner: vi.fn() }));

beforeAll(() => { Element.prototype.scrollIntoView ??= () => {}; });
beforeEach(() => {
  native.save.mockReset(); native.write.mockReset(); native.open.mockReset(); native.settingsListeners.clear();
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  localStorage.removeItem('orei-app-theme');
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); });

const start = async () => {
  ensureFixtures();
  render(<App/>);
  await screen.findByText('Current preview');
  return screen.getByRole('button', { name: 'Export' });
};
const openExport = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await screen.findByRole('dialog');
};
const choose = async (label:string, option:string) => {
  fireEvent.click(screen.getByLabelText(label));
  await screen.findByRole('listbox');
  fireEvent.click([...screen.getAllByRole('option')].find(e => e.textContent === option)!);
};
const chooseAppearance = async (name:string) => {
  await waitFor(() => expect(native.settingsListeners.size).toBeGreaterThan(0));
  act(() => { for (const listener of native.settingsListeners) listener(); });
  const settings = await screen.findByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(settings).getByRole('radio', { name: new RegExp(name) }));
  fireEvent.click(within(settings).getByRole('button', { name: 'Done' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
};
const savedBytes = () => new TextDecoder().decode(new Uint8Array(native.write.mock.calls[0][0].bytes));

test('Save SVG offers the native destination and writes the current composition there', async () => {
  await start(); await openExport();
  native.save.mockResolvedValue('/tmp/diagram.svg');
  fireEvent.click(screen.getByRole('button', { name: 'Save SVG' }));
  await waitFor(() => expect(native.write).toHaveBeenCalledOnce());
  expect(native.save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: 'diagram.svg', filters: [{ name: 'SVG', extensions: ['svg'] }] }));
  expect(native.write.mock.calls[0][0]).toMatchObject({ path: '/tmp/diagram.svg' });
  const svg = new DOMParser().parseFromString(savedBytes(), 'image/svg+xml');
  expect(svg.querySelector('text')?.textContent).toBe('Ordinary label');
  expect(Number(svg.documentElement.getAttribute('width'))).toBeGreaterThan(0);
  expect(await screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('the canvas appearance follows the app theme by default, overrides independently, and exports the authored background', async () => {
  const color = '#f3ece2';
  const css = defaultCSS.replace('#ffffff', color);
  seedDocument('Canvas test', {
    source: 'flowchart LR\n  A --> B',
    css,
    assets: {},
  });
  // jsdom has no matchMedia, so simulate system appearance changes.
  const system = { dark: false, listeners: new Set<() => void>() };
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return system.dark; },
    media: query,
    addEventListener: (_: string, listener: () => void) => { system.listeners.add(listener); },
    removeEventListener: (_: string, listener: () => void) => { system.listeners.delete(listener); },
  }));
  vi.stubGlobal('CSS', { supports: () => true });
  const flipSystem = () => act(() => { system.listeners.forEach(listener => listener()); });
  try {
    await start();
    const canvas = screen.getByRole('region', { name: 'Preview canvas' });
    const appTheme = canvas.closest('.radix-themes');
    const preview = screen.getByTestId('preview').shadowRoot!;
    const diagram = preview.querySelector('svg');
    expect(canvas).toHaveAttribute('data-canvas-appearance', 'app');
    expect(appTheme).toHaveClass('light');
    expect(canvas.style.getPropertyValue('--document-canvas')).toBe(color);
    expect(preview.querySelector('style')?.textContent)
      .toContain('svg > [data-orei-canvas] { display: none; }');

    // Match app (default): a System appearance change re-resolves the backdrop
    // without re-rendering the diagram.
    system.dark = true; flipSystem();
    expect(canvas).toHaveAttribute('data-canvas-appearance', 'app');
    expect(appTheme).toHaveClass('dark');
    expect(document.querySelector('.workspace')).toHaveAttribute('data-appearance','dark');
    expect(document.documentElement.style.colorScheme).toBe('');
    expect(preview.querySelector('svg')).toBe(diagram);
    expect(screen.getByLabelText('Diagram stylesheet')).toHaveValue(css);

    // An explicit choice overrides the app theme.
    await choose('Canvas appearance', 'Document');
    expect(canvas).toHaveAttribute('data-canvas-appearance', 'document');
    expect(canvas.style.getPropertyValue('--document-canvas')).toBe(color);
    system.dark = false; flipSystem();
    expect(document.querySelector('.workspace')).toHaveAttribute('data-appearance','light');
    expect(canvas).toHaveAttribute('data-canvas-appearance', 'document');
    await choose('Canvas appearance', 'Light');
    expect(canvas).toHaveAttribute('data-canvas-appearance', 'light');
    await chooseAppearance('Slate Dark');
    expect(canvas).toHaveAttribute('data-canvas-appearance', 'light');
    expect(preview.querySelector('svg')).toBe(diagram);
    expect(screen.getByLabelText('Diagram stylesheet')).toHaveValue(css);
    await chooseAppearance('Light');

    // Restoring Match app follows the app appearance again.
    await choose('Canvas appearance', 'Match app');
    expect(canvas).toHaveAttribute('data-canvas-appearance', 'app');
    expect(appTheme).toHaveClass('light');
    await chooseAppearance('Slate Dark');
    expect(canvas).toHaveAttribute('data-canvas-appearance', 'app');
    expect(appTheme).toHaveAttribute('data-gray-color', 'slate');
    await chooseAppearance('Ink Dark');
    expect(canvas).toHaveAttribute('data-canvas-appearance', 'app');
    expect(appTheme).toHaveAttribute('data-gray-color', 'gray');
    await chooseAppearance('Warm Dark');
    expect(canvas).toHaveAttribute('data-canvas-appearance', 'app');
    expect(appTheme).toHaveAttribute('data-gray-color', 'sand');
    await chooseAppearance('Light');
    expect(preview.querySelector('svg')).toBe(diagram);

    await openExport();
    native.save.mockResolvedValue('/tmp/diagram.svg');
    fireEvent.click(screen.getByRole('button', { name: 'Save SVG' }));
    await waitFor(() => expect(native.write).toHaveBeenCalledOnce());
    const svg = new DOMParser().parseFromString(savedBytes(), 'image/svg+xml');
    expect(svg.querySelector('[data-orei-canvas]')?.getAttribute('fill')).toBe(color);
    expect(svg.querySelector('style')).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});

test('exporting is zoom and pan independent: the same composition is saved at any preview zoom', async () => {
  await start(); await openExport();
  native.save.mockResolvedValue('/tmp/diagram.svg');
  fireEvent.click(screen.getByRole('button', { name: 'Save SVG' }));
  await waitFor(() => expect(native.write).toHaveBeenCalledOnce());
  const zoomed = savedBytes();

  fireEvent.change(screen.getByLabelText('Preview zoom'), { target: { value: '50' } });
  fireEvent.blur(screen.getByLabelText('Preview zoom'));
  await openExport();
  native.save.mockResolvedValue('/tmp/diagram-2.svg');
  fireEvent.click(screen.getByRole('button', { name: 'Save SVG' }));
  await waitFor(() => expect(native.write).toHaveBeenCalledTimes(2));
  expect(savedBytes()).toBe(zoomed);
  expect(zoomed).toContain('Ordinary label');
});

test('a fresh render under a different app theme exports the same diagram', async () => {
  await start();
  native.save.mockResolvedValue('/tmp/diagram.svg');
  await openExport();
  fireEvent.click(screen.getByRole('button', { name: 'Save SVG' }));
  await waitFor(() => expect(native.write).toHaveBeenCalledOnce());
  const light = savedBytes();

  await chooseAppearance('Warm Dark');
  const source = screen.getByLabelText<HTMLTextAreaElement>('Diagram source');
  const original = source.value;
  const preview = screen.getByTestId('preview').shadowRoot!;
  fireEvent.change(source, { target: { value: `${original}\n  X[Theme isolation probe]` } });
  await waitFor(() => expect(preview.textContent).toContain('Theme isolation probe'));
  fireEvent.change(source, { target: { value: original } });
  await waitFor(() => expect(preview.textContent).not.toContain('Theme isolation probe'));
  await openExport();
  native.save.mockResolvedValue('/tmp/diagram-2.svg');
  fireEvent.click(screen.getByRole('button', { name: 'Save SVG' }));
  await waitFor(() => expect(native.write).toHaveBeenCalledTimes(2));
  expect(savedBytes()).toBe(light);
});

test('PNG scale and canvas choices are offered in the export dialog', async () => {
  await start(); await openExport();
  await choose('PNG scale', '2×');
  expect(screen.getByLabelText('PNG scale')).toHaveTextContent('2×');
  await choose('Canvas background', 'Transparent');
  expect(screen.getByLabelText('Canvas background')).toHaveTextContent('Transparent');
  await choose('Canvas background', 'Document background');
  expect(screen.getByLabelText('Canvas background')).toHaveTextContent('Document background');
});

test('canceling the destination dialog writes nothing and closes the export dialog', async () => {
  await start(); await openExport();
  native.save.mockResolvedValue(null);
  fireEvent.click(screen.getByRole('button', { name: 'Save SVG' }));
  await waitFor(() => expect(native.save).toHaveBeenCalledOnce());
  expect(native.write).not.toHaveBeenCalled();
  expect(await screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('a failed write keeps the dialog open and reports the error without replacing the previous output', async () => {
  await start(); await openExport();
  native.save.mockResolvedValue('/tmp/diagram.svg');
  native.write.mockRejectedValue(new Error('disk full'));
  fireEvent.click(screen.getByRole('button', { name: 'Save SVG' }));
  await screen.findByText(/disk full/);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(native.write).toHaveBeenCalledOnce();
});

test('an invalid source while the dialog is open disables saving and exports nothing stale', async () => {
  await start(); await openExport();
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: 'not a diagram' } });
  await screen.findByText(/Preview out of date/, {}, { timeout: 3000 });
  expect(screen.getByRole('button', { name: 'Save SVG' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save PNG' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save SVG' }));
  expect(native.save).not.toHaveBeenCalled();
  expect(native.write).not.toHaveBeenCalled();
});

test('Escape closes the export dialog and focus returns to Export', async () => {
  const exportButton = await start();
  await openExport();
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(document.activeElement).toBe(exportButton);
});

test('a paired Mermaid/CSS document exports through the same snapshot pipeline', async () => {
  // Same invoke seam the paired opener uses: no representation-specific export gate.
  native.open.mockResolvedValue({
    handle: 'pair-1', base: 'diagram', source_name: 'diagram.mmd', source: 'flowchart LR\n A[Paired label] --> B',
    css_name: 'diagram.css', css: defaultCSS, assets_name: null, assets: null,
    revisions: { source: 1, css: 1, assets: null },
  });
  ensureFixtures();
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  render(<App/>);
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(screen.getByRole('tab',{name:'diagram.mmd'})).toHaveAttribute('aria-selected', 'true'));
  await screen.findByText('Current preview');
  await openExport();
  native.save.mockResolvedValue('/tmp/paired.svg');
  fireEvent.click(screen.getByRole('button', { name: 'Save SVG' }));
  await waitFor(() => expect(native.write).toHaveBeenCalledOnce());
  const svg = new DOMParser().parseFromString(savedBytes(), 'image/svg+xml');
  expect([...svg.querySelectorAll('text')].map(e => e.textContent)).toContain('Paired label');
});
