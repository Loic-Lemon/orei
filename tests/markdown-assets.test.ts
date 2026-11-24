import { describe, expect, it } from 'vitest';
import { markdownAssetPaths, planMarkdownAssets } from '../src/markdown-assets';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
const otherImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAC';
const source = '# title\n\n```mermaid\ngraph TD\n A@{ img: "assets/photo.png" }\n```\n';

describe('Markdown asset persistence plan', () => {
  it('addresses each attachment by reference and content', () => {
    const first = planMarkdownAssets({ text: source, assets: { 'assets/photo.png': image }, attachments: '../media', namespace: 'note-a' });
    const manifest = markdownAssetPaths(first.text)!;
    // FNV-1a 64-bit of "assets/photo.png\0<data>": the reference is part of the address, so
    // two references with identical bytes cannot share a file.
    expect(first.files).toEqual([{ path: 'note-a/aa691ad2ca399a82/photo.png', data: image, kind: 'image' }]);
    expect(manifest.assets['assets/photo.png'].path).toBe('../media/note-a/aa691ad2ca399a82/photo.png');
    expect(first.text).toContain('A@{ img: "assets/photo.png" }');
  });

  it('repeats the same path for identical content and moves it when the bytes change', () => {
    const first = planMarkdownAssets({ text: source, assets: { 'assets/photo.png': image }, attachments: '../media', namespace: 'note-a' });
    const repeat = planMarkdownAssets({ text: first.text, assets: { 'assets/photo.png': image }, attachments: '../media', namespace: 'note-a' });
    expect(repeat.files).toEqual(first.files);
    expect(repeat.manifest.assets['assets/photo.png'].path).toBe(markdownAssetPaths(first.text)!.assets['assets/photo.png'].path);
    const changed = planMarkdownAssets({ text: first.text, assets: { 'assets/photo.png': otherImage }, attachments: '../media', namespace: 'note-a' });
    expect(changed.files[0].path).toBe('note-a/aa691bd2ca399c35/photo.png');
    expect(changed.manifest.assets['assets/photo.png'].path).not.toBe(first.manifest.assets['assets/photo.png'].path);
  });

  it('retains unknown markdown byte-for-byte and supports external CSS metadata', () => {
    const text = '\ufeff---\r\ntitle: Keep\r\n---\r\n\r\nText\r\n```mermaid\r\ngraph TD\r\n```\r\n<!-- orei:css:start -->\r\n```css\r\n.keep { color: red; }\r\n```\r\n<!-- orei:css:end -->\r\n';
    const plan = planMarkdownAssets({ text, assets: {}, attachments: '../chosen-assets', namespace: 'n', css: { externalPath: '../chosen-assets/n/custom.css', storagePath: 'n/custom.css', body: '.custom {}' } });
    expect(plan.text.replace(/\n?<!-- orei:assets:v1 .*? -->\n?/s, '')).toBe(text);
    expect(plan.manifest.css).toBe('../chosen-assets/n/custom.css');
    // The stylesheet is addressed in its own domain ('css', name, body) so it can never
    // collide with an asset address.
    expect(plan.files).toEqual([{ path: 'n/db6ced52ba2f8214/custom.css', data: '.custom {}', kind: 'css' }]);
  });

  it('supports an attachments root in the note folder without dot-prefixed asset paths', () => {
    const plan = planMarkdownAssets({ text: '# same folder', assets: { 'assets/photo.png': image }, attachments: '.', namespace: 'n' });
    expect(plan.manifest.attachments).toBe('.');
    expect(plan.manifest.assets['assets/photo.png'].path).toBe('n/aa691ad2ca399a82/photo.png');
    expect(plan.files[0].path).toBe('n/aa691ad2ca399a82/photo.png');
    expect(markdownAssetPaths(plan.text)?.attachments).toBe('.');
  });

  it('sanitizes the namespace and the stored file name', () => {
    const plan = planMarkdownAssets({ text: '# names', assets: { 'assets/my photo.png': image }, attachments: 'media', namespace: 'My Note' });
    expect(plan.files[0].path).toBe('My-Note/e15eacfecd6b83f6/my-photo.png');
    expect(plan.manifest.namespace).toBe('My Note');
  });

  it('rejects malformed and absolute manifest paths', () => {
    expect(() => planMarkdownAssets({ text: '<!-- orei:assets:v1 {"version":1,"attachments":"/tmp","assets":{}} -->', assets: {}, attachments: 'assets', namespace: 'n' })).toThrow('Invalid Markdown attachment path');
    expect(() => markdownAssetPaths('<!-- orei:assets:v1 broken -->')).toThrow('Malformed Orei asset metadata');
  });
});
