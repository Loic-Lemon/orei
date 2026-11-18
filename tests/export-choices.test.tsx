import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from '../src/App';
import {ensureFixtures,seedFixtures} from './seed';
import type { Snapshot } from '../src/rendering';

// jsdom cannot rasterize; spy on the output seam to prove the choices the dialog
// captures reach the pipeline, while the dialog/destination behavior is covered in
// export-dialog.test.tsx against the real saveSnapshot.
const calls = vi.hoisted(() => ({ saveSnapshot: vi.fn<(snapshot: Snapshot, format: 'svg' | 'png', scale: number, transparent: boolean) => Promise<void>>(async () => {}) }));
vi.mock('../src/output', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/output')>();
  return { ...actual, saveSnapshot: calls.saveSnapshot };
});

beforeAll(() => { Element.prototype.scrollIntoView ??= () => {}; });
afterEach(() => { cleanup(); calls.saveSnapshot.mockClear(); });

const start = async () => {
  ensureFixtures();
  render(<App/>);
  await screen.findByText('Current preview');
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

test('the export dialog defaults to 1x with the document background', async () => {
  await start(); await openExport();
  fireEvent.click(screen.getByRole('button', { name: 'Save PNG' }));
  await waitFor(() => expect(calls.saveSnapshot).toHaveBeenCalledOnce());
  const [snapshot, format, scale, transparent] = calls.saveSnapshot.mock.calls[0];
  expect(format).toBe('png');
  expect(scale).toBe(1);
  expect(transparent).toBe(false);
  expect(snapshot.svg).toContain('Ordinary label');
  expect(snapshot.width).toBeGreaterThan(0);
  expect(await screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('a chosen scale and transparent canvas are passed to the output pipeline unchanged', async () => {
  await start(); await openExport();
  await choose('PNG scale', '2×');
  await choose('Canvas background', 'Transparent');
  fireEvent.click(screen.getByRole('button', { name: 'Save PNG' }));
  await waitFor(() => expect(calls.saveSnapshot).toHaveBeenCalledOnce());
  expect(calls.saveSnapshot).toHaveBeenCalledWith(expect.anything(), 'png', 2, true);
});

test('SVG export passes the current snapshot and its own format to the pipeline', async () => {
  await start(); await openExport();
  await choose('PNG scale', '4×');
  fireEvent.click(screen.getByRole('button', { name: 'Save SVG' }));
  await waitFor(() => expect(calls.saveSnapshot).toHaveBeenCalledOnce());
  const [snapshot, format] = calls.saveSnapshot.mock.calls[0];
  expect(format).toBe('svg');
  expect(snapshot.svg).toContain('Ordinary label');
  expect(snapshot.width).toBeGreaterThan(0);
  expect(snapshot.height).toBeGreaterThan(0);
});

test('a pipeline failure is reported inside the dialog and keeps it open', async () => {
  calls.saveSnapshot.mockRejectedValueOnce(new Error('PNG export exceeds the accepted limits'));
  await start(); await openExport();
  fireEvent.click(screen.getByRole('button', { name: 'Save PNG' }));
  await screen.findByText(/PNG export exceeds the accepted limits/);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});
