/**
 * @file Unit tests for deep content search query parsing and snippet building
 * (parseContentTerms / buildContentSnippet in src/deepSearch.js).
 */

jest.mock('../logger');

const { parseContentTerms, buildContentSnippet } = require('../deepSearch');

describe('parseContentTerms()', () => {
  it('splits an unquoted query into lowercase keywords', () => {
    expect(parseContentTerms('Valve Actuator')).toEqual({
      phrases: [],
      keywords: ['valve', 'actuator'],
      terms: ['valve', 'actuator']
    });
  });

  it('treats quoted strings as contiguous phrases', () => {
    const r = parseContentTerms('"pressure relief valve"');
    expect(r.phrases).toEqual(['pressure relief valve']);
    expect(r.keywords).toEqual([]);
    expect(r.terms).toEqual(['pressure relief valve']);
  });

  it('handles mixed quoted and unquoted parts', () => {
    const r = parseContentTerms('"alpha beta" gamma "delta e" zeta');
    expect(r.phrases).toEqual(['alpha beta', 'delta e']);
    expect(r.keywords).toEqual(['gamma', 'zeta']);
  });

  it('treats an unbalanced quote as a literal keyword', () => {
    const r = parseContentTerms('foo "bar');
    expect(r.phrases).toEqual([]);
    expect(r.keywords).toEqual(['foo', 'bar']);
  });

  it('ignores empty quotes and extra whitespace', () => {
    const r = parseContentTerms('  ""   solo   ');
    expect(r.phrases).toEqual([]);
    expect(r.keywords).toEqual(['solo']);
  });
});

describe('buildContentSnippet()', () => {
  const text = 'The quick brown fox jumps over the lazy dog while the maintenance ' +
    'crew inspects the pressure relief valve on the north compressor unit every morning.';

  it('returns a snippet around the first term hit with ellipses', () => {
    const snip = buildContentSnippet(text, ['pressure relief valve'], 20);
    expect(snip).toContain('pressure relief valve');
    expect(snip.startsWith('…')).toBe(true);
    expect(snip.endsWith('…')).toBe(true);
  });

  it('omits leading ellipsis when the hit is at the start', () => {
    const snip = buildContentSnippet(text, ['the quick brown']);
    expect(snip.startsWith('…')).toBe(false);
    expect(snip).toContain('The quick brown');
  });

  it('uses the earliest hit among multiple terms', () => {
    const snip = buildContentSnippet(text, ['compressor', 'fox']);
    expect(snip).toContain('fox');
  });

  it('returns empty string when no term is present', () => {
    expect(buildContentSnippet(text, ['nonexistent'])).toBe('');
  });

  it('collapses internal whitespace', () => {
    const messy = 'alpha\n\n\tbeta   gamma delta';
    const snip = buildContentSnippet(messy, ['beta']);
    expect(snip).toContain('alpha beta gamma delta');
  });
});
