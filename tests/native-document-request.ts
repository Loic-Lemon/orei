import { act, waitFor } from '@testing-library/react';

export type NativeDocumentListener = (event: { payload: string }) => void;

/** Sends a native menu command through the mocked Tauri event listener seam. */
export async function requestDocument(listeners: Set<NativeDocumentListener>, payload: string) {
  await waitFor(() => {
    if (listeners.size === 0) throw new Error('Native document request listener is not ready');
  });
  act(() => { for (const listener of listeners) listener({ payload }); });
}
