/**
 * Board geometry — pure functions only.
 *
 * Split out of board.js so it can be unit-tested directly. board.js imports the
 * live `panelState` binding from renderer.js, which drags the entire renderer
 * (and therefore the DOM and Electron preload) into any test that touches it.
 * Keeping the maths in a leaf module with no imports avoids that entirely.
 *
 * Nothing in this file may reference the DOM, IPC, or module state.
 */

/**
 * Snap unit in pixels.
 *
 * Deliberately a constant and NOT derived from font metrics. Deriving it would
 * mean a font-size change silently re-flows the geometry of every saved board and
 * misaligns every widget — a catastrophic failure mode used to fix a cosmetic one
 * (slight text clipping in a one-unit level box).
 * See agent-docs/DECISIONS.md#board-grid-size.
 */
export const DEFAULT_GRID_SIZE = 16;

/** Dropped state is icon-only; 5 units square fits a 48px icon plus its label. */
export const DEFAULT_ITEM_W = 5;
export const DEFAULT_ITEM_H = 5;

/**
 * Snap a pixel offset to the nearest whole grid unit.
 * @param {number} px
 * @param {number} gridSize
 * @returns {number} grid units
 */
export function snapToGrid(px, gridSize = DEFAULT_GRID_SIZE) {
	return Math.round(px / gridSize);
}

/**
 * Advance `rect` along one axis until it touches an obstruction, and stop there.
 *
 * Clamping — not rejecting and not pushing. Rejecting would discard the user's
 * partial drag and read as a dead input; pushing cascades, and groups move as
 * rigid bodies so a single push can displace an arbitrarily large cluster the user
 * never touched. See agent-docs/DECISIONS.md#board-collision.
 *
 * @param {{x:number,y:number,w:number,h:number}} rect  current position
 * @param {number} delta  requested movement in grid units (signed)
 * @param {Array<{x:number,y:number,w:number,h:number}>} others  obstructions
 * @param {'x'|'y'} axis
 * @returns {number} the furthest legal coordinate on `axis`
 */
export function sweepAxis(rect, delta, others, axis) {
	if (!delta) return rect[axis];
	const isX = axis === 'x';
	const size = isX ? rect.w : rect.h;
	const cross = isX ? 'y' : 'x';
	const crossSize = isX ? 'h' : 'w';

	let target = rect[axis] + delta;
	for (const o of others) {
		// An obstruction that does not overlap on the perpendicular axis cannot
		// block this movement — this is what lets an item slide along an edge.
		const noCrossOverlap =
			(rect[cross] + rect[crossSize] <= o[cross]) ||
			(o[cross] + o[crossSize] <= rect[cross]);
		if (noCrossOverlap) continue;

		const oPos = o[axis];
		const oSize = isX ? o.w : o.h;
		if (delta > 0) {
			// Only obstructions already ahead of us can stop forward movement.
			if (rect[axis] + size <= oPos) target = Math.min(target, oPos - size);
		} else {
			if (rect[axis] >= oPos + oSize) target = Math.max(target, oPos + oSize);
		}
	}
	return target;
}

/**
 * Resolve a requested move to the furthest legal position.
 *
 * Axes are swept independently and in order, so a diagonal drag into a corner
 * still slides along whichever axis remains free instead of stopping dead.
 *
 * @param {{x:number,y:number,w:number,h:number}} rect
 * @param {number} targetX  desired x in grid units
 * @param {number} targetY  desired y in grid units
 * @param {Array<{x:number,y:number,w:number,h:number}>} others
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function clampMove(rect, targetX, targetY, others) {
	const moved = { ...rect };
	moved.x = Math.max(0, sweepAxis(moved, targetX - moved.x, others, 'x'));
	// Sweeps 'y' against the already-resolved x, so the cross-axis overlap test
	// reflects where the item actually ended up rather than where it started.
	moved.y = Math.max(0, sweepAxis(moved, targetY - moved.y, others, 'y'));
	return moved;
}

/**
 * True when two grid rects overlap. Edge-touching is not overlap.
 * @returns {boolean}
 */
export function rectsOverlap(a, b) {
	return a.x < b.x + b.w && b.x < a.x + a.w &&
	       a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Pair stored coordinates with the files actually present.
 *
 * Filename is tried first because it is the common case and free. Inode is the
 * fallback so a file renamed outside Atlas keeps its position instead of silently
 * losing it — the same rename-recovery shape the mirror feature's successor watch
 * uses.
 *
 * Coordinates matching nothing are NOT discarded. They are the user's arrangement
 * for a file that may simply be on an unmounted drive, and deleting them on sight
 * would destroy intent to tidy up bookkeeping. They are returned separately for
 * the reconciliation flow to offer as merge candidates.
 *
 * @param {object[]} storedItems  rows from dir_boards
 * @param {object[]} records      records for files present now
 * @returns {{placed:Array<{record:object,item:object}>, unplaced:object[], orphanedItems:object[]}}
 */
export function reconcileBoardItems(storedItems, records) {
	const byFilename = new Map();
	const byInode = new Map();
	for (const r of records) {
		byFilename.set(r.filenameRaw, r);
		if (r.inode != null) byInode.set(String(r.inode), r);
	}

	const placed = [];
	const orphanedItems = [];
	const claimed = new Set();

	for (const item of storedItems) {
		let record = byFilename.get(item.filename);
		if (record && claimed.has(record.recid)) record = null;
		if (!record && item.inode != null) {
			const byNode = byInode.get(String(item.inode));
			if (byNode && !claimed.has(byNode.recid)) record = byNode;
		}
		if (record) {
			claimed.add(record.recid);
			placed.push({ record, item });
		} else {
			orphanedItems.push(item);
		}
	}

	const unplaced = records.filter(r => !claimed.has(r.recid));
	return { placed, unplaced, orphanedItems };
}
