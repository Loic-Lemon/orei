import { assetKind } from './document-assets';
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

/** A validated destination plan; the Markdown variant carries no text of its own. */
export type Conversion =
  | { format: 'markdown' }
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
 * Plans a conversion without writing or rewriting the source. Asset-bearing Markdown output
 * is supplemented by `planMarkdownAssets` at the native destination boundary.
 */
export function planConversion(document: ConvertibleDocument, target: EditableFormat): Conversion {
  if (target === 'markdown') {
    // The note text is composed on the Markdown save path, so this call exists only to
    // validate: the Save dialog's amber preflight must reject a malformed envelope, or a
    // source the existing fence could not contain, before the native picker opens.
    if (document.originalMarkdown === undefined) createMarkdownDocument({ mermaid: document.source, css: document.css });
    else updateMarkdownDocument(document.originalMarkdown, { mermaid: document.source, css: document.css });
    return { format: 'markdown' };
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

/** Prefills the native save dialog with the current document's basename and target suffix. */
export function defaultDestinationName(document: ConvertibleDocument, currentName: string, target: EditableFormat): string {
  const stem = document.pair?.base ?? currentName.replace(/\.[^.]*$/, '');
  return `${stem || 'Untitled'}.${target === 'markdown' ? 'md' : 'mmd'}`;
}
