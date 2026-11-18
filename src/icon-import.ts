// An imported individual SVG is stored as a document asset keyed by `namespace:name`
// in the same map that carries local image data, so the active diagram can reference
// it as @{ icon: "namespace:name" }. document-assets.ts owns that map's shape and
// paired-document.ts writes the same keys into the adjacent asset index; icon-safety.ts
// validates the body on import, render, and paired read/write.
import { parseImportedIconSvg } from './icon-safety';
import { addAsset, IMPORTED_ASSET_LIMIT, type DocumentAssets } from './document-assets';
export { IMPORTED_ASSET_LIMIT };
export type ImportedIcon={reference:string;namespace:string;name:string;body:string};

export class IconCollisionError extends Error {
  reference:string;
  constructor(reference:string){
    super(`An icon named ${reference} already exists in this document. Choose a different name or namespace; nothing was changed.`);
    this.name='IconCollisionError';this.reference=reference;
  }
}

export function normalizeIconNamespace(value:string):string {
  const namespace=value.trim().toLowerCase();
  if(namespace==='lucide') throw new Error('The namespace "lucide" is reserved by the bundled icon collection');
  if(!/^[a-z][a-z0-9-]{0,31}$/.test(namespace)) throw new Error(`Invalid icon namespace ${JSON.stringify(value)}: use 1-32 lowercase letters, digits or dashes starting with a letter`);
  return namespace;
}

export function normalizeIconName(value:string):string {
  const name=value.trim().toLowerCase();
  if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error(`Invalid icon name ${JSON.stringify(value)}: use 1-64 lowercase letters, digits, dashes or underscores starting with an alphanumeric character`);
  return name;
}

/** Derives a valid default name from a picked file name; the user can edit it. */
export function iconNameFromFilename(value:string):string {
  const base=value.replace(/^.*[\\/]/,'').replace(/\.[^.]*$/,'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^[-_]+|[-_]+$/g,'').slice(0,64);
  return base||'icon';
}

export function importSvgIcon(input:{namespace:string;name:string;svg:string;existing:Record<string,string>}):ImportedIcon {
  const namespace=normalizeIconNamespace(input.namespace);
  const name=normalizeIconName(input.name);
  const reference=`${namespace}:${name}`;
  if(Object.hasOwn(input.existing,reference)) throw new IconCollisionError(reference);
  if(Object.keys(input.existing).length>=IMPORTED_ASSET_LIMIT) throw new Error(`This document already carries the maximum of ${IMPORTED_ASSET_LIMIT} assets, so ${reference} cannot be imported. Paired documents may hold more via the adjacent asset index; remove an asset or save the document as a pair first.`);
  return {reference,namespace,name,body:parseImportedIconSvg(reference,input.svg)};
}

/** Immutable insert; collision policy stays in importSvgIcon so both callers agree. */
export function withIconAsset(assets:DocumentAssets,icon:ImportedIcon):DocumentAssets {
  if(Object.hasOwn(assets,icon.reference)) throw new IconCollisionError(icon.reference);
  return addAsset(assets,icon.reference,icon.body);
}
