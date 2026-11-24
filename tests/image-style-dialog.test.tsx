import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Theme } from '@radix-ui/themes';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ImageStyleDialog } from '../src/image-style-dialog';
import { applyImageStyle, defaultImageStyle } from '../src/image-styling';
import { pngDataUrl } from './png-fixture';

const reference = 'assets/photo.png';

function cssWith(values: { radius: number; borderWidth: number; borderColor: string }): string {
  const result = applyImageStyle('.pele {\n  --pele-border: #0284c7;\n}\n', reference, values);
  if ('problem' in result) throw new Error(result.problem);
  return result.css;
}

function open(css: string, overrides: Partial<ComponentProps<typeof ImageStyleDialog>> = {}) {
  const onApply = vi.fn();
  const onOpenChange = vi.fn();
  const view = render(<Theme><ImageStyleDialog open reference={reference} preview={pngDataUrl(48, 24)} css={css} onOpenChange={onOpenChange} onApply={onApply} {...overrides}/></Theme>);
  return { ...view, onApply, onOpenChange };
}

afterEach(cleanup);

describe('image styling dialog', () => {
  test('reads current values, updates the draft and applies once with the original reference', async () => {
    const { onApply } = open(cssWith({ radius: 12, borderWidth: 3, borderColor: '#235d56' }));
    expect(screen.getByRole('dialog')).toHaveTextContent(reference);
    expect(screen.getByText(/Every node that uses/)).toHaveTextContent(reference);
    const radius = screen.getByLabelText('Corner radius');
    await waitFor(() => expect(radius).toHaveFocus());
    const width = screen.getByLabelText('Border width');
    expect(radius).toHaveValue(12);
    expect(width).toHaveValue(3);
    expect(screen.getByLabelText('Border color')).toHaveValue('#235d56');
    expect(screen.getByLabelText('Border color swatch')).toBeEnabled();
    const frame = screen.getByAltText(`Preview of ${reference}`).parentElement!;
    const border = frame.querySelector('.image-style-preview-border');
    expect(frame).toHaveStyle({ borderRadius: '12px' });
    expect(border).toHaveStyle({ borderWidth: '3px', borderColor: '#235d56' });

    fireEvent.change(radius, { target: { value: '24' } });
    fireEvent.change(screen.getByLabelText('Border color'), { target: { value: '#ff0000' } });
    expect(border).toHaveStyle({ borderWidth: '3px', borderColor: '#ff0000' });
    expect(screen.getByLabelText('Border color preview')).toHaveStyle({ backgroundColor: '#ff0000' });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledOnce();
    expect(onApply).toHaveBeenCalledWith({ radius: 24, borderWidth: 3, borderColor: '#ff0000' });
  });

  test('a large PNG shows live edits at its displayed size before Apply', () => {
    const { onApply } = open('', { preview: pngDataUrl(1200, 260) });
    const frame = screen.getByAltText(`Preview of ${reference}`).parentElement!;
    expect(screen.getByText('Live preview')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Corner radius'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Border width'), { target: { value: '5' } });
    fireEvent.input(screen.getByLabelText('Border color swatch'), { target: { value: '#bc4861' } });
    expect(frame).toHaveStyle({ width: '240px', height: '52px', borderRadius: '5px' });
    expect(frame.querySelector('.image-style-preview-border')).toHaveStyle({ borderWidth: '5px', borderColor: '#bc4861' });
    expect(onApply).not.toHaveBeenCalled();
  });

  test('a zero border disables the color controls and Reset returns to the current palette defaults', () => {
    const { onApply } = open('.pele {\n  --pele-border: #0284c7;\n}\n');
    expect(screen.getByLabelText('Corner radius')).toHaveValue(0);
    expect(screen.getByLabelText('Border width')).toHaveValue(0);
    expect(screen.getByLabelText('Border color')).toBeDisabled();
    expect(screen.getByLabelText('Border color swatch')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Border width'), { target: { value: '2' } });
    expect(screen.getByLabelText('Border color')).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Corner radius'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByLabelText('Corner radius')).toHaveValue(0);
    expect(screen.getByLabelText('Border width')).toHaveValue(0);
    expect(screen.getByLabelText('Border color swatch')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith(defaultImageStyle('.pele {\n  --pele-border: #0284c7;\n}\n'));
  });

  test('Cancel and Escape discard the draft', async () => {
    const { onApply, onOpenChange } = open(cssWith({ radius: 8, borderWidth: 0, borderColor: '#000000' }));
    fireEvent.change(screen.getByLabelText('Corner radius'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onApply).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledTimes(2));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(onApply).not.toHaveBeenCalled();
  });

  test('malformed stylesheet data is reported, defaults are shown, and Apply stays disabled', () => {
    open('/* orei:image-styles:v1 {"images": */\n');
    expect(screen.getByRole('alert')).toHaveTextContent(/malformed/);
    expect(screen.getByLabelText('Corner radius')).toHaveValue(0);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  test('invalid draft values disable Apply and explain the rules', () => {
    const { onApply } = open(cssWith({ radius: 8, borderWidth: 0, borderColor: '#000000' }));
    fireEvent.change(screen.getByLabelText('Corner radius'), { target: { value: '-1' } });
    expect(screen.getByRole('alert')).toHaveTextContent('finite, non-negative px values');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();
  });

  test('delivers one Apply per click sequence and can retry after a failed merge', async () => {
    const view = open(cssWith({ radius: 8, borderWidth: 1, borderColor: '#000000' }));
    const apply = screen.getByRole('button', { name: 'Apply' });
    fireEvent.click(apply);
    fireEvent.click(apply);
    expect(view.onApply).toHaveBeenCalledOnce();
    expect(apply).toBeDisabled();

    view.rerender(<Theme><ImageStyleDialog open reference={reference} preview={pngDataUrl(48, 24)} css={cssWith({ radius: 8, borderWidth: 1, borderColor: '#000000' })} onOpenChange={view.onOpenChange} onApply={view.onApply} applyProblem="The stylesheet changed while the dialog was open."/></Theme>);
    expect(screen.getByRole('alert')).toHaveTextContent('The stylesheet changed');
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.click(apply);
    expect(view.onApply).toHaveBeenCalledTimes(2);
  });

  test('a draft survives an unrelated stylesheet update while open, but a repaired block reseeds it', async () => {
    const valid = cssWith({ radius: 9, borderWidth: 1, borderColor: '#ff0000' });
    const view = open('/* orei:image-styles:v1 {"images": */');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    view.rerender(<Theme><ImageStyleDialog open reference={reference} preview={pngDataUrl(48, 24)} css={valid} onOpenChange={view.onOpenChange} onApply={view.onApply}/></Theme>);
    await waitFor(() => expect(screen.getByLabelText('Corner radius')).toHaveValue(9));
    expect(screen.getByLabelText('Border width')).toHaveValue(1);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Corner radius'), { target: { value: '30' } });
    view.rerender(<Theme><ImageStyleDialog open reference={reference} preview={pngDataUrl(48, 24)} css={cssWith({ radius: 4, borderWidth: 2, borderColor: '#0000ff' })} onOpenChange={view.onOpenChange} onApply={view.onApply}/></Theme>);
    expect(screen.getByLabelText('Corner radius')).toHaveValue(30);
    expect(screen.getByLabelText('Border width')).toHaveValue(1);
  });

  test('returns focus to the image cog after Cancel', async () => {
    const cog = { current: null as HTMLButtonElement | null };
    function Harness() {
      const [isOpen, setIsOpen] = useState(true);
      const button = useRef<HTMLButtonElement>(null);
      useEffect(() => { cog.current = button.current; }, []);
      return <>
        <button ref={button} type="button">Style image {reference}</button>
        <ImageStyleDialog open={isOpen} reference={reference} preview={pngDataUrl(48, 24)} css="" onOpenChange={setIsOpen} onApply={() => {}} returnFocusTo={button}/>
      </>;
    }
    render(<Theme><Harness/></Theme>);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cog.current).toHaveFocus());
  });

  test('reopening reseeds from the latest stylesheet instead of keeping the discarded draft', () => {
    const first = cssWith({ radius: 4, borderWidth: 0, borderColor: '#000000' });
    const view = open(first);
    fireEvent.change(screen.getByLabelText('Corner radius'), { target: { value: '30' } });
    view.rerender(<Theme><ImageStyleDialog open={false} reference={reference} preview={pngDataUrl(48, 24)} css={first} onOpenChange={view.onOpenChange} onApply={view.onApply}/></Theme>);
    const second = cssWith({ radius: 9, borderWidth: 1, borderColor: '#ff0000' });
    view.rerender(<Theme><ImageStyleDialog open reference={reference} preview={pngDataUrl(48, 24)} css={second} onOpenChange={view.onOpenChange} onApply={view.onApply}/></Theme>);
    expect(screen.getByLabelText('Corner radius')).toHaveValue(9);
    expect(screen.getByLabelText('Border width')).toHaveValue(1);
    expect(screen.getByLabelText('Border color')).toHaveValue('#ff0000');
  });
});
