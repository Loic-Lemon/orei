// In-memory document asset map, shared by the renderer, the icon import flow, and
// the paired-document codec. This module owns the `reference -> inline body` shape,
// the icon/image classification and immutable update helpers. Markdown attachments
// are planned in `markdown-assets.ts`; the paired index lives in `paired-document.ts`.
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
