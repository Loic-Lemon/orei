import {beforeEach, describe, expect, it, vi} from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({invoke}));
vi.mock('../src/fixtures', () => ({fixtures: {}}));
vi.mock('../src/rendering', () => ({renderDiagram: vi.fn()}));
vi.mock('../src/output', () => ({png: vi.fn()}));

beforeEach(() => { vi.resetModules(); invoke.mockReset(); });

describe('evidence runner startup', () => {
  it('does not send diagnostic events on normal launches', async () => {
    invoke.mockResolvedValue({});
    const {startRunner} = await import('../src/runner');
    await startRunner(12);
    expect(invoke.mock.calls.map(call => call[0])).toEqual(['evidence_context']);
  });

  it('reports a failure in an early evidence boundary', async () => {
    invoke.mockResolvedValueOnce({scenario: 'small'}).mockRejectedValueOnce(new Error('boundary failed')).mockResolvedValueOnce(undefined);
    const {startRunner} = await import('../src/runner');
    await startRunner(12);
    expect(invoke.mock.calls[2][1].event).toMatchObject({type: 'failure', error: 'Error: boundary failed'});
  });

  it('reports a rejected context request and catches a rejected report', async () => {
    invoke.mockRejectedValueOnce(new Error('context failed')).mockRejectedValueOnce(new Error('report failed'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const {startRunner} = await import('../src/runner');
    await expect(startRunner(12)).resolves.toBeUndefined();
    expect(invoke.mock.calls.map(call => call[0])).toEqual(['evidence_context', 'evidence_event']);
    expect(invoke.mock.calls[1][1].event).toMatchObject({type: 'failure', stage: 'evidence_context', error: 'Error: context failed'});
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
