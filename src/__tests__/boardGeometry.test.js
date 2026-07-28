/**
 * Board geometry unit tests.
 *
 * Imported as a real ES module (the npm test scripts run Jest under
 * --experimental-vm-modules), which is why boardGeometry.js is kept free of any
 * imports — see the header of that file.
 */

const path = require('path');

const MODULE_URL = 'file:///' +
	path.join(__dirname, '..', '..', 'public', 'js', 'modules', 'boardGeometry.js')
		.replace(/\\/g, '/');

// See viewTypes.test.js — Function keeps the dynamic import opaque to Jest's
// CommonJS rewrite so Node loads the file as a real ES module.
const esmImport = new Function('url', 'return import(url);');

let geo;
beforeAll(async () => {
	geo = await esmImport(MODULE_URL);
});

describe('snapToGrid', () => {
	test('rounds to the nearest whole unit', () => {
		expect(geo.snapToGrid(0, 16)).toBe(0);
		expect(geo.snapToGrid(7, 16)).toBe(0);
		expect(geo.snapToGrid(9, 16)).toBe(1);
		expect(geo.snapToGrid(32, 16)).toBe(2);
	});

	test('handles negative offsets', () => {
		expect(geo.snapToGrid(-32, 16)).toBe(-2);
	});

	test('defaults to the standard grid size', () => {
		expect(geo.snapToGrid(16)).toBe(1);
	});
});

describe('rectsOverlap', () => {
	const a = { x: 0, y: 0, w: 5, h: 5 };

	test('detects a genuine overlap', () => {
		expect(geo.rectsOverlap(a, { x: 4, y: 4, w: 5, h: 5 })).toBe(true);
	});

	test('edge-touching is not overlap', () => {
		expect(geo.rectsOverlap(a, { x: 5, y: 0, w: 5, h: 5 })).toBe(false);
		expect(geo.rectsOverlap(a, { x: 0, y: 5, w: 5, h: 5 })).toBe(false);
	});

	test('separated rects do not overlap', () => {
		expect(geo.rectsOverlap(a, { x: 20, y: 20, w: 5, h: 5 })).toBe(false);
	});
});

describe('sweepAxis', () => {
	const rect = { x: 0, y: 0, w: 5, h: 5 };

	test('a zero delta never moves the rect', () => {
		expect(geo.sweepAxis(rect, 0, [{ x: 2, y: 0, w: 5, h: 5 }], 'x')).toBe(0);
	});

	test('moves freely when nothing is in the way', () => {
		expect(geo.sweepAxis(rect, 10, [], 'x')).toBe(10);
	});

	test('stops flush against an obstruction ahead', () => {
		const blocker = { x: 8, y: 0, w: 5, h: 5 };
		expect(geo.sweepAxis(rect, 10, [blocker], 'x')).toBe(3);
	});

	test('stops flush when moving backwards', () => {
		const moving = { x: 10, y: 0, w: 5, h: 5 };
		const blocker = { x: 0, y: 0, w: 5, h: 5 };
		expect(geo.sweepAxis(moving, -10, [blocker], 'x')).toBe(5);
	});

	test('ignores obstructions that do not overlap on the cross axis', () => {
		const blocker = { x: 8, y: 20, w: 5, h: 5 };
		expect(geo.sweepAxis(rect, 10, [blocker], 'x')).toBe(10);
	});

	test('respects the nearest of several obstructions', () => {
		const blockers = [
			{ x: 20, y: 0, w: 5, h: 5 },
			{ x: 8, y: 0, w: 5, h: 5 },
		];
		expect(geo.sweepAxis(rect, 30, blockers, 'x')).toBe(3);
	});
});

describe('clampMove', () => {
	test('a free move lands exactly where requested', () => {
		const out = geo.clampMove({ x: 0, y: 0, w: 5, h: 5 }, 12, 7, []);
		expect(out).toEqual({ x: 12, y: 7, w: 5, h: 5 });
	});

	test('clamps flush instead of snapping back', () => {
		const blocker = { x: 10, y: 0, w: 5, h: 5 };
		const out = geo.clampMove({ x: 0, y: 0, w: 5, h: 5 }, 20, 0, [blocker]);
		expect(out.x).toBe(5);
		expect(geo.rectsOverlap(out, blocker)).toBe(false);
	});

	test('slides along the free axis when one axis is blocked', () => {
		const blocker = { x: 10, y: 0, w: 5, h: 40 };
		const out = geo.clampMove({ x: 0, y: 0, w: 5, h: 5 }, 20, 12, [blocker]);
		expect(out.x).toBe(5);
		expect(out.y).toBe(12);
	});

	test('never goes negative', () => {
		const out = geo.clampMove({ x: 3, y: 3, w: 5, h: 5 }, -20, -20, []);
		expect(out).toMatchObject({ x: 0, y: 0 });
	});

	test('does not displace the obstruction', () => {
		const blocker = { x: 10, y: 0, w: 5, h: 5 };
		geo.clampMove({ x: 0, y: 0, w: 5, h: 5 }, 20, 0, [blocker]);
		expect(blocker).toEqual({ x: 10, y: 0, w: 5, h: 5 });
	});
});

describe('reconcileBoardItems', () => {
	const rec = (name, inode, recid) => ({ filenameRaw: name, inode, recid });

	test('matches by filename', () => {
		const records = [rec('a.txt', 111, 1), rec('b.txt', 222, 2)];
		const stored = [{ filename: 'a.txt', inode: 111, x: 0, y: 0 }];
		const out = geo.reconcileBoardItems(stored, records);
		expect(out.placed).toHaveLength(1);
		expect(out.placed[0].record.filenameRaw).toBe('a.txt');
		expect(out.unplaced.map(r => r.filenameRaw)).toEqual(['b.txt']);
		expect(out.orphanedItems).toHaveLength(0);
	});

	test('falls back to inode after an external rename', () => {
		const records = [rec('renamed.txt', 111, 1)];
		const stored = [{ filename: 'a.txt', inode: 111, x: 4, y: 4 }];
		const out = geo.reconcileBoardItems(stored, records);
		expect(out.placed).toHaveLength(1);
		expect(out.placed[0].record.filenameRaw).toBe('renamed.txt');
		expect(out.orphanedItems).toHaveLength(0);
	});

	test('a record is never claimed twice', () => {
		const records = [rec('a.txt', 111, 1)];
		const stored = [
			{ filename: 'a.txt', inode: 111, x: 0, y: 0 },
			{ filename: 'gone.txt', inode: 111, x: 9, y: 9 },
		];
		const out = geo.reconcileBoardItems(stored, records);
		expect(out.placed).toHaveLength(1);
		expect(out.orphanedItems).toHaveLength(1);
		expect(out.orphanedItems[0].filename).toBe('gone.txt');
	});

	test('orphaned coordinates are retained, never dropped', () => {
		const records = [];
		const stored = [{ filename: 'offline.txt', inode: 999, x: 2, y: 3 }];
		const out = geo.reconcileBoardItems(stored, records);
		expect(out.placed).toHaveLength(0);
		expect(out.orphanedItems).toEqual(stored);
	});

	test('an empty board leaves every record unplaced', () => {
		const records = [rec('a.txt', 111, 1), rec('b.txt', 222, 2)];
		const out = geo.reconcileBoardItems([], records);
		expect(out.unplaced).toHaveLength(2);
		expect(out.placed).toHaveLength(0);
		expect(out.orphanedItems).toHaveLength(0);
	});

	test('records without an inode are still matchable by name', () => {
		const records = [rec('a.txt', null, 1)];
		const stored = [{ filename: 'a.txt', inode: null, x: 1, y: 1 }];
		const out = geo.reconcileBoardItems(stored, records);
		expect(out.placed).toHaveLength(1);
	});
});
