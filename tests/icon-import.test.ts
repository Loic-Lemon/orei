import {test,expect,describe} from 'vitest';
import {ICON_BODY_LIMIT,ICON_ELEMENT_LIMIT,ICON_FILE_LIMIT,validateIconBody} from '../src/icon-safety';
import {IMPORTED_ASSET_LIMIT,IconCollisionError,iconNameFromFilename,importSvgIcon,withIconAsset} from '../src/icon-import';

const car='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
const seed:Record<string,string>=Object.fromEntries(Array.from({length:IMPORTED_ASSET_LIMIT},(_,i)=>[`a:i${i}`,'<path d="M0 0"/>']));

describe('importSvgIcon',()=>{
  test('stores an individual SVG under its namespace:name reference',()=>{
    const imported=importSvgIcon({namespace:'custom',name:'car',svg:car,existing:{}});
    expect(imported.reference).toBe('custom:car');
    expect(imported.namespace).toBe('custom');
    expect(imported.name).toBe('car');
    expect(imported.body).toContain('viewBox="0 0 24 24"');
    expect(imported.body).toContain('<path d="M0 0h24v24H0z"/>');
  });
  test('normalizes namespace and name casing and whitespace',()=>{
    const imported=importSvgIcon({namespace:'  Custom ',name:' Delivery-Van_2 ',svg:car,existing:{}});
    expect(imported.reference).toBe('custom:delivery-van_2');
  });
  test.each(['lucide','','1x','has space','x:y','tüte','a'.repeat(33)])('rejects invalid namespace %s',namespace=>{
    expect(()=>importSvgIcon({namespace,name:'car',svg:car,existing:{}})).toThrow('namespace');
  });
  test('rejects the reserved bundled namespace with a clear message',()=>{
    expect(()=>importSvgIcon({namespace:'lucide',name:'house',svg:car,existing:{}})).toThrow('reserved by the bundled icon collection');
  });
  test.each(['','a b','.hidden','é','x:y','a'.repeat(65)])('rejects invalid icon name %s',name=>{
    expect(()=>importSvgIcon({namespace:'custom',name,svg:car,existing:{}})).toThrow('Invalid icon name');
  });
  test('rejects a naming collision explicitly without changing anything',()=>{
    const existing={'custom:car':'<path d="M0 0"/>'};
    const error=(()=>{try{importSvgIcon({namespace:'Custom',name:' car',svg:car,existing});return null;}catch(e){return e as Error;}})()!;
    expect(error).toBeInstanceOf(IconCollisionError);
    expect((error as IconCollisionError).reference).toBe('custom:car');
    expect(error.message).toContain('custom:car');
    expect(error.message).toContain('nothing was changed');
    expect(existing).toEqual({'custom:car':'<path d="M0 0"/>'});
    expect(()=>importSvgIcon({namespace:'custom',name:'van',svg:car,existing})).not.toThrow();
  });
  test('rejects imports beyond the per-document asset limit',()=>{
    expect(()=>importSvgIcon({namespace:'custom',name:'car',svg:car,existing:seed})).toThrow(`maximum of ${IMPORTED_ASSET_LIMIT} assets`);
  });
  test('derives a usable default name from a picked file name',()=>{
    expect(iconNameFromFilename('Delivery Van.svg')).toBe('delivery-van');
    expect(iconNameFromFilename('/tmp/Ünicode_Icon 2.svg')).toBe('unicode_icon-2');
    expect(iconNameFromFilename('.svg')).toBe('icon');
    expect(iconNameFromFilename('x'.repeat(90)+'.svg')).toHaveLength(64);
  });
  test('withIconAsset inserts immutably and preserves the collision rule',()=>{
    const imported=importSvgIcon({namespace:'custom',name:'car',svg:car,existing:{}});
    const assets=withIconAsset({},imported);
    expect(assets).toEqual({'custom:car':imported.body});
    expect(()=>withIconAsset({'custom:car':'<path/>'},imported)).toThrow(IconCollisionError);
  });
});

describe('imported SVG validation',()=>{
  test('rejects non-SVG roots, malformed XML, and missing namespace with distinct messages',()=>{
    expect(()=>importSvgIcon({namespace:'custom',name:'car',svg:'<g xmlns="http://www.w3.org/2000/svg"/>',existing:{}})).toThrow('must have a root <svg> element');
    expect(()=>importSvgIcon({namespace:'custom',name:'car',svg:'<svg xmlns="http://www.w3.org/2000/svg"><path></svg>',existing:{}})).toThrow('not well-formed XML');
    expect(()=>importSvgIcon({namespace:'custom',name:'car',svg:'<svg viewBox="0 0 24 24"><path d="M0 0"/></svg>',existing:{}})).toThrow('must declare the SVG namespace');
  });
  test('rejects active and external content while preserving safe internal definitions',()=>{
    for(const svg of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" onload="x()"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.invalid"><path d="M0 0"/></a></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" fill="url(https://example.invalid/a)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" style="fill:url(https://example.invalid/a)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="images/local.png"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="https://example.invalid/a"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:red}</style><rect width="1" height="1"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="1" height="1"/></svg>',
      '<!DOCTYPE svg [<!ENTITY x "x">]><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
    ]) expect(()=>importSvgIcon({namespace:'custom',name:'car',svg,existing:{}})).toThrow();
    const safe='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><clipPath id="c"><rect width="4" height="4"/></clipPath><mask id="m"><rect width="4" height="4" fill="#fff"/></mask><symbol id="s" viewBox="0 0 4 4"><path d="M0 0"/></symbol></defs><title>Safe icon</title><rect width="4" height="4" fill="url(#g)" clip-path="url(#c)" mask="url(#m)"/><use href="#s"/></svg>';
    const imported=importSvgIcon({namespace:'custom',name:'safe',svg:safe,existing:{}});
    expect(imported.body).toContain('<defs>');
    expect(imported.body).toContain('<linearGradient id="g">');
    expect(imported.body).toContain('<clipPath id="c">');
    expect(imported.body).toContain('<mask id="m">');
    expect(imported.body).toContain('<symbol id="s"');
    expect(imported.body).toContain('<title>Safe icon</title>');
    expect(imported.body).toContain('href="#s"');
    expect(imported.body).toContain('fill="url(#g)"');
    expect(()=>importSvgIcon({namespace:'custom',name:'broken',svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><use href="#missing"/></svg>',existing:{}})).toThrow('missing internal definition');
  });
  test('rejects excessive resources clearly',()=>{
    const wide='<svg xmlns="http://www.w3.org/2000/svg">'+Array.from({length:ICON_ELEMENT_LIMIT},(_,i)=>`<rect width="1" height="1" x="${i}"/>`).join('')+'</svg>';
    expect(()=>importSvgIcon({namespace:'custom',name:'wide',svg:wide,existing:{}})).toThrow(`too many elements: the limit is ${ICON_ELEMENT_LIMIT}`);
    const long='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'+Array.from({length:300},()=>`<path d="${'M0 0'.repeat(100)}"/>`).join('')+'</svg>';
    expect(()=>importSvgIcon({namespace:'custom',name:'wide',svg:long,existing:{}})).toThrow(`${ICON_BODY_LIMIT}-character limit`);
    const huge='<svg xmlns="http://www.w3.org/2000/svg">'+' '.repeat(ICON_FILE_LIMIT)+'</svg>';
    expect(()=>importSvgIcon({namespace:'custom',name:'wide',svg:huge,existing:{}})).toThrow(`${ICON_FILE_LIMIT} characters`);
  });
  test('makes an imported icon scale from its viewBox or numeric dimensions',()=>{
    const derived=importSvgIcon({namespace:'custom',name:'legacy',svg:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><path d="M0 0"/></svg>',existing:{}});
    expect(derived.body).toContain('viewBox="0 0 64 48"');
    expect(derived.body).not.toContain('width="64"');
    expect(derived.body).not.toContain('height="48"');
    const squeezed=importSvgIcon({namespace:'custom',name:'wide',svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 20" width="200" height="40"><path d="M0 0"/></svg>',existing:{}});
    expect(squeezed.body).toContain('viewBox="0 0 100 20"');
    expect(squeezed.body).not.toContain('width="200"');
    for(const svg of [
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%"><path d="M0 0"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 24"><path d="M0 0"/></svg>',
    ]) expect(()=>importSvgIcon({namespace:'custom',name:'bad',svg,existing:{}})).toThrow();
  });
  test('isolates imported paint from the host icon wrapper without overriding explicit artwork paint',()=>{
    const plain=importSvgIcon({namespace:'custom',name:'plain',svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0"/></svg>',existing:{}});
    expect(plain.body).toContain('fill="currentColor"');
    expect(plain.body).toContain('stroke="none"');
    const stroked=importSvgIcon({namespace:'custom',name:'stroked',svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M0 0"/></svg>',existing:{}});
    expect(stroked.body).toContain('fill="none"');
    expect(stroked.body).toContain('stroke="currentColor"');
    expect(stroked.body).toContain('stroke-width="2"');
    expect(stroked.body).not.toContain('fill="currentColor"');
  });
  test('validateIconBody accepts both full nested svg elements and inner iconify-style bodies',()=>{
    expect(validateIconBody('fixture:star','<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0L24 24"/></svg>')).toContain('viewBox');
    expect(validateIconBody('custom:dot','<circle cx="12" cy="12" r="6"/>')).toBe('<circle cx="12" cy="12" r="6"/>');
    expect(()=>validateIconBody('custom:bad','<foreignObject width="1" height="1"/>')).toThrow('Unsupported icon content');
    expect(()=>validateIconBody('custom:bad','<rect width="1" height="1" onload="x()"/>')).toThrow('Active content');
  });
});
