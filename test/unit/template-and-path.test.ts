import { describe, expect, it } from 'vitest';
import { getPath, parsePath } from '../../src/lib/json-path.js';
import { extractRefs, resolveTemplates, TemplateError } from '../../src/orchestration/template.js';

describe('json-path', () => {
  const doc = { results: [{ url: 'a', n: 1 }, { url: 'b', n: 2 }], meta: { total: 2 } };

  it('resolves keys, indices and wildcards', () => {
    expect(getPath(doc, 'meta.total')).toEqual({ found: true, value: 2 });
    expect(getPath(doc, 'results[1].url')).toEqual({ found: true, value: 'b' });
    expect(getPath(doc, 'results[*].url')).toEqual({ found: true, value: ['a', 'b'] });
    expect(getPath(doc, '$')).toEqual({ found: true, value: doc });
    expect(getPath(doc, 'missing.x').found).toBe(false);
  });

  it('rejects prototype access and junk syntax', () => {
    expect(() => parsePath('__proto__.polluted')).toThrow(/Forbidden/);
    expect(() => parsePath('a..b')).toThrow();
    expect(() => parsePath('a; drop table')).toThrow();
  });
});

describe('templates', () => {
  const ctx = { input: { q: 'hello', n: 3 }, steps: { search: { output: { results: [{ url: 'https://x.com' }] } } } };

  it('keeps raw values for whole-string references and stringifies embedded ones', () => {
    expect(resolveTemplates({ count: '{{input.n}}', text: 'Q: {{input.q}} / {{ steps.search.output.results[0].url }}' }, ctx)).toEqual({
      count: 3,
      text: 'Q: hello / https://x.com',
    });
    expect(resolveTemplates('{{steps.search.output.results}}', ctx)).toEqual([{ url: 'https://x.com' }]);
  });

  it('fails clearly on unresolved references', () => {
    expect(() => resolveTemplates('{{input.nope}}', ctx)).toThrow(TemplateError);
    expect(() => resolveTemplates('{{steps.other.output}}', ctx)).toThrow(/no output/);
    expect(() => resolveTemplates('{{process.env.SECRET}}', ctx)).toThrow(/Invalid reference/);
  });

  it('extracts references for static validation', () => {
    expect(extractRefs({ a: ['{{input.q}}', 'x {{steps.search.output.results[0].url}}'] })).toEqual([
      { root: 'input', path: 'q' },
      { root: 'steps', stepId: 'search', path: 'results[0].url' },
    ]);
  });
});
