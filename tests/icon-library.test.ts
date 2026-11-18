import {describe,expect,test} from 'vitest';
import {bundledIconCollection} from '../src/bundled-icons';
import {
  collectionIconCount,
  collectionNotice,
  emptyIconLibrary,
  findIcon,
  importIconCollection,
  readIconLibrary,
  removeIconCollection,
  resolveIconReference,
  searchIcons,
  storeIconLibrary,
  withIconReference,
} from '../src/icon-library';

const json=(prefix:string, extra:Record<string,unknown>={})=>JSON.stringify({
  prefix,
  width:24,
  height:24,
  info:{name:`${prefix} icons`,author:{name:'Design Team'},license:{title:'MIT',spdx:'MIT'}},
  icons:{dot:{body:'<circle cx="12" cy="12" r="6"/>'},ring:{body:'<circle cx="12" cy="12" r="9" fill="none"/>'}},
  aliases:{'dot-alias':{parent:'dot'}},
  ...extra,
});

describe('local icon library persistence',()=>{
  test('imported collections survive a restart with their notice',()=>{
    const {library}=importIconCollection(emptyIconLibrary(),json('acme'));
    expect(storeIconLibrary(library)).toBeUndefined();
    const reloaded=readIconLibrary();
    expect(reloaded.problems).toEqual([]);
    expect(reloaded.library.collections).toHaveLength(1);
    const [collection]=reloaded.library.collections;
    expect(collection.prefix).toBe('acme');
    expect(collectionIconCount(collection)).toBe(3);
    expect(collectionNotice(collection)).toBe('acme icons by Design Team · MIT (MIT)');
  });

  test('a corrupt or unsupported stored library is reported instead of thrown',()=>{
    localStorage.setItem('orei-icon-library-v1','not json');
    expect(readIconLibrary()).toMatchObject({problems:[expect.stringContaining('not valid JSON')]});
    localStorage.setItem('orei-icon-library-v1',JSON.stringify({format:'something-else',version:1,collections:[]}));
    expect(readIconLibrary().problems[0]).toContain('unsupported format');
  });

  test('skips one unreadable stored collection while keeping the others',()=>{
    localStorage.setItem('orei-icon-library-v1',JSON.stringify({
      format:'orei-icon-library',
      version:1,
      collections:[JSON.parse(json('acme')),{prefix:'broken'}],
    }));
    const {library,problems}=readIconLibrary();
    expect(library.collections.map(collection=>collection.prefix)).toEqual(['acme']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Stored icon collection 2');
  });

  test('revalidates a stored definition when it is used instead of trusting the library file',()=>{
    const stored=JSON.parse(json('acme'));
    stored.icons.dot.body='<script>alert(1)</script>';
    localStorage.setItem('orei-icon-library-v1',JSON.stringify({format:'orei-icon-library',version:1,collections:[stored]}));
    const {library,problems}=readIconLibrary();
    expect(problems).toEqual([]);
    expect(()=>resolveIconReference(library,'acme:dot')).toThrow('Unsupported icon content');
  });

  test('reports a storage failure instead of claiming the library was saved',()=>{
    const failing={setItem(){throw new Error('quota exceeded');}} as unknown as Storage;
    expect(storeIconLibrary(emptyIconLibrary(),failing)).toContain('quota exceeded');
    expect(storeIconLibrary(emptyIconLibrary(),failing)).toContain('Nothing was imported');
  });
});

describe('importing collections',()=>{
  test('refuses duplicate namespaces explicitly and keeps the original pack',()=>{
    const first=importIconCollection(emptyIconLibrary(),json('acme'));
    expect(()=>importIconCollection(first.library,json('acme',{icons:{other:{body:'<path d="M0 0"/>'}},aliases:{}})))
      .toThrow('already imported');
    expect(first.library.collections[0].icons).toHaveProperty('dot');
  });

  test('refuses the bundled namespace for both the pack and the chosen namespace',()=>{
    expect(()=>importIconCollection(emptyIconLibrary(),json('lucide'))).toThrow('reserved by the bundled icon collection');
    expect(()=>importIconCollection(emptyIconLibrary(),json('acme'),{namespace:'lucide'})).toThrow('reserved by the bundled icon collection');
  });

  test('accepts an explicit namespace and applies the icon namespace rules',()=>{
    const {collection}=importIconCollection(emptyIconLibrary(),json('acme'),{namespace:' Acme-Brand '});
    expect(collection.prefix).toBe('acme-brand');
    expect(()=>importIconCollection(emptyIconLibrary(),json('acme'),{namespace:'1bad'})).toThrow('namespace');
  });

  test('enforces collection and library capacity before changing anything',()=>{
    const first=importIconCollection(emptyIconLibrary(),json('acme'));
    expect(()=>importIconCollection(first.library,json('beta'),{limits:{collections:1}})).toThrow('maximum of 1 imported collections');
    expect(()=>importIconCollection(first.library,json('beta'),{limits:{characters:10}})).toThrow('character');
    expect(first.library.collections).toHaveLength(1);
  });

  test('removes only the requested collection',()=>{
    const first=importIconCollection(emptyIconLibrary(),json('acme'));
    const second=importIconCollection(first.library,json('beta'));
    const remaining=removeIconCollection(second.library,'acme');
    expect(remaining.collections.map(collection=>collection.prefix)).toEqual(['beta']);
    expect(removeIconCollection(remaining,'missing')).toBe(remaining);
  });
});

describe('searching and using icons',()=>{
  test('searches imported packs and the bundled collection through one list',()=>{
    const {library}=importIconCollection(emptyIconLibrary(),json('acme'));
    const imported=searchIcons(library,'acme:dot');
    expect(imported[0]).toMatchObject({prefix:'acme',name:'dot',reference:'acme:dot'});
    const bundled=searchIcons(library,'lucide:house');
    expect(bundled[0]).toMatchObject({prefix:'lucide',name:'house',reference:'lucide:house'});
    expect(collectionNotice(bundledIconCollection())).toContain('Lucide Contributors');
    expect(collectionNotice(bundledIconCollection())).toContain('ISC');
  });

  test('resolves imported and bundled references but reports unknown ones',()=>{
    const {library}=importIconCollection(emptyIconLibrary(),json('acme'));
    expect(resolveIconReference(library,'acme:dot-alias')).toContain('<circle cx="12" cy="12" r="6"/>');
    expect(resolveIconReference(library,'lucide:house')).toContain('<path');
    expect(()=>resolveIconReference(library,'acme:missing')).toThrow('not in the local icon library');
    expect(()=>resolveIconReference(library,'unknown:dot')).toThrow('not in the local icon library');
    expect(findIcon(library,'nonsense')).toBeUndefined();
  });

  test('materializes only the used imported definition and leaves bundled icons alone',()=>{
    const {library}=importIconCollection(emptyIconLibrary(),json('acme'));
    const withBundled=withIconReference({},library,'lucide:house');
    expect(withBundled).toEqual({});
    const withDot=withIconReference({},library,'acme:dot');
    expect(Object.keys(withDot)).toEqual(['acme:dot']);
    expect(withDot['acme:dot']).toContain('viewBox="0 0 24 24"');
    expect(withDot['acme:dot']).toContain('<circle cx="12" cy="12" r="6"/>');
    // The same reference is identity: an already-carried definition is kept as written.
    const existing={'acme:dot':'<circle cx="12" cy="12" r="3"/>'};
    expect(withIconReference(existing,library,'acme:dot')).toBe(existing);
    expect(withIconReference({},library,'lucide:house')).toEqual({});
  });

  test('applies the document asset limit when materializing a definition',()=>{
    const {library}=importIconCollection(emptyIconLibrary(),json('acme'));
    const full=Object.fromEntries(Array.from({length:64},(_,index)=>[`a:i${index}`,'<path d="M0 0"/>']));
    expect(()=>withIconReference(full,library,'acme:dot')).toThrow('maximum of 64 assets');
    expect(()=>withIconReference({},library,'acme:missing')).toThrow('not in the local icon library');
  });
});
