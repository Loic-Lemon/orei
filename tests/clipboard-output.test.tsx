import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from '../src/App';
import {ensureFixtures,seedFixtures} from './seed';

const native = vi.hoisted(() => ({
  exportEnabled: false,
  copyEnabled: false,
  written: [] as Array<{ command: string; args?: unknown }>,
  failCopy: false,
  listeners: new Set<(event?: { payload: string }) => void>(),
  // One entry per canvas handed to toBlob, i.e. per exported raster: its width and the
  // background fillRect calls the PNG pipeline made on it.
  canvasRuns: [] as Array<{ width: number; height: number; fills: Array<{ fillStyle: string; rect: number[] }> }>,
}));

vi.mock('../src/runner', () => ({ startRunner: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: unknown) => {
    if (command === 'set_export_enabled') native.exportEnabled = (args as { enabled: boolean }).enabled;
    if (command === 'set_copy_enabled') native.copyEnabled = (args as { enabled: boolean }).enabled;
    if (command === 'copy_output_text' || command === 'copy_output_image') {
      if (native.failCopy) throw new Error('pasteboard denied');
      native.written.push({ command, args });
      return undefined;
    }
    return undefined;
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, listener: (event?: { payload: string }) => void) => {
    if (name === 'diagram-copy-request') native.listeners.add(listener);
    return () => native.listeners.delete(listener);
  }),
}));

beforeAll(() => { Element.prototype.scrollIntoView ??= () => {}; });
beforeEach(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  native.exportEnabled = false;
  native.copyEnabled = false;
  native.written.length = 0;
  native.failCopy = false;
  native.listeners.clear();
  native.canvasRuns.length = 0;
  // jsdom cannot rasterize; the webview-only raster seam is stubbed so the clipboard
  // payload plumbing runs. The encoded bytes come from the stub, not a real rasterization.
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:orei'), revokeObjectURL: vi.fn() }));
  HTMLImageElement.prototype.decode = async () => {};
  // Pele measures text through canvas.getContext('2d'); jsdom normally returns null and
  // Pele falls back to its estimator, so the stub must not hand back a bare context.
  (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).getContext = function (this: HTMLCanvasElement) {
    const record = { width: 0, height: 0, fills: [] as Array<{ fillStyle: string; rect: number[] }> };
    (this as unknown as Record<string, unknown>).__oreiRaster = record;
    const context = {
      fillStyle: '',
      fillRect: (...rect: number[]) => record.fills.push({ fillStyle: context.fillStyle, rect }),
      drawImage: () => {},
      measureText: () => ({ width: 0 }),
    };
    return context;
  };
  (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).toBlob = function (this: HTMLCanvasElement, done: (blob: Blob | null) => void) {
    const record = (this as unknown as Record<string, unknown>).__oreiRaster as { width: number; height: number; fills: Array<{ fillStyle: string; rect: number[] }> } | undefined;
    if (record) { record.width = this.width; record.height = this.height; native.canvasRuns.push(record); }
    done(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' }));
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  vi.unstubAllGlobals();
  const canvas = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  delete canvas.getContext;
  delete canvas.toBlob;
  const image = HTMLImageElement.prototype as unknown as Record<string, unknown>;
  delete image.decode;
});

const start = async () => {
  ensureFixtures();
  render(<App/>);
  await screen.findByText('Current preview');
  await waitFor(() => expect(native.copyEnabled).toBe(true), { timeout: 1000 });
  return native;
};
// The native side (menu_payload in src-tauri/src/main.rs) owns the id→payload mapping:
// the descriptive menu ids copy-image/copy-svg/copy-source become the short payloads
// asserted here, so the webview listener only ever sees 'image' | 'svg' | 'source'.
const menuCopy = (kind: string) => act(() => { for (const listener of native.listeners) listener({ payload: kind }); });
const copied = () => native.written.map(entry => entry.command);
const copiedText = () => (native.written.find(entry => entry.command === 'copy_output_text')!.args as { text: string }).text;

test('native Copy availability follows the export gate: image and SVG need a valid render', async () => {
  await start();
  expect(native.copyEnabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: 'not a diagram' } });
  await screen.findByText(/Preview out of date/, {}, { timeout: 3000 });
  await waitFor(() => expect(native.copyEnabled).toBe(false));
  // The Mermaid source copy stays usable: its command carries only the source text.
  menuCopy('source');
  await waitFor(() => expect(copied()).toContain('copy_output_text'));
  expect(copiedText()).toBe('not a diagram');
});

test('image and SVG copy are refused while the render is invalid', async () => {
  await start();
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: 'not a diagram' } });
  await screen.findByText(/Preview out of date/, {}, { timeout: 3000 });
  menuCopy('image');
  menuCopy('svg');
  expect(copied()).toEqual([]);
});

test('a valid render copies the standalone SVG and the raster image through distinct payloads', async () => {
  await start();
  menuCopy('svg');
  await waitFor(() => expect(copied()).toContain('copy_output_text'));
  expect(copiedText()).toContain('Ordinary label');
  const svgText = copiedText();
  menuCopy('image');
  await waitFor(() => expect(copied()).toContain('copy_output_image'));
  expect(copiedText()).toBe(svgText);
  expect(copied().at(-1)).toBe('copy_output_image');
});

test('source copying stays available while rendering is invalid, without touching output copy', async () => {
  await start();
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: 'not a diagram' } });
  await screen.findByText(/Preview out of date/, {}, { timeout: 3000 });
  menuCopy('source');
  await waitFor(() => expect(copied()).toEqual(['copy_output_text']));
});

test('copy action notices clear after four seconds, with the timer restarted by the same notice', async () => {
  await start();
  vi.useFakeTimers();
  try {
    menuCopy('source');
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('Copied Mermaid source.')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(3000); });
    menuCopy('source');
    await act(async () => { await Promise.resolve(); });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByText('Copied Mermaid source.')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.queryByText('Copied Mermaid source.')).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

test('the menu listener accepts exactly the short payloads the native side emits', async () => {
  await start();
  // Descriptive menu ids leaking through unchanged are ignored, never misrouted.
  menuCopy('copy-image');
  menuCopy('copy-svg');
  menuCopy('copy-source');
  expect(copied()).toEqual([]);
  menuCopy('source');
  await waitFor(() => expect(copied()).toEqual(['copy_output_text']));
});

test('a clipboard failure is reported in a dialog instead of claiming success', async () => {
  await start();
  // A success status must not survive a later failed attempt alongside the dialog.
  menuCopy('svg');
  await waitFor(() => expect(copied()).toContain('copy_output_text'));
  expect(screen.getByText(/Copied diagram SVG\./)).toBeInTheDocument();
  native.failCopy = true;
  menuCopy('svg');
  await screen.findByText('Could not copy diagram');
  expect(screen.getByText(/pasteboard denied/)).toBeInTheDocument();
  expect(screen.getByText(/The clipboard may have been cleared/)).toBeInTheDocument();
  expect(screen.queryByText(/Copied diagram SVG\./)).not.toBeInTheDocument();
});

test('copying the source of an empty document shows a quiet notice, not a failure dialog', async () => {
  await start();
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Copy source' }));
  expect(await screen.findByText(/Nothing to copy\./)).toBeInTheDocument();
  expect(copied()).toEqual([]);
  expect(screen.queryByText('Could not copy diagram')).not.toBeInTheDocument();
});

test('the Copy source button copies the current source and preserves the editor selection', async () => {
  await start();
  const editor = screen.getByLabelText('Diagram source') as HTMLTextAreaElement;
  editor.focus();
  editor.setSelectionRange(2, 7);
  const button = screen.getByRole('button', { name: 'Copy source' });
  // The button suppresses the mousedown default (focus transfer), so the editor keeps
  // focus and its selection: dispatchEvent is false when defaultPrevented was called.
  expect(button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))).toBe(false);
  expect(document.activeElement).toBe(editor);
  fireEvent.click(button);
  await waitFor(() => expect(copied()).toContain('copy_output_text'));
  expect(copiedText()).toBe(editor.value);
  expect(editor.selectionStart).toBe(2);
  expect(editor.selectionEnd).toBe(7);
  expect(document.activeElement).toBe(editor);
});

test('the Export dialog copies SVG with the chosen settings and closes on success', async () => {
  await start();
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'Copy SVG' }));
  await waitFor(() => expect(copied()).toContain('copy_output_text'));
  expect(copiedText()).toContain('Ordinary label');
  expect(await screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('the Export dialog copies the image with the chosen PNG scale and canvas choice', async () => {
  await start();
  menuCopy('svg');
  await waitFor(() => expect(copied()).toContain('copy_output_text'));
  // The standalone SVG carries the document background when the palette resolved; in
  // jsdom it does not, so prepareSvg uses its documented '#ffffff' fallback.
  const background = /data-orei-background="([^"]+)"/.exec(copiedText())?.[1] ?? '#ffffff';

  // 1× with the document background: one fillRect over the whole canvas, chosen color.
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'Copy PNG' }));
  await waitFor(() => expect(native.canvasRuns).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  const single = native.canvasRuns[0];
  expect(single.fills).toHaveLength(1);
  expect(single.fills[0].fillStyle).toBe(background);
  expect(single.fills[0].rect).toEqual([0, 0, single.width, single.height]);

  // 2× doubles the raster width and still paints the background.
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await screen.findByRole('dialog');
  fireEvent.click(screen.getByLabelText('PNG scale'));
  await screen.findByRole('listbox');
  fireEvent.click([...screen.getAllByRole('option')].find(option => option.textContent === '2×')!);
  fireEvent.click(screen.getByRole('button', { name: 'Copy PNG' }));
  await waitFor(() => expect(native.canvasRuns).toHaveLength(2));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  const doubled = native.canvasRuns[1];
  expect(doubled.width).toBe(single.width * 2);
  expect(doubled.fills).toHaveLength(1);
  expect(doubled.fills[0].fillStyle).toBe(background);

  // Transparent at 2×: the background fillRect is skipped entirely.
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await screen.findByRole('dialog');
  fireEvent.click(screen.getByLabelText('Canvas background'));
  await screen.findByRole('listbox');
  fireEvent.click([...screen.getAllByRole('option')].find(option => option.textContent === 'Transparent')!);
  fireEvent.click(screen.getByRole('button', { name: 'Copy PNG' }));
  await waitFor(() => expect(native.canvasRuns).toHaveLength(3));
  const transparent = native.canvasRuns[2];
  expect(transparent.width).toBe(single.width * 2);
  expect(transparent.fills).toHaveLength(0);

  const args = native.written.find(entry => entry.command === 'copy_output_image')!.args as { bytes: number[] };
  expect(args.bytes.slice(0, 8)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(await screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('a failed dialog copy keeps the dialog open and reports the clipboard error', async () => {
  await start();
  native.failCopy = true;
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'Copy SVG' }));
  await screen.findByText(/pasteboard denied/);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.queryByText('Could not copy diagram')).not.toBeInTheDocument();
});

test('dialog copy buttons follow the same valid-render gate as the save buttons', async () => {
  await start();
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await screen.findByRole('dialog');
  fireEvent.change(screen.getByLabelText('Diagram source'), { target: { value: 'not a diagram' } });
  await screen.findByText(/Preview out of date/, {}, { timeout: 3000 });
  expect(screen.getByRole('button', { name: 'Copy SVG' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Copy PNG' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Copy SVG' }));
  expect(copied()).toEqual([]);
});
