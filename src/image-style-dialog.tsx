import { useEffect, useRef, useState, type RefObject } from 'react';
import { Button, Callout, Dialog, Flex, Text, TextField } from '@radix-ui/themes';
import { pngSize } from './image-import';
import {
  DEFAULT_IMAGE_BORDER_COLOR,
  MAX_IMAGE_STYLE_PX,
  defaultImageStyle,
  imageStyleFor,
  normalizeImageStyle,
  type ImageStyle,
} from './image-styling';

export interface ImageStyleDialogProps {
  /**
   * Controlled open state. Escape and Cancel call onOpenChange(false); the caller closes
   * after a successful onApply so a merge failure can keep the draft visible.
   */
  open: boolean;
  /** Original Mermaid image reference; keyed into the managed stylesheet comment. */
  reference: string;
  /** The original PNG data URL used for the live thumbnail. */
  preview?: string;
  /**
   * Current diagram stylesheet. Read when the dialog opens for current values, the
   * `--pele-border` default and malformed-metadata diagnostics. Apply still goes through
   * the latest stylesheet in the caller.
   */
  css: string;
  onOpenChange: (open: boolean) => void;
  /**
   * Receives the validated draft at most once per Apply. The caller merges it into the
   * latest document CSS with `applyImageStyle(latestCss, reference, style)`, writes the
   * result through `edit('css', ...)` for one Styling undo step, and then closes the dialog.
   * On failure, keep it open and pass `applyProblem` so the draft can be retried.
   */
  onApply: (style: ImageStyle) => void;
  /** Optional caller-side failure, such as a late merge conflict. */
  applyProblem?: string;
  /**
   * The image's cog. Escape, Cancel and Apply return focus here. Without it, Radix returns
   * focus to the nearest Dialog.Trigger, if the caller renders the cog inside one.
   */
  returnFocusTo?: RefObject<HTMLElement | null>;
}

function previewScale(width: number, height: number): number {
  return Math.max(0.01, Math.min(1, 240 / width, 160 / height));
}

/** The native color input only accepts 6-digit hex; other valid colors use the chip. */
function swatchValue(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])(?:[0-9a-f])?$/i.exec(color);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  const long = /^#([0-9a-f]{6})[0-9a-f]{2}$/i.exec(color);
  if (long) return `#${long[1]}`.toLowerCase();
  return DEFAULT_IMAGE_BORDER_COLOR;
}

/**
 * Small Radix dialog for one local image reference. It owns only the draft controls; the
 * document stylesheet and undo history stay in the caller. Escape, Cancel and closing
 * discard the draft because the next open reads the stylesheet again.
 */
export function ImageStyleDialog({ open, reference, preview, css, onOpenChange, onApply, applyProblem, returnFocusTo }: ImageStyleDialogProps) {
  const read = imageStyleFor(css, reference);
  const defaults = defaultImageStyle(css);
  const [draft, setDraft] = useState<ImageStyle>(read.style);
  const [pending, setPending] = useState(false);
  const radiusRef = useRef<HTMLInputElement>(null);
  const previousProblem = useRef(read.problem);

  // Re-seed from the stylesheet on each open (or reference change), not on every stylesheet
  // keystroke while open; that would fight the user's draft.
  useEffect(() => {
    if (open) {
      setDraft(imageStyleFor(css, reference).style);
      setPending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- css is a seed, not a live input.
  }, [open, reference]);

  // If malformed metadata is repaired (or becomes malformed) while the dialog is open,
  // move from defaults to the stored values (or back) instead of applying stale defaults.
  useEffect(() => {
    if (!open) return;
    if (previousProblem.current !== read.problem) setDraft(imageStyleFor(css, reference).style);
    previousProblem.current = read.problem;
  }, [open, reference, read.problem, css]);

  // A failed merge may be retried without closing and reopening the dialog.
  useEffect(() => {
    if (applyProblem) setPending(false);
  }, [applyProblem]);

  const validation = normalizeImageStyle(draft);
  const setNumber = (key: 'radius' | 'borderWidth', value: string) => {
    setDraft(current => ({ ...current, [key]: value === '' ? Number.NaN : Number(value) }));
  };
  const setBorderColor = (borderColor: string) => {
    setDraft(current => current.borderColor === borderColor ? current : { ...current, borderColor });
  };
  const colorEnabled = Number.isFinite(draft.borderWidth) && draft.borderWidth > 0;
  const size = preview ? pngSize(preview) : undefined;
  const naturalWidth = size?.width ?? 160;
  const naturalHeight = size?.height ?? 120;
  const scale = previewScale(naturalWidth, naturalHeight);
  const shownWidth = Math.max(1, naturalWidth * scale);
  const shownHeight = Math.max(1, naturalHeight * scale);
  // The preview represents the displayed diagram image. A large source PNG should not
  // shrink a 5 px border to a fraction of a pixel in the dialog.
  const previewLimit = Math.min(shownWidth, shownHeight) / 2;
  const previewRadius = Math.min(Number.isFinite(draft.radius) ? Math.max(0, draft.radius) : 0, previewLimit);
  const previewBorder = colorEnabled ? Math.min(draft.borderWidth, previewLimit) : 0;
  const swatch = swatchValue(draft.borderColor);

  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Content maxWidth="400px" onOpenAutoFocus={event => {
      event.preventDefault();
      radiusRef.current?.focus();
    }} onCloseAutoFocus={event => {
      const target = returnFocusTo?.current;
      if (target?.isConnected) {
        event.preventDefault();
        target.focus();
      }
    }}>
      <Dialog.Title>Style image {reference || 'reference'}</Dialog.Title>
      <Dialog.Description size="2" color="gray">
        Every node that uses {reference || 'this image'} receives this style.
      </Dialog.Description>

      <figure className="image-style-preview">
        <Text asChild size="1" weight="medium"><figcaption>Live preview</figcaption></Text>
        <div className="image-style-preview-stage">
          {preview
            ? <div className="image-style-preview-frame" style={{ width: shownWidth, height: shownHeight, borderRadius: previewRadius }}>
                <img src={preview} alt={`Preview of ${reference || 'the image'}`}/>
                {previewBorder > 0 && <span className="image-style-preview-border" aria-hidden="true" style={{ borderWidth: previewBorder, borderColor: draft.borderColor }}/>}
              </div>
            : <Text size="1" color="gray">No preview available.</Text>}
        </div>
      </figure>

      {(read.problem || applyProblem) && <Callout.Root color={read.problem ? 'amber' : 'red'} role="alert" mt="3">
        <Callout.Text>
          {read.problem && `${read.problem} The image uses default styling until the stylesheet is repaired; its text is preserved.`}
          {read.problem && applyProblem && ' '}
          {applyProblem}
        </Callout.Text>
      </Callout.Root>}

      <Flex direction="column" gap="3" mt="4">
        <Flex direction="column" gap="1">
          <Text as="label" size="1" weight="medium" htmlFor="image-style-radius">Corner radius</Text>
          <Flex align="center" gap="2">
            <TextField.Root
              id="image-style-radius"
              ref={radiusRef}
              type="number"
              min={0}
              max={4096}
              step="1"
              value={Number.isFinite(draft.radius) ? String(draft.radius) : ''}
              aria-describedby="image-style-help"
              onChange={event => setNumber('radius', event.target.value)}
              style={{ width: 120 }}
            />
            <Text size="1" color="gray">px</Text>
          </Flex>
        </Flex>

        <Flex direction="column" gap="1">
          <Text as="label" size="1" weight="medium" htmlFor="image-style-border-width">Border width</Text>
          <Flex align="center" gap="2">
            <TextField.Root
              id="image-style-border-width"
              type="number"
              min={0}
              max={4096}
              step="1"
              value={Number.isFinite(draft.borderWidth) ? String(draft.borderWidth) : ''}
              aria-describedby="image-style-help"
              onChange={event => setNumber('borderWidth', event.target.value)}
              style={{ width: 120 }}
            />
            <Text size="1" color="gray">px</Text>
          </Flex>
        </Flex>

        <Flex direction="column" gap="1">
          <Text as="label" size="1" weight="medium" htmlFor="image-style-border-color">Border color</Text>
          <Flex align="center" gap="2">
            <input
              type="color"
              aria-label="Border color swatch"
              value={swatch}
              disabled={!colorEnabled}
              onInput={event => setBorderColor(event.currentTarget.value)}
              onChange={event => setBorderColor(event.currentTarget.value)}
              style={{ width: 36, height: 28, padding: 2, border: '1px solid var(--gray-a6)', borderRadius: 'var(--radius-2)', background: 'transparent' }}
            />
            <span
              role="img"
              aria-label="Border color preview"
              title={draft.borderColor}
              style={{ width: 18, height: 18, flex: '0 0 auto', borderRadius: 'var(--radius-1)', border: '1px solid var(--gray-a6)', background: draft.borderColor }}
            />
            <TextField.Root
              id="image-style-border-color"
              aria-label="Border color"
              aria-describedby="image-style-help"
              value={draft.borderColor}
              disabled={!colorEnabled}
              onChange={event => setBorderColor(event.currentTarget.value)}
              style={{ flex: 1 }}
            />
          </Flex>
          <Text id="image-style-help" as="p" size="1" color="gray">
            A positive border width enables the solid border and its color. A zero border is not drawn.
          </Text>
        </Flex>
      </Flex>

      {!validation && <Callout.Root color="red" role="alert" mt="3">
        <Callout.Text>Corner radius and border width must be finite, non-negative px values up to {MAX_IMAGE_STYLE_PX}, and the border color must be a CSS color. Nothing has been applied.</Callout.Text>
      </Callout.Root>}

      <Flex justify="end" gap="3" mt="4">
        <Button variant="ghost" color="gray" onClick={() => setDraft(defaults)}>Reset</Button>
        <Dialog.Close><Button variant="soft" color="gray">Cancel</Button></Dialog.Close>
        <Button
          disabled={!validation || Boolean(read.problem) || pending}
          onClick={() => {
            if (!validation || read.problem || pending) return;
            setPending(true);
            onApply(validation);
          }}
        >Apply</Button>
      </Flex>
    </Dialog.Content>
  </Dialog.Root>;
}

export default ImageStyleDialog;
