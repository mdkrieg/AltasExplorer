/**
 * Context menu generation tests.
 *
 * These exercise the REAL `generateW2UIContextMenu` from
 * public/js/modules/contexts.js. The previous version of this file carried a
 * hand-written copy of the function and asserted against that copy, so it kept
 * passing while the real implementation drifted well past it (submenus instead
 * of a flat panel list, a `{items, pendingDefaultApp, pendingViewMode}` return
 * shape, '--' separators, group-based arrangement). Test the shipped code.
 *
 * This is a `.mjs` test rather than `.test.js` on purpose: contexts.js imports
 * panels/sidebar/terminal/renderer/w2ui, which all reach for a DOM at import
 * time (`ReferenceError: Node is not defined` under the node test environment).
 * Replacing those imports needs `jest.unstable_mockModule`, which only sees
 * imports resolved through Jest's ESM registry — and Jest only uses that registry
 * when the test file itself is ESM. Run under `npm test` (which supplies
 * `--experimental-vm-modules`); bare `jest` cannot load this file.
 */

import { jest } from '@jest/globals';

const MODULE = '../../public/js/modules/contexts.js';

// Namespace-imported dependencies (`import * as panels from ...`) don't need every
// key present — only the members contexts.js actually touches during menu
// generation. Anything reached solely from click handlers is deliberately absent.
jest.unstable_mockModule('../../public/js/modules/panels.js', () => ({
	visiblePanels: 1,
	matchFileType: () => null,
}));
jest.unstable_mockModule('../../public/js/modules/sidebar.js', () => ({}));
jest.unstable_mockModule('../../public/js/modules/terminal.js', () => ({
	getTerminalPanelIds: () => [],
}));
jest.unstable_mockModule('../../public/js/modules/clipboard.js', () => ({
	clipboardState: { type: null, items: [] },
}));
jest.unstable_mockModule('../../public/js/modules/mirrorsUi.js', () => ({}));

// Named imports, unlike the namespace ones above, are checked at link time — every
// binding contexts.js names has to exist here or the module graph fails to link.
jest.unstable_mockModule('../../public/js/modules/vendor/w2ui.es6.min.js', () => ({
	w2utils: {},
	w2confirm: () => ({ yes: () => {} }),
}));

const allCategories = {
	Default: { name: 'Default' },
	Project: { name: 'Project' },
	Test: { name: 'Test' },
};

jest.unstable_mockModule('../../public/js/renderer.js', () => ({
	panelState: {},
	selectedItemState: {},
	activePanelId: 1,
	openNotesModal: () => {},
	openTodoModal: () => {},
	getAllCategories: () => allCategories,
	getAllTags: () => [],
	showFileView: () => {},
	showHexView: () => {},
	openImageViewerModal: () => {},
	openFileViewerModal: () => {},
}));

let generateW2UIContextMenu;

beforeAll(async () => {
	// No bgColor on the mock categories and no tags, so the icon-generation IPC is
	// never reached; getCustomActions is, and must resolve.
	global.window = {
		electronAPI: {
			getCustomActions: async () => [],
			generateFolderIcon: async () => null,
			generateTagIcon: async () => null,
			checkFileBinary: async () => ({ isBinary: false }),
			getDefaultApp: async () => null,
		},
	};
	jest.spyOn(console, 'log').mockImplementation(() => {});

	({ generateW2UIContextMenu } = await import(MODULE));
});

afterAll(() => {
	delete global.window;
	jest.restoreAllMocks();
});

const dir = (name = 'dir1') => ({ path: `C:\\test\\${name}`, isFolder: true, filename: name });

const byId = (items, id) => items.find(item => item.id === id);

describe('generateW2UIContextMenu', () => {
	describe('return shape', () => {
		test('resolves to items plus the two deferred-label promises', async () => {
			const result = await generateW2UIContextMenu([dir()], 1);

			expect(Array.isArray(result.items)).toBe(true);
			expect(result.items.length).toBeGreaterThan(0);
			expect(result).toHaveProperty('pendingDefaultApp');
			expect(result).toHaveProperty('pendingViewMode');
		});

		test('every row carries an id and text', async () => {
			const { items } = await generateW2UIContextMenu([dir()], 1);

			items.forEach(item => {
				expect(item).toHaveProperty('id');
				expect(item).toHaveProperty('text');
			});
		});

		test('separators use the widget\'s "--" marker', async () => {
			const { items } = await generateW2UIContextMenu([dir()], 1);

			const separators = items.filter(item => item.text === '--');
			expect(separators.length).toBeGreaterThan(0);
			separators.forEach(sep => expect(sep.id).toMatch(/^sep/));
		});
	});

	describe('"Open In" submenu', () => {
		test('panels hang off a submenu rather than the top level', async () => {
			const { items } = await generateW2UIContextMenu([dir()], 1);

			const openIn = byId(items, 'open-in');
			expect(openIn.text).toBe('Open In');
			expect(openIn.clickable).toBe(true);
			expect(items.some(item => item.id === 'open-in-1')).toBe(false);
			expect(openIn.items.map(sub => sub.text)).toEqual(['Panel 1', 'Panel 2']);
		});

		test('offers one more panel than is visible', async () => {
			for (const visible of [1, 2, 3]) {
				const { items } = await generateW2UIContextMenu([dir()], visible);
				const openIn = byId(items, 'open-in');

				expect(openIn.items).toHaveLength(visible + 1);
				openIn.items.forEach((sub, i) => {
					expect(sub.id).toBe(`open-in-${i + 1}`);
					expect(sub.text).toBe(`Panel ${i + 1}`);
				});
			}
		});

		test('caps at 4 panels', async () => {
			const { items } = await generateW2UIContextMenu([dir()], 4);

			const panelTexts = byId(items, 'open-in').items.map(sub => sub.text);
			expect(panelTexts).toEqual(['Panel 1', 'Panel 2', 'Panel 3', 'Panel 4']);
			expect(panelTexts).not.toContain('Panel 5');
		});
	});

	describe('"Set Category" submenu', () => {
		test('lists every category, one submenu row each', async () => {
			const { items } = await generateW2UIContextMenu([dir()], 1);

			const setCategory = byId(items, 'set-category-label');
			expect(setCategory.text).toBe('Set Category');

			const ids = setCategory.items.map(sub => sub.id);
			expect(ids).toEqual(['set-category-Default', 'set-category-Project', 'set-category-Test']);
			expect(new Set(ids).size).toBe(ids.length);
			expect(setCategory.items.map(sub => sub.text))
				.toEqual(['Default', 'Project', 'Test']);
		});

		test('multi-select labels the group "(all)"', async () => {
			const { items } = await generateW2UIContextMenu([dir('dir1'), dir('dir2')], 1);

			expect(byId(items, 'set-category-label').text).toBe('Set Category (all)');
		});
	});

	describe('multi-select', () => {
		test('drops the single-selection rows and counts the extras on Properties', async () => {
			const records = [dir('dir1'), dir('dir2'), dir('dir3')];
			const { items } = await generateW2UIContextMenu(records, 2);

			expect(byId(items, 'view-properties').text).toBe('Properties (+2)');
			expect(byId(items, 'open-in')).toBeUndefined();
			expect(byId(items, 'view-notes')).toBeUndefined();
		});

		test('pluralizes the favorites row by directory count', async () => {
			const single = await generateW2UIContextMenu([dir()], 1);
			expect(byId(single.items, 'add-to-favorites').text).toBe('Add to Favorites');

			const multi = await generateW2UIContextMenu([dir('a'), dir('b')], 1);
			expect(byId(multi.items, 'add-to-favorites').text).toBe('Add 2 folders to Favorites');
		});
	});

	describe('disabled rows', () => {
		// The widget only started honoring `disabled` at the context-menu unification;
		// before that these rows rendered fully clickable.
		test('Paste is disabled while the clipboard is empty', async () => {
			const { items } = await generateW2UIContextMenu([dir()], 1);

			expect(byId(items, 'clipboard-paste').disabled).toBe(true);
		});

		test('Remove Tag is a disabled row when the item has no tags', async () => {
			const { items } = await generateW2UIContextMenu([dir()], 1);

			expect(byId(items, 'remove-tag-label')).toBeUndefined();
			expect(byId(items, 'remove-tag-disabled').disabled).toBe(true);
		});
	});
});
