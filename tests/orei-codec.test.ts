import { describe, expect, it } from 'vitest';
import { decodeOrei, encodeOrei, type OreiDocument } from '../src/orei-codec';

const doc = (): OreiDocument => ({format:'orei',version:1,source:'flowchart LR\r\n  A-->B\n',css:'/* x */\n',assets:{},future:{nested:['kept',false]}});
const base = 'format: orei\nversion: 1\nsource: ""\ncss: ""\nassets: {}\n';

describe('.orei codec',()=>{
  it('preserves text and unknown JSON metadata, including special property names',()=>{
    const value = decodeOrei(base+'extra: {"__proto__": {safe: true}, "constructor": value, "1": quoted}\n');
    expect(decodeOrei(encodeOrei(value))).toEqual(value);
    expect(Object.hasOwn(value.extra as object, '__proto__')).toBe(true);
    expect(decodeOrei(encodeOrei(doc()))).toEqual(doc());
  });
  it('accepts ordinary YAML and rejects duplicate keys and unsupported versions',()=>{
    expect(decodeOrei('# comment\n'+base+'extra: [one, true]\n')).toMatchObject({extra:['one',true]});
    expect(()=>decodeOrei('{"format":"orei","format":"orei"}')).toThrow();
    expect(()=>decodeOrei('{"a":{"x":1,"\\u0078":2}}')).toThrow();
    expect(()=>decodeOrei(JSON.stringify({...doc(),version:2}))).toThrow();
  });
  it('rejects non-string mapping keys at every depth before conversion',()=>{
    for (const key of ['1', 'true', 'null', '[a, b]', '{a: b}']) {
      expect(()=>decodeOrei(base+`extra: {${key}: value}\n`)).toThrow();
    }
    expect(decodeOrei(base+'extra: {"1": value, "true": yes}\n')).toMatchObject({extra:{'1':'value','true':'yes'}});
  });
  it('rejects tags, aliases, and multiple documents',()=>{
    for (const extra of ['extra: !custom value\n','extra: &a [one]\nother: *a\n','---\nother: document\n']) expect(()=>decodeOrei(base+extra)).toThrow();
  });
  it('rejects plain merge keys at any depth while preserving quoted metadata keys',()=>{
    for (const extra of ['<<: {extra: value}\n', 'extra: {nested: {<<: {x: y}}}\n', 'extra: &a {x: y}\nother: {<<: *a}\n']) {
      expect(()=>decodeOrei(base+extra)).toThrow();
    }
    const value=decodeOrei(base+'extra: {"<<": value, nested: {\'<<\': kept}}\n');
    expect(decodeOrei(encodeOrei(value))).toEqual(value);
  });
  it('rejects unsupported embedded assets and defines their name limit',()=>{
    const icon={kind:'icon',mediaType:'image/svg+xml',encoding:'text',data:'<path/>'};
    const png={kind:'image',mediaType:'image/png',encoding:'base64',data:'iVBORw=='};
    for (const asset of [icon,png]) expect(()=>encodeOrei({...doc(),assets:{'custom:x':asset} as OreiDocument['assets']})).toThrow('Unsupported embedded asset');
    expect(()=>decodeOrei(JSON.stringify({...doc(),assets:{'':icon}}))).toThrow('Invalid asset');
    expect(()=>decodeOrei(JSON.stringify({...doc(),assets:{['é'.repeat(257)]:icon}}))).toThrow('Invalid asset');
    expect(()=>decodeOrei(JSON.stringify({...doc(),assets:{['é'.repeat(256)]:icon}}))).toThrow('Unsupported embedded asset');
    expect(()=>decodeOrei(JSON.stringify({...doc(),assets:{bad:{...icon,data:'é'.repeat(1024*1024+1)}}}))).toThrow('Invalid asset');
  });
  it('rejects values that JSON would alter, omit, execute, or fail to encode',()=>{
    const getter = Object.defineProperty({}, 'secret', {enumerable:true, get(){ throw new Error('getter executed'); }});
    const hidden = Object.defineProperty({}, 'secret', {value:1});
    const symbol = {[Symbol('secret')]:1};
    const sparse = Array(1);
    const extraArray = Object.assign([1], {extra:2});
    const cycle: Record<string, unknown> = {}; cycle.self=cycle;
    const invalid = [undefined, ()=>1, Symbol(), 1n, Infinity, NaN, -0, new Date(), new Map(), /x/, getter, hidden, symbol, sparse, extraArray, cycle, {toJSON(){return 'lost';}}];
    for (const future of invalid) expect(()=>encodeOrei({...doc(),future})).toThrow();
    expect(()=>decodeOrei(base+'extra: -.inf\n')).toThrow();
  });
  it('limits file size in UTF-8 bytes',()=>{
    expect(()=>decodeOrei(JSON.stringify({...doc(),source:'é'.repeat(4*1024*1024)}))).toThrow('too large');
  });
});
