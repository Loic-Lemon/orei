import { assertMarkdownAssetsRepresentable, assetKind } from './document-assets';
import { createMarkdownDocument, updateMarkdownDocument } from './markdown-document';
import { encodePairedAssets, imageReferences, type PairedSnapshot } from './paired-document';

/** The two editable representations Save As and Save Copy can write. */
export type EditableFormat = 'markdown' | 'paired';

/** The parts of a document a conversion needs; nothing here is mutated. */
export type ConvertibleDocument = {
  source: string;
  css: string;
  assets: Readonly<Record<string, string>>;
  originalMarkdown?: string;
  pair?: { base: string; cssCompanion: boolean; assetsCompanion: boolean };
};

/** A complete destination payload, already safe to write. */
export type Conversion =
  | { format: 'markdown'; text: string }
  | { format: 'paired'; snapshot: PairedSnapshot };

const isImage = (data: string) => assetKind(data) === 'image';
const list = (names: string[]) => names.join(', ');
const plural = (count: number, one: string, many: string) => count === 1 ? one : many;

/** True when the document currently saves as a Markdown note. */
export function documentFormat(document: ConvertibleDocument): EditableFormat {
  return document.pair ? 'paired' : 'markdown';
}

/**
 * Local image references that a paired destination cannot resolve because the image
 * content is not carried by the document. Their text is never removed.
 */
function missingImageContent(document: ConvertibleDocument): string[] {
  return imageReferences(document.source).filter(reference => {
    const data = Object.hasOwn(document.assets, reference) ? document.assets[reference] : '';
    return !isImage(data);
  });
}

/**
 * Plans a conversion without writing or rewriting the source. Asset-bearing conversions to
 * Markdown are refused through the shared `document-assets.ts` gate, because Markdown has no
 * specified document-asset representation; a conversion to paired files carries every icon
 * name and image data URL verbatim in the adjacent asset index, whose icon bodies pass the
 * single `icon-safety.ts` validation path. Nothing here rebases source or CSS text, because
 * enabled conversions keep every recognized reference as the key it already is.
 */
export function planConversion(document: ConvertibleDocument, target: EditableFormat): Conversion {
  if (target === 'markdown') {
    // Same refusal and wording as every standalone Markdown save path (`markdownFor`).
    assertMarkdownAssetsRepresentable(document.assets);
    const references = documentFormat(document) === 'paired' ? imageReferences(document.source) : [];
    if (references.length) {
      throw new Error(`Cannot save as a Markdown note: local image ${plural(references.length, 'reference', 'references')} ${list(references)} cannot be resolved from a Markdown note and would be lost. Save a paired copy to keep ${plural(references.length, 'it', 'them')}; the original document is unchanged.`);
    }
    const text = document.originalMarkdown === undefined
      ? createMarkdownDocument({ mermaid: document.source, css: document.css })
      : updateMarkdownDocument(document.originalMarkdown, { mermaid: document.source, css: document.css });
    return { format: 'markdown', text };
  }

  const missing = missingImageContent(document);
  if (missing.length) {
    // A relative `img:` reference whose bytes are not in the document would resolve only
    // against the original directory; a new `.mmd` destination could not carry it.
    const remedy = documentFormat(document) === 'markdown'
      ? 'Save as a Markdown note to keep the reference text, or add the image before saving a paired copy.'
      : 'Restore the missing image content and reopen the document before saving a paired copy.';
    throw new Error(`Cannot save as paired files: local image ${plural(missing.length, 'reference', 'references')} ${list(missing)} ${plural(missing.length, 'has', 'have')} no embedded content, so ${plural(missing.length, 'it', 'they')} would not resolve beside the new .mmd destination. ${plural(missing.length, 'It', 'They')} ${plural(missing.length, 'is', 'are')} kept in the original document, which was not changed. ${remedy}`);
  }
  const hasAssets = Object.keys(document.assets).length > 0 || Boolean(document.pair?.assetsCompanion);
  return {
    format: 'paired',
    snapshot: {
      source: document.source,
      css: document.css,
      assets: hasAssets ? encodePairedAssets(document.assets) : null,
    },
  };
}

/** True when two planned conversions describe exactly the same destination content. */
export function sameConversion(left: Conversion, right: Conversion): boolean {
  if (left.format !== right.format) return false;
  if (left.format === 'markdown' && right.format === 'markdown') return left.text === right.text;
  if (left.format === 'paired' && right.format === 'paired') {
    return left.snapshot.source === right.snapshot.source
      && left.snapshot.css === right.snapshot.css
      && left.snapshot.assets === right.snapshot.assets;
  }
  return false;
}

/** Prefills the native save dialog with the current document's basename and target suffix. */
export function defaultDestinationName(document: ConvertibleDocument, currentName: string, target: EditableFormat): string {
  const stem = document.pair?.base ?? currentName.replace(/\.[^.]*$/, '');
  return `${stem || 'Untitled'}.${target === 'markdown' ? 'md' : 'mmd'}`;
}
