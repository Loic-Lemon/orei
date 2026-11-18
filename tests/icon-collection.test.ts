import {describe,expect,test} from 'vitest';
import {
  COLLECTION_ENTRY_LIMIT,
  COLLECTION_TEXT_LIMIT,
  collectionIconData,
  parseIconCollection,
  resolveCollectionIcon,
  searchIconCollection,
} from '../src/icon-collection';

const pack=(overrides:Record<string,unknown>={})=>({
  prefix:'acme',
  width:24,
  height:24,
  info:{
    name:'Acme icons',
    version:'1.2.0',
    author:{name:'Acme Design',url:'https://acme.invalid'},
    license:{title:'CC0 1.0',spdx:'CC0-1.0',url:'https://creativecommons.org/publicdomain/zero/1.0/'},
  },
  icons:{
    dot:{body:'<circle cx="12" cy="12" r="6"/>'},
    wide:{body:'<rect width="32" height="16"/>',width:32,height:16},
    rotated:{body:'<path d="M0 0"/>',rotate:1},
    flipped:{body:'<path d="M0 0"/>',hFlip:true},
    opposite:{body:'<path d="M0 0"/>',hFlip:true,vFlip:true},
    offset:{body:'<path d="M0 0"/>',left:2,top:4,width:20,height:12},
    'offset-rotated':{body:'<path d="M0 0"/>',left:2,top:4,width:20,height:12,rotate:1},
    gradient:{body:'<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="24" height="24" fill="url(#g)"/>',rotate:1},
    hidden:{body:'<path d="M0 0"/>',hidden:true},
  },
  aliases:{
    'dot-alias':{parent:'dot'},
    'dot-flipped':{parent:'dot',hFlip:true},
    chain:{parent:'dot-flipped',rotate:2},
    'big-alias':{parent:'wide',width:64,height:32},
  },
  lastModified:1700000000,
  ...overrides,
});
const parse=(overrides:Record<string,unknown>={}, namespace?:string)=>parseIconCollection(JSON.stringify(pack(overrides)),namespace);

describe('Iconify collection parsing',()=>{
  test('retains the collection prefix, defaults and upstream notice',()=>{
    const collection=parse();
    expect(collection.prefix).toBe('acme');
    expect(collection.width).toBe(24);
    expect(collection.height).toBe(24);
    expect(collection.lastModified).toBe(1700000000);
    expect(collection.info).toEqual({
      name:'Acme icons',
      version:'1.2.0',
      author:{name:'Acme Design',url:'https://acme.invalid'},
      license:{title:'CC0 1.0',spdx:'CC0-1.0',url:'https://creativecommons.org/publicdomain/zero/1.0/'},
    });
    expect(collection.unsupported).toEqual([]);
  });

  test('uses the defined namespace instead of the collection prefix',()=>{
    const collection=parse({},' Brand ');
    expect(collection.prefix).toBe('brand');
    expect(resolveCollectionIcon(collection,'dot').reference).toBe('brand:dot');
  });

  test('documents unsupported metadata rather than applying or dropping it silently',()=>{
    const collection=parse({
      chars:{f000:'dot'},
      categories:{Shapes:['dot']},
      themes:{solid:{title:'Solid'}},
      prefixes:{'s-':'Solid'},
      suffixes:{'-o':'Outline'},
      not_found:['missing'],
      provider:'acme',
      vendorExtra:{anything:true},
      icons:{dot:{body:'<circle cx="12" cy="12" r="6"/>',chars:'x'}},
      aliases:{},
    });
    expect(collection.unsupported).toEqual(expect.arrayContaining([
      expect.stringContaining('"chars"'),
      expect.stringContaining('"categories"'),
      expect.stringContaining('"themes"'),
      expect.stringContaining('"prefixes"'),
      expect.stringContaining('"suffixes"'),
      expect.stringContaining('"not_found"'),
      expect.stringContaining('"provider"'),
      expect.stringContaining('"vendorExtra"'),
      expect.stringContaining('icon property "chars"'),
    ]));
    expect(resolveCollectionIcon(collection,'dot').body).toContain('<circle');
  });

  test('accepts a collection without metadata but reports that no notice exists',()=>{
    const collection=parse({info:undefined});
    expect(collection.info).toBeUndefined();
  });
});

describe('Iconify icon resolution',()=>{
  test('returns a self-contained, scalable body that the shared validator accepts',()=>{
    const body=resolveCollectionIcon(parse(),'dot').body;
    expect(body).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(body).toContain('viewBox="0 0 24 24"');
    expect(body).toContain('<circle cx="12" cy="12" r="6"/>');
    expect(body).toContain('fill="currentColor"');
    expect(body).toContain('stroke="none"');
    expect(body).toContain('stroke-width="1"');
    expect(body).not.toMatch(/(?:href|src)="(?:https?:|file:)/);
  });

  test('honors collection defaults, per-icon dimensions and offsets',()=>{
    expect(collectionIconData(parse(),'wide')).toMatchObject({width:32,height:16});
    expect(resolveCollectionIcon(parse(),'wide').body).toContain('viewBox="0 0 32 16"');
    expect(resolveCollectionIcon(parse(),'offset').body).toContain('viewBox="2 4 20 12"');
    const defaults=parse({width:48,height:48,icons:{plain:{body:'<path d="M0 0"/>'}},aliases:{}});
    expect(resolveCollectionIcon(defaults,'plain').body).toContain('viewBox="0 0 48 48"');
  });

  test('resolves alias chains and merges their dimensions and transforms',()=>{
    const collection=parse();
    expect(resolveCollectionIcon(collection,'dot-alias').body).toContain('<circle cx="12" cy="12" r="6"/>');
    expect(resolveCollectionIcon(collection,'big-alias').body).toContain('viewBox="0 0 64 32"');
    const chain=resolveCollectionIcon(collection,'chain').body;
    expect(chain).toContain('<g transform="rotate(180 12 12) translate(24 0) scale(-1 1)">');
    expect(chain).toContain('viewBox="0 0 24 24"');
  });

  test('applies Iconify rotations and flips exactly',()=>{
    const collection=parse();
    expect(resolveCollectionIcon(collection,'rotated').body).toContain('transform="rotate(90 12 12)"');
    expect(resolveCollectionIcon(collection,'flipped').body).toContain('transform="translate(24 0) scale(-1 1)"');
    // Both flips are a 180-degree rotation in Iconify, not two nested mirrors.
    const opposite=resolveCollectionIcon(collection,'opposite').body;
    expect(opposite).toContain('transform="rotate(180 12 12)"');
    expect(opposite).not.toContain('scale(');
    // An odd rotation swaps the visible width and height and rotates around the offset center.
    const rotated=resolveCollectionIcon(collection,'offset-rotated').body;
    expect(rotated).toContain('viewBox="4 2 12 20"');
    expect(rotated).toContain('transform="rotate(90 10 10)"');
  });

  test('keeps safe definitions outside the transform wrapper',()=>{
    const body=resolveCollectionIcon(parse(),'gradient').body;
    expect(body).toContain('<defs><linearGradient id="g">');
    expect(body.indexOf('<defs>')).toBeLessThan(body.indexOf('<g transform="rotate(90 12 12)">'));
    expect(body).toContain('fill="url(#g)"');
  });

  test('keeps hidden icons resolvable even though the library does not list them',()=>{
    expect(resolveCollectionIcon(parse(),'hidden').hidden).toBe(true);
  });

  test('searches names and references, skipping hidden entries, with a limit',()=>{
    const collection=parse();
    const names=(query:string,limit=24)=>searchIconCollection(collection,query,limit).map(result=>result.name);
    expect(names('dot')).toEqual(['dot','dot-alias','dot-flipped']);
    expect(names('acme:chain')).toEqual(['chain']);
    expect(names('acme',99)).not.toContain('hidden');
    expect(names('acme',2)).toHaveLength(2);
    expect(names('nothing-matches')).toEqual([]);
  });
});

describe('Iconify collection validation',()=>{
  const rejects=(overrides:Record<string,unknown>,message:string|RegExp,namespace?:string)=>{
    expect(()=>parse(overrides,namespace)).toThrow(message);
  };

  test('rejects malformed and oversized JSON input',()=>{
    expect(()=>parseIconCollection('not json')).toThrow('not valid JSON');
    expect(()=>parseIconCollection('[]')).toThrow('must be an object');
    expect(()=>parseIconCollection(' '.repeat(COLLECTION_TEXT_LIMIT+1))).toThrow(`${COLLECTION_TEXT_LIMIT} characters`);
    rejects({icons:[]},'collection icons must be an object');
    rejects({icons:undefined},'collection icons must be an object');
  });

  test('rejects invalid names and namespaces',()=>{
    rejects({prefix:'Acme'},'prefix');
    rejects({prefix:'9lives'},'prefix');
    expect(()=>parse({},'has space')).toThrow('namespace');
    rejects({icons:{'Bad Name':{body:'<path d="M0 0"/>'}}},'not a valid icon name');
    rejects({aliases:{'Bad Name':{parent:'dot'}}},'not a valid alias name');
  });

  test('validates decoded sizes and definitions',()=>{
    rejects({width:0},'width must be greater than zero');
    rejects({height:-1},'height must be greater than zero');
    rejects({icons:{bad:{body:'<path d="M0 0"/>',width:'24'}}},'width must be a finite number');
    rejects({icons:{bad:{body:'<path d="M0 0"/>',height:Number.POSITIVE_INFINITY}}},'finite number');
    rejects({icons:{bad:{}}},'body must be a non-empty string');
    rejects({icons:{bad:{body:'   '}}},'body must be a non-empty string');
    rejects({icons:{bad:{body:'<path d="M0 0"/>',hFlip:'yes'}}},'hFlip must be true or false');
    rejects({icons:{bad:{body:'<path d="M0 0"/>',rotate:1.5}}},'whole number of 90-degree steps');
    rejects({icons:{bad:{body:'<script>alert(1)</script>'}}},'Unsupported icon content');
    rejects({icons:{bad:{body:'<rect width="1" height="1" onload="x()"/>'}}},'Active content');
  });

  test('rejects broken alias definitions and cycles',()=>{
    rejects({aliases:{orphan:{parent:'missing'}}},'missing icon or alias');
    rejects({aliases:{orphan:{parent:'dot',body:'<path d="M0 0"/>'}}},'must not define a body');
    rejects({aliases:{dot:{parent:'dot'}}},'both an icon and an alias');
    rejects({aliases:{a:{parent:'b'},b:{parent:'a'}}},'alias cycle');
  });

  test('rejects malformed upstream notices instead of retaining partial data',()=>{
    rejects({info:{author:{name:'Acme'},license:{title:'CC0'}}},'info name must be a non-empty string');
    rejects({info:{name:'Acme',author:{},license:{title:'CC0'}}},'author name must be a non-empty string');
    rejects({info:{name:'Acme',author:{name:'Acme'},license:{}}},'license title must be a non-empty string');
  });

  test('rejects entries beyond the collection limit',()=>{
    const icons=Object.fromEntries(Array.from({length:COLLECTION_ENTRY_LIMIT+1},(_,index)=>[`icon-${index}`,{body:'<path d="M0 0"/>'}]));
    rejects({icons},`exceed the limit of ${COLLECTION_ENTRY_LIMIT}`);
  });
});
