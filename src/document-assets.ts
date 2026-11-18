// In-memory document asset map, shared by the renderer, the icon import flow, and
// the paired-document codec. This module owns the `reference -> inline body` shape,
// the icon/image classification, the immutable update helpers, and the standalone
// Markdown save gate. The on-disk paired index lives in paired-document.ts; it uses
// the same classification here and validates icon bodies through icon-safety.ts.
// Standalone Markdown has no agreed representation for those bodies yet, so every
// Markdown save path asks this module instead of assuming that writing the Mermaid
// and CSS fences preserves them.
export type DocumentAssets=Record<string,string>;

export type AssetKind='icon'|'image'|'unknown';

/** The import controls stop adding assets at this count; paired saves may carry more. */
export const IMPORTED_ASSET_LIMIT=64;

export function assetKind(body:string):AssetKind {
  if(/^\s*(?:<svg\b|<\/?[a-z][\w:-]*\b)/i.test(body)) return 'icon';
  if(/^data:image\//i.test(body)) return 'image';
  return 'unknown';
}

export function iconAssets(assets:DocumentAssets):[string,string][] {
  return Object.entries(assets).filter(([,body])=>assetKind(body)==='icon');
}

/** Local images the document carries, so the editor can list and remove them. */
export function imageAssets(assets:DocumentAssets):[string,string][] {
  return Object.entries(assets).filter(([,body])=>assetKind(body)==='image');
}

/** Immutable update used by the import/remove controls. */
export function addAsset(assets:DocumentAssets,reference:string,body:string):DocumentAssets {
  return {...assets,[reference]:body};
}

export function removeAsset(assets:DocumentAssets,reference:string):DocumentAssets {
  if(!Object.hasOwn(assets,reference)) return assets;
  const next={...assets};delete next[reference];return next;
}

/**
 * Explains why a standalone Markdown save cannot carry the document's assets, or
 * returns undefined when the document is representable. Paired documents do not use
 * this gate: they embed their assets in the adjacent index instead. Kept pure so save
 * paths and tests can share the exact wording.
 */
export function markdownAssetLimitation(assets:DocumentAssets):string|undefined {
  const references=Object.keys(assets).sort();
  if(!references.length) return undefined;
  const sample=references.slice(0,3).join(', ')+(references.length>3?', …':'');
  return `Markdown asset storage is not specified yet, so saving would lose ${references.length} embedded asset${references.length===1?'':'s'} (${sample}). Nothing was written and the assets remain in this draft's local recovery. Remove the imported assets from this document to save, or keep the draft until the Markdown asset mapping is finalized.`;
}

export function assertMarkdownAssetsRepresentable(assets:DocumentAssets):void {
  const limitation=markdownAssetLimitation(assets);
  if(limitation) throw new Error(limitation);
}
