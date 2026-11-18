import {test,expect,describe} from 'vitest';
import {addAsset,assetKind,iconAssets,markdownAssetLimitation,removeAsset,assertMarkdownAssetsRepresentable} from '../src/document-assets';

describe('document asset representation seam',()=>{
  test('classifies inline icon markup and image data',()=>{
    expect(assetKind('<svg xmlns="http://www.w3.org/2000/svg"/>')).toBe('icon');
    expect(assetKind('<path d="M0 0"/>')).toBe('icon');
    expect(assetKind('data:image/png;base64,AAAA')).toBe('image');
    expect(assetKind('')).toBe('unknown');
  });
  test('an asset-free document is representable in Markdown',()=>{
    expect(markdownAssetLimitation({})).toBeUndefined();
    expect(()=>assertMarkdownAssetsRepresentable({})).not.toThrow();
  });
  test('imported icons block Markdown saves and name the draft recovery that retains them',()=>{
    const limitation=markdownAssetLimitation({'custom:car':'<svg/>','custom:van':'<path/>'});
    expect(limitation).toContain('Markdown asset storage is not specified yet');
    expect(limitation).toContain('2 embedded assets');
    expect(limitation).toContain('custom:car, custom:van');
    expect(limitation).toContain("draft's local recovery");
    expect(limitation).toContain('Nothing was written');
    expect(()=>assertMarkdownAssetsRepresentable({'custom:car':'<svg/>'})).toThrow('Nothing was written');
  });
  test('local images are equally unrepresentable until the mapping lands',()=>{
    expect(markdownAssetLimitation({'assets/local.png':'data:image/png;base64,AAAA'})).toContain('1 embedded asset');
  });
  test('only icons are listed by the icon library and long lists are truncated',()=>{
    const assets={'a:one':'<svg/>','assets/local.png':'data:image/png;base64,AAAA','b:two':'<path/>','c:three':'<path/>','d:four':'<path/>'};
    expect(iconAssets(assets).map(([reference])=>reference)).toEqual(['a:one','b:two','c:three','d:four']);
    expect(markdownAssetLimitation(assets)).toContain('a:one, assets/local.png, b:two, …');
  });
  test('add and remove are immutable',()=>{
    const before={'custom:car':'<svg/>'};
    const added=addAsset(before,'custom:van','<path/>');
    expect(before).toEqual({'custom:car':'<svg/>'});
    expect(added).toEqual({'custom:car':'<svg/>','custom:van':'<path/>'});
    const removed=removeAsset(added,'custom:car');
    expect(added).toEqual({'custom:car':'<svg/>','custom:van':'<path/>'});
    expect(removed).toEqual({'custom:van':'<path/>'});
    expect(removeAsset(removed,'missing:icon')).toBe(removed);
  });
});
