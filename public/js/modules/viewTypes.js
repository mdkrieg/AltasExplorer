/**
 * View Types Registry
 *
 * A panel can render its directory in more than one shape. Before this module
 * existed, the choice was a single hardcoded `isGallery` branch driven straight
 * off `category.displayMode`, which meant (a) adding a third shape required
 * editing that branch, and (b) the user could not choose a shape per panel —
 * the category decided for them.
 *
 * This registry makes view types data rather than control flow. `panels.js`
 * looks up a descriptor and asks it to render; it no longer knows the set of
 * views that exist.
 *
 * Two things deliberately live here and not in panels.js:
 *   - `normalizeDisplayMode`, because the legacy category value 'details' and
 *     the view id 'list' are the same concept under two names. The category
 *     settings form still writes 'details'; translating at the boundary avoids
 *     a data migration.
 *   - The capability flags. Toolbar and menu code branches on capabilities
 *     (`supportsDepth`, `supportsVirtualViews`) rather than on view ids, so a
 *     new view type does not require touching those call sites.
 */

/**
 * @typedef {Object} ViewTypeDescriptor
 * @property {string}  id                  Stable identifier, persisted in panel state.
 * @property {string}  label               Menu label.
 * @property {string}  containerSelector   Panel-relative selector for this view's container.
 * @property {string}  toolbarMode         Passed to renderPanelToolbar.
 * @property {boolean} supportsDepth       Whether the Depth control applies.
 * @property {boolean} supportsVirtualViews Whether ?orphans / ?trash apply.
 * @property {string}  activation          How the container is shown: 'class' toggles
 *                                         .active, 'display' toggles show/hide.
 */

/** @type {ViewTypeDescriptor[]} */
const VIEW_TYPE_LIST = [
	{
		id: 'list',
		label: 'List View',
		containerSelector: '.panel-grid',
		toolbarMode: 'detail',
		supportsDepth: true,
		supportsVirtualViews: true,
		activation: 'display'
	},
	{
		id: 'gallery',
		label: 'Gallery View',
		containerSelector: '.panel-gallery',
		toolbarMode: 'gallery',
		supportsDepth: false,
		// The virtual-view branch in navigateToDirectory renders exclusively into the
		// w2ui grid, and the old Orphans/Trash buttons were nested inside the same
		// gallery-excluded block as the Depth control — so this combination was never
		// reachable. Declaring it unsupported preserves that and, more importantly,
		// stops the menu from offering a toggle that would silently drop the user out
		// of gallery and into a list.
		supportsVirtualViews: false,
		activation: 'class'
	},
	{
		id: 'board',
		label: 'Board View',
		containerSelector: '.panel-board',
		toolbarMode: 'board',
		// A board is an arrangement of one directory's contents. Recursive results
		// have no coordinates and no stable identity across depth changes, so depth
		// is not merely unsupported — it is meaningless here.
		supportsDepth: false,
		// Orphans/Trash are synthesised listings, not the directory itself. Selecting
		// board while they are active suspends them rather than discarding them; see
		// suspendNavParamsForView in panels.js.
		supportsVirtualViews: false,
		activation: 'class'
	}
];

const VIEW_TYPES = new Map(VIEW_TYPE_LIST.map(v => [v.id, v]));

export const DEFAULT_VIEW_TYPE = 'list';

/**
 * Map a legacy `category.displayMode` value onto a view type id.
 * The category settings form still stores 'details'; see module header.
 * @param {string|null|undefined} displayMode
 * @returns {string} a valid view type id
 */
export function normalizeDisplayMode(displayMode) {
	if (displayMode === 'gallery') return 'gallery';
	if (displayMode === 'board') return 'board';
	// 'details', null, undefined, and any unrecognised legacy value.
	return DEFAULT_VIEW_TYPE;
}

/**
 * @param {string} id
 * @returns {ViewTypeDescriptor|null}
 */
export function getViewType(id) {
	return VIEW_TYPES.get(id) || null;
}

/**
 * @param {string} id
 * @returns {boolean}
 */
export function isValidViewType(id) {
	return VIEW_TYPES.has(id);
}

/**
 * All view types, in menu order.
 * @returns {ViewTypeDescriptor[]}
 */
export function listViewTypes() {
	return VIEW_TYPE_LIST.slice();
}

/**
 * Every registered container selector. Used to hide all views before showing one,
 * so panels.js never has to enumerate them.
 * @returns {string[]}
 */
export function allContainerSelectors() {
	return VIEW_TYPE_LIST.map(v => v.containerSelector);
}
