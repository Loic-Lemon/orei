import {beforeEach,test,expect} from 'vitest';
import {render,screen,waitFor,fireEvent} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {App} from '../src/App';
import {ensureFixtures,seedFixtures} from './seed';

beforeEach(()=>seedFixtures());
test('source and palette edits update the preview; invalid source keeps a stale preview and blocks export',async()=>{
  render(<App/>);
  await waitFor(()=>expect(screen.getByRole('status').textContent).toBe('Current preview'));
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'flowchart LR\n A[Edited label] --> B[Output]'}});
  await waitFor(()=>expect(screen.getByTestId('preview').shadowRoot?.querySelector('text')?.textContent).toBe('Edited label'));
  fireEvent.click(screen.getByRole('radio',{name:'Styling'}));
  fireEvent.change(screen.getByLabelText('--pele-surface value'),{target:{value:'#fef3c7'}});
  expect((screen.getByLabelText('Diagram stylesheet') as HTMLTextAreaElement).value).toContain('#fef3c7');
  await screen.findByText('Current preview');
  fireEvent.click(screen.getByRole('radio',{name:'Diagram'}));
  fireEvent.change(screen.getByLabelText('Diagram source'),{target:{value:'not a diagram'}});
  await screen.findByText(/Preview out of date/, {}, { timeout: 3000 });
  expect(screen.getByRole('button',{name:'Export'})).toBeDisabled();
  expect(screen.getByTestId('preview').shadowRoot?.textContent).toContain('Edited label');
});
