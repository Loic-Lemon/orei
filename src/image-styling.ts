// Image styling persists in one orei-managed CSS comment inside the diagram stylesheet:
//
//   /* orei:image-styles:v1 {"images":{"assets%2Fphoto.png":{...}}} */
//
// The diagram stylesheet travels through Markdown notes, paired `.css` companions and
// Save As/Copy, so the comment does too without a new document field. Values are px in
// the diagram coordinate system. A missing comment means default styling. Malformed,
// duplicate or unsupported comments are reported to Styling and ignored by rendering so
// the user can repair the stylesheet; they are never rewritten or dropped here.
import { relativeImageReference } from './image-import';
import { paletteValues } from './palette';

export interface ImageStyle {
  /** Corner radius in diagram px. */
  radius: number;
  /** Solid border width in diagram px; 0 means no border. */
  borderWidth: number;
  /** Validated CSS color for the border. */
  borderColor: string;
}

export interface ImageStylesRead {
  /** Stored styles by original image reference. Empty when the data is unusable. */
  styles: Map<string, ImageStyle>;
  /** A user-facing problem for Styling; rendering uses defaults when present. */
  problem?: string;
}

export type ImageStyleWrite =
  | { css: string; changed: boolean }
  | { problem: string };

export const IMAGE_STYLE_MARKER = 'orei:image-styles';
export const IMAGE_STYLE_VERSION = 'v1';
export const MAX_IMAGE_STYLE_PX = 4096;
export const MAX_IMAGE_STYLE_ENTRIES = 128;
export const MAX_STYLESHEET_TEXT = 50000;
export const DEFAULT_IMAGE_BORDER_COLOR = '#8a8a8a';

const VERSION = IMAGE_STYLE_VERSION;
const BLOCK = /^\s*orei:image-styles(?::|\s|$)/;
const PAYLOAD = /^\s*orei:image-styles:([^\s]+)\s+([\s\S]*?)\s*$/;
const KEY = /^(?:[A-Za-z0-9\-_.~]|%[0-9A-F]{2})+$/;

const malformed = 'Image styling data is malformed, so images use default styling and the stylesheet is unchanged. Repair or remove the orei:image-styles block.';
const duplicate = 'Image styling data appears in more than one orei:image-styles block, so images use default styling and the stylesheet is unchanged. Keep a single block.';

const plainObject = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Finite, non-negative diagram px. The renderer clamps values to each image in turn. */
function styleLength(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_IMAGE_STYLE_PX;
}

/**
 * Limit input to hex, named colors and numeric rgb()/hsl() before asking the browser
 * to validate the value. A border color must be usable independently of inheritance.
 */
export function validImageStyleColor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const color = value.trim();
  if (!color || color.length > 64) return false;
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) return true;
  const named = /^[a-z]{1,32}$/i.test(color) && !/^(?:inherit|initial|unset|revert|currentcolor)$/i.test(color);
  const functional = /^(?:rgb|hsl)a?\(\s*[0-9.,%/+\-\s]+\)$/i.test(color);
  if (!named && !functional) return false;
  const style = document.createElement('span').style;
  style.color = color;
  return style.color !== '';
}

/** Validates and trims form or stored values. Undefined means the values are unusable. */
export function normalizeImageStyle(input: unknown): ImageStyle | undefined {
  if (!plainObject(input) || Object.keys(input).length !== 3) return undefined;
  const { radius, borderWidth, borderColor } = input;
  if (!styleLength(radius) || !styleLength(borderWidth) || !validImageStyleColor(borderColor)) return undefined;
  return { radius: radius === 0 ? 0 : radius, borderWidth: borderWidth === 0 ? 0 : borderWidth, borderColor: borderColor.trim() };
}

export function isDefaultImageStyle(style: ImageStyle): boolean {
  return style.radius === 0 && style.borderWidth === 0;
}

/**
 * The draft values for an image without a stored style. Square corners and no border are
 * fixed defaults; the border color follows the document's own `--pele-border` so a later
 * border choice starts from the current diagram palette.
 */
export function defaultImageStyle(css = ''): ImageStyle {
  let borderColor = DEFAULT_IMAGE_BORDER_COLOR;
  try {
    const candidate = paletteValues(css)['--pele-border'];
    if (candidate && validImageStyleColor(candidate)) borderColor = candidate.trim();
  } catch { /* A stylesheet without a readable palette uses the neutral default. */ }
  return { radius: 0, borderWidth: 0, borderColor };
}

/**
 * Reversible, canonical key encoding: RFC 3986 unreserved bytes stay literal and every
 * other UTF-8 byte becomes `%XX`. `*` and `/` are never left literal, so a reference can
 * never terminate the surrounding CSS comment. Canonical output also makes two spellings
 * of one reference detectably the same.
 */
export function encodeImageStyleKey(reference: string): string {
  return encodeURIComponent(reference).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Decodes a canonical, supported image reference; anything else is invalid metadata. */
export function decodeImageStyleKey(key: string): string | undefined {
  // A valid reference is at most 512 UTF-8 bytes; percent-encoding each byte takes 3 chars.
  if (!key || key.length > 2048 || !KEY.test(key)) return undefined;
  let reference: string;
  try { reference = decodeURIComponent(key); } catch { return undefined; }
  if (!reference || encodeImageStyleKey(reference) !== key || !relativeImageReference(reference)) return undefined;
  return reference;
}

interface CssComment { start: number; end: number; body: string }
interface Scan { comments: CssComment[]; unterminated?: 'comment' | 'string'; unterminatedStart?: number }

/** Extracts real CSS comments, skipping strings so markers inside content are ignored. */
function scanCss(css: string): Scan {
  const comments: CssComment[] = [];
  let index = 0;
  while (index < css.length) {
    const character = css[index];
    if (character === '/' && css[index + 1] === '*') {
      const close = css.indexOf('*/', index + 2);
      if (close < 0) return { comments, unterminated: 'comment', unterminatedStart: index };
      comments.push({ start: index, end: close + 2, body: css.slice(index + 2, close) });
      index = close + 2;
      continue;
    }
    if (character === '"' || character === "'") {
      let cursor = index + 1;
      let closed = false;
      let endedAtNewline = false;
      while (cursor < css.length) {
        const value = css[cursor];
        if (value === '\\') {
          // A backslash escapes the next character; an escaped CRLF is one continuation.
          cursor += css[cursor + 1] === '\r' && css[cursor + 2] === '\n' ? 3 : 2;
          continue;
        }
        if (value === character) { cursor += 1; closed = true; break; }
        // CSS ends a bad-string token at an unescaped newline; a stray quote must not
        // hide comments that follow it. Only EOF is genuinely unterminated.
        if (value === '\n' || value === '\r') { endedAtNewline = true; break; }
        cursor += 1;
      }
      if (!closed && !endedAtNewline) return { comments, unterminated: 'string', unterminatedStart: index };
      index = cursor;
      continue;
    }
    index += 1;
  }
  return { comments };
}

const managedComments = (comments: CssComment[]) => comments.filter(comment => BLOCK.test(comment.body));

/** Exclude managed metadata from the CSS passed to the webview, leaving a comment separator. */
export function withoutImageStyleComments(css: string): string {
  if (!css.includes(IMAGE_STYLE_MARKER)) return css;
  const scan = scanCss(css);
  let stylesheet = css;
  if (scan.unterminated === 'comment' && scan.unterminatedStart !== undefined
    && BLOCK.test(css.slice(scan.unterminatedStart + 2))) {
    stylesheet = css.slice(0, scan.unterminatedStart);
  }
  for (const comment of managedComments(scan.comments).reverse()) {
    stylesheet = stylesheet.slice(0, comment.start) + '/**/' + stylesheet.slice(comment.end);
  }
  return stylesheet;
}

/**
 * Reads the single managed comment. Invalid metadata is reported once and yields no styles,
 * which makes every image render with defaults without touching the user's stylesheet text.
 */
export function readImageStyles(css: string): ImageStylesRead {
  const scan = scanCss(css);
  if (scan.unterminated === 'comment' && scan.unterminatedStart !== undefined
    && BLOCK.test(css.slice(scan.unterminatedStart + 2))) {
    return { styles: new Map(), problem: malformed };
  }
  const managed = managedComments(scan.comments);
  if (managed.length === 0) return { styles: new Map() };
  if (managed.length > 1) return { styles: new Map(), problem: duplicate };
  const match = PAYLOAD.exec(managed[0].body);
  if (!match) return { styles: new Map(), problem: malformed };
  const [, version, payload] = match;
  if (version !== VERSION) {
    return { styles: new Map(), problem: `Image styling data uses the unsupported version ${version}, so images use default styling and the stylesheet is unchanged.` };
  }
  let value: unknown;
  try { value = JSON.parse(payload); } catch { return { styles: new Map(), problem: malformed }; }
  if (!plainObject(value) || Object.keys(value).length !== 1 || !plainObject(value.images)) {
    return { styles: new Map(), problem: malformed };
  }
  const styles = new Map<string, ImageStyle>();
  const entries = Object.entries(value.images);
  if (entries.length > MAX_IMAGE_STYLE_ENTRIES) return { styles: new Map(), problem: malformed };
  for (const [key, raw] of entries) {
    const reference = decodeImageStyleKey(key);
    const style = normalizeImageStyle(raw);
    if (!reference || !style || styles.has(reference)) return { styles: new Map(), problem: malformed };
    styles.set(reference, style);
  }
  // The validated shape has an images key, then one reference and three fields per image.
  // Extra key tokens reveal duplicates that JSON.parse would silently collapse.
  const tokens = [...payload.matchAll(/"(?:[^"\\]|\\.)*"\s*:/g)].length;
  if (tokens !== 1 + 4 * styles.size) return { styles: new Map(), problem: malformed };
  return { styles };
}

/** The dialog and Styling section read current values and any diagnostic through this. */
export function imageStyleFor(css: string, reference: string): ImageStylesRead & { style: ImageStyle; present: boolean } {
  const read = readImageStyles(css);
  const stored = read.styles.get(reference);
  return {
    styles: read.styles,
    problem: read.problem,
    style: stored ?? defaultImageStyle(css),
    present: stored !== undefined,
  };
}

/** Diagnostic only, for the Local images section. */
export function imageStyleProblem(css: string): string | undefined {
  return readImageStyles(css).problem;
}

function serializeImageStyles(styles: Map<string, ImageStyle>): string {
  const images: Record<string, ImageStyle> = {};
  for (const [reference, style] of [...styles].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    // defineProperty keeps references like `__proto__` as own JSON keys.
    Object.defineProperty(images, encodeImageStyleKey(reference), {
      value: { radius: style.radius, borderWidth: style.borderWidth, borderColor: style.borderColor },
      enumerable: true, configurable: true, writable: true,
    });
  }
  return `/* ${IMAGE_STYLE_MARKER}:${VERSION} ${JSON.stringify({ images })} */`;
}

/** Removes a managed line without disturbing adjacent user CSS. */
function removeManagedLine(css: string, comment: CssComment): string {
  const lineStart = Math.max(css.lastIndexOf('\n', comment.start - 1), css.lastIndexOf('\r', comment.start - 1)) + 1;
  const before = css.slice(lineStart, comment.start);
  let after = comment.end;
  while (after < css.length && (css[after] === ' ' || css[after] === '\t')) after += 1;
  const newline = css[after] === '\r' && css[after + 1] === '\n' ? 2 : css[after] === '\n' || css[after] === '\r' ? 1 : 0;
  if (!before.trim() && newline > 0) return css.slice(0, lineStart) + css.slice(after + newline);
  return css.slice(0, comment.start) + css.slice(comment.end);
}

/**
 * Merges one image's values into the latest stylesheet. Call this with the current
 * document CSS at Apply time, not a snapshot captured when the dialog opened. Only the
 * managed comment changes; invalid existing metadata refuses the write so it can be
 * repaired instead of overwritten. Applying default values removes the entry (and the
 * comment when it becomes empty), which makes Reset reversible.
 */
export function applyImageStyle(css: string, reference: string, input: unknown): ImageStyleWrite {
  if (!relativeImageReference(reference)) {
    return { problem: `Image reference ${JSON.stringify(reference)} cannot be styled. Use a relative .png reference stored in this document.` };
  }
  try { encodeImageStyleKey(reference); }
  catch { return { problem: 'Image reference cannot be encoded safely. Use a well-formed relative .png reference stored in this document.' }; }
  const style = normalizeImageStyle(input);
  if (!style) return { problem: `Image styling values are invalid. Corner radius and border width must be finite, non-negative px values up to ${MAX_IMAGE_STYLE_PX}, and the border color must be a CSS color.` };
  const scanned = scanCss(css);
  if (scanned.unterminated) {
    return { problem: `The stylesheet ends inside an unterminated ${scanned.unterminated}, so the image styling block cannot be changed safely. Finish the ${scanned.unterminated} and try again.` };
  }
  const read = readImageStyles(css);
  if (read.problem) return { problem: read.problem };
  const managed = managedComments(scanned.comments);
  const styles = new Map(read.styles);
  if (isDefaultImageStyle(style)) styles.delete(reference);
  else styles.set(reference, style);
  if (styles.size > MAX_IMAGE_STYLE_ENTRIES) {
    return { problem: `At most ${MAX_IMAGE_STYLE_ENTRIES} images can carry styling in one stylesheet. Remove another image style first.` };
  }
  const block = styles.size ? serializeImageStyles(styles) : '';
  if (managed.length === 1) {
    const next = styles.size
      ? css.slice(0, managed[0].start) + block + css.slice(managed[0].end)
      : removeManagedLine(css, managed[0]);
    if (next.length > MAX_STYLESHEET_TEXT) {
      return { problem: `The stylesheet would exceed the ${MAX_STYLESHEET_TEXT.toLocaleString('en-US')}-character limit, so the image styling block was not changed. Remove another style or shorten the stylesheet.` };
    }
    return { css: next, changed: next !== css };
  }
  if (!styles.size) return { css, changed: false };
  const newline = css.match(/\r\n|\r|\n/)?.[0] ?? '\n';
  const separator = css.length === 0 || css.endsWith('\n') || css.endsWith('\r') ? '' : newline;
  const next = `${css}${separator}${block}${newline}`;
  if (next.length > MAX_STYLESHEET_TEXT) {
    return { problem: `The stylesheet would exceed the ${MAX_STYLESHEET_TEXT.toLocaleString('en-US')}-character limit, so the image styling block was not changed. Remove another style or shorten the stylesheet.` };
  }
  return { css: next, changed: true };
}

/** Accessible name/description text for the later cog integration. */
export function imageStyleControlLabel(reference: string): string {
  return `Style image ${reference}`;
}
