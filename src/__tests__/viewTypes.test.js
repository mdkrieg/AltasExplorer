/**
 * View type registry unit tests.
 *
 * Loaded via dynamic import because the renderer modules are ES modules; the npm
 * test scripts run Jest under --experimental-vm-modules so this resolves natively.
 */

const path = require('path');

const MODULE_URL = 'file:///' +
	path.join(__dirname, '..', '..', 'public', 'js', 'modules', 'viewTypes.js')
		.replace(/\\/g, '/');

// Jest rewrites a literal `import()` into its own CommonJS loader, which chokes
// on `export` because package.json has no "type": "module". Building the import
// through Function keeps it opaque to that rewrite, so Node loads the file as the
// real ES module it is.
const esmImport = new Function('url', 'return import(url);');

let viewTypes;
beforeAll(async () => {
	viewTypes = await esmImport(MODULE_URL);
});

describe('normalizeDisplayMode', () => {
	test('maps the legacy "details" value onto "list"', () => {
		expect(viewTypes.normalizeDisplayMode('details')).toBe('list');
	});

	test('passes through known view types', () => {
		expect(viewTypes.normalizeDisplayMode('list')).toBe('list');
		expect(viewTypes.normalizeDisplayMode('gallery')).toBe('gallery');
		expect(viewTypes.normalizeDisplayMode('board')).toBe('board');
	});

	test('falls back to the default for anything unrecognised', () => {
		expect(viewTypes.normalizeDisplayMode(null)).toBe('list');
		expect(viewTypes.normalizeDisplayMode(undefined)).toBe('list');
		expect(viewTypes.normalizeDisplayMode('')).toBe('list');
		expect(viewTypes.normalizeDisplayMode('nonsense')).toBe('list');
		expect(viewTypes.normalizeDisplayMode(42)).toBe('list');
	});
});

describe('registry shape', () => {
	test('the default view type is registered', () => {
		expect(viewTypes.isValidViewType(viewTypes.DEFAULT_VIEW_TYPE)).toBe(true);
	});

	test('every descriptor carries the fields the render dispatch relies on', () => {
		for (const vt of viewTypes.listViewTypes()) {
			expect(typeof vt.id).toBe('string');
			expect(typeof vt.label).toBe('string');
			expect(typeof vt.containerSelector).toBe('string');
			expect(typeof vt.toolbarMode).toBe('string');
			expect(['display', 'class']).toContain(vt.activation);
			expect(typeof vt.supportsDepth).toBe('boolean');
			expect(typeof vt.supportsVirtualViews).toBe('boolean');
		}
	});

	test('board opts out of depth and virtual views', () => {
		const board = viewTypes.getViewType('board');
		expect(board.supportsDepth).toBe(false);
		expect(board.supportsVirtualViews).toBe(false);
	});

	test('getViewType returns nothing for an unknown id', () => {
		expect(viewTypes.getViewType('nope')).toBeFalsy();
		expect(viewTypes.isValidViewType('nope')).toBe(false);
	});

	test('container selectors are unique so activation cannot cross-fire', () => {
		const selectors = viewTypes.allContainerSelectors();
		expect(new Set(selectors).size).toBe(selectors.length);
	});
});
