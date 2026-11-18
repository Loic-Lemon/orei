// The bundled Lucide collection, exposed through the same Iconify collection model as
// imported packs so search and preview use one implementation. Rendering keeps its
// existing output for untransformed icons: the raw Iconify body inside Pele's own 24px
// icon wrapper, with alias chains resolved. The upstream notice comes from the package's
// info.json and is shown by the icon library UI.
import lucideIcons from '@iconify-json/lucide/icons.json';
import lucideInfo from '@iconify-json/lucide/info.json';
import { collectionIconData, parseIconCollectionValue, resolveCollectionIcon, type IconCollection } from './icon-collection';

export const BUNDLED_ICON_PREFIX='lucide';

let bundled:IconCollection|undefined;

export function bundledIconCollection():IconCollection {
  // Lazy so files that never touch icons do not pay for validating thousands of entries.
  return bundled??=parseIconCollectionValue({...lucideIcons,info:lucideInfo},BUNDLED_ICON_PREFIX,{validateBodies:false});
}

/** The markup Pele embeds for a bundled icon; undefined reports a missing name. */
export function bundledIconMarkup(name:string):string|undefined {
  try {
    const data=collectionIconData(bundledIconCollection(),name);
    return data.rotate||data.hFlip||data.vFlip?resolveCollectionIcon(bundledIconCollection(),name).body:data.body;
  } catch { return undefined; }
}
