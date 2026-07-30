/**
 * Unified custom right-click context menu widget.
 *
 * Single implementation shared by every custom (non-w2ui) popup menu in the app: the
 * file-grid menu (contexts.js, flat + tabbed), the Context Menu settings tab's group/item
 * menus (settings.js), the favorites sidebar menu (sidebar.js), and the terminal
 * panel-picker menu (renderer.js). These four call sites used to each carry an independent
 * hand-rolled copy of this same hover/submenu/outside-click logic — which is how a
 * submenu-hover-cancel bug crept into one copy but not the others. See
 * agent-docs/DECISIONS.md#unified-context-menu-widget.
 *
 * Item shape (superset of what every call site was already using — both are accepted so
 * no call site needed a risky rename sweep):
 *   { label|text, id?, iconHtml?, items?: [...] (submenu), onClick?, clickable?, disabled?,
 *     danger?, separator? } — a row is a separator if `separator: true` OR `text === '--'`.
 *
 * opts.defaultOnClick(item) is the trigger-specific fallback invoked for leaf items with no
 * item.onClick of their own — e.g. contexts.js routes these through generateW2UIContextMenu's
 * handleContextMenuClick pipeline; other call sites simply omit it (every one of their items
 * carries its own onClick).
 */

const MENU_ID = 'custom-ctx-menu';
// Long enough to cross the gap from a parent row into its flyout without feeling laggy on close.
const SUBMENU_HIDE_DELAY_MS = 200;

function isSeparator(item) {
	return item.separator === true || item.text === '--';
}

// Appends item rows (separators, icons, labels, submenu-hover flyouts, click routing) into
// `container`. Factored out from buildMenuEl so the tabbed variant can reuse the exact same
// row behavior inside each tab pane rather than inside a fresh top-level `.custom-ctx-menu`.
function _appendMenuRows(container, items, opts) {
	let activeSubEl = null;
	let subHideTimer = null;
	const clearHideTimer = () => clearTimeout(subHideTimer);
	const startHideTimer = () => {
		subHideTimer = setTimeout(() => {
			activeSubEl?.remove();
			activeSubEl = null;
		}, SUBMENU_HIDE_DELAY_MS);
	};

	for (const item of items) {
		if (isSeparator(item)) {
			const sep = document.createElement('div');
			sep.className = 'custom-ctx-separator';
			container.appendChild(sep);
			continue;
		}

		const row = document.createElement('div');
		row.className = 'custom-ctx-item'
			+ (item.danger ? ' custom-ctx-item-danger' : '')
			+ (item.disabled ? ' custom-ctx-item-disabled' : '');
		if (item.id) row.dataset.id = item.id;

		if (item.iconHtml) {
			const iconWrap = document.createElement('span');
			iconWrap.className = 'custom-ctx-icon';
			iconWrap.innerHTML = item.iconHtml;
			row.appendChild(iconWrap);
		}

		const label = document.createElement('span');
		label.className = 'custom-ctx-label';
		label.textContent = item.label ?? item.text ?? '';
		row.appendChild(label);

		const hasSub = !item.disabled && Array.isArray(item.items) && item.items.length > 0;
		if (hasSub) {
			const arrow = document.createElement('span');
			arrow.className = 'custom-ctx-arrow';
			arrow.textContent = '\u203a';
			row.appendChild(arrow);
		}

		container.appendChild(row);

		// Disabled rows (e.g. "Paste" with an empty clipboard, informational "Pinned to <path>")
		// are fully inert — no hover highlight, no submenu, no click — so every listener below
		// is skipped. `disabled: true` was set on several items before this unification but
		// nothing ever actually read it; it was silently non-functional.
		if (item.disabled) continue;

		row.addEventListener('mouseenter', () => {
			clearHideTimer();
			container.querySelectorAll('.custom-ctx-item').forEach(r => r.classList.remove('active'));
			row.classList.add('active');

			if (activeSubEl) {
				activeSubEl.remove();
				activeSubEl = null;
			}
			if (!hasSub) return;

			// Submenus always render flat regardless of the top-level display mode — tabbing an
			// already-scoped flyout (e.g. "Set Category") would be scope creep, not a space saving.
			const sub = buildMenuEl(item.items, opts);
			sub.classList.add('custom-ctx-submenu');
			const rowRect = row.getBoundingClientRect();
			sub.style.left = (rowRect.right + 2) + 'px';
			sub.style.top = rowRect.top + 'px';
			document.body.appendChild(sub);
			activeSubEl = sub;

			requestAnimationFrame(() => {
				const subRect = sub.getBoundingClientRect();
				if (subRect.right > window.innerWidth) sub.style.left = (rowRect.left - subRect.width - 2) + 'px';
				if (subRect.bottom > window.innerHeight) sub.style.top = (rowRect.top - (subRect.bottom - window.innerHeight)) + 'px';
			});

			// Entering the flyout itself must also cancel the pending hide, and leaving it
			// (rather than the parent row) is what actually schedules the close.
			sub.addEventListener('mouseenter', clearHideTimer);
			sub.addEventListener('mouseleave', startHideTimer);
		});

		if (hasSub) row.addEventListener('mouseleave', startHideTimer);

		// A root item can both open a submenu on hover AND fire its own action on click
		// (item.clickable, e.g. "Open In" navigating the current panel while also listing
		// per-panel targets in its flyout).
		if (!hasSub || item.clickable) {
			row.addEventListener('click', (event) => {
				event.stopPropagation();
				hideContextMenu();
				if (typeof item.onClick === 'function') item.onClick();
				else opts.defaultOnClick?.(item);
			});
		}
	}
}

export function buildMenuEl(items, opts = {}) {
	const menu = document.createElement('div');
	menu.className = 'custom-ctx-menu';
	_appendMenuRows(menu, items, opts);
	return menu;
}

// tabDefs: [{ label, items }, ...]. Caller decides whether tabbing is worthwhile (e.g.
// falling back to buildMenuEl for a single populated tab) — this always renders a tab strip.
export function buildTabbedMenuEl(tabDefs, opts = {}) {
	const menu = document.createElement('div');
	menu.className = 'custom-ctx-menu custom-ctx-menu-tabbed';

	const tabbar = document.createElement('div');
	tabbar.className = 'custom-ctx-tabbar';
	const content = document.createElement('div');
	content.className = 'custom-ctx-tab-content';
	menu.appendChild(tabbar);
	menu.appendChild(content);

	const tabs = [];
	const panes = [];
	for (const tabDef of tabDefs) {
		const tab = document.createElement('div');
		tab.className = 'custom-ctx-tab';
		tab.textContent = tabDef.label;

		const pane = document.createElement('div');
		pane.className = 'custom-ctx-tab-pane';
		_appendMenuRows(pane, tabDef.items, opts);

		// Hover (not click) switches tabs, per the space-saving hover UX this feature exists for.
		tab.addEventListener('mouseenter', () => {
			tabs.forEach(t => t.classList.remove('active'));
			panes.forEach(p => p.classList.remove('active'));
			tab.classList.add('active');
			pane.classList.add('active');
		});

		tabbar.appendChild(tab);
		content.appendChild(pane);
		tabs.push(tab);
		panes.push(pane);
	}

	// Measure-then-fix sizing: briefly show every pane (invisibly, off the currently-displayed
	// document flow via .custom-ctx-tab-pane's position:absolute) to find the largest natural
	// width/height, then lock that size onto .custom-ctx-tab-content. Locking to the max across
	// ALL tabs — not just the active one — is what keeps the menu from resizing as the user
	// hovers across tabs; an unlocked resize would let the cursor slip off the tab strip
	// mid-hover (the same class of bug as flaky OS Start-Menu flyouts).
	menu.style.visibility = 'hidden';
	document.body.appendChild(menu);
	panes.forEach(p => p.classList.add('custom-ctx-tab-pane-measuring'));
	let maxWidth = 0, maxHeight = 0;
	panes.forEach(p => {
		const rect = p.getBoundingClientRect();
		maxWidth = Math.max(maxWidth, rect.width);
		maxHeight = Math.max(maxHeight, rect.height);
	});
	panes.forEach(p => p.classList.remove('custom-ctx-tab-pane-measuring'));
	document.body.removeChild(menu);
	menu.style.visibility = '';
	content.style.width = maxWidth + 'px';
	content.style.height = maxHeight + 'px';

	tabs[0].classList.add('active');
	panes[0].classList.add('active');

	return menu;
}

export function hideContextMenu() {
	document.getElementById(MENU_ID)?.remove();
	document.querySelectorAll('.custom-ctx-submenu').forEach(el => el.remove());
}

// Positions `menuEl` at (x, y), flips it inward if it would overflow the viewport, and wires
// up outside-click/Escape dismissal. Returns menuEl (or null for an empty menu, matching every
// call site's existing "don't show a blank popup" guard) so callers can patch it further (e.g.
// contexts.js updates two labels once async default-app/view-mode probes resolve).
export function showMenu(menuEl, x, y) {
	hideContextMenu();
	if (!menuEl.children.length) return null;

	menuEl.id = MENU_ID;
	menuEl.style.left = x + 'px';
	menuEl.style.top = y + 'px';
	document.body.appendChild(menuEl);

	requestAnimationFrame(() => {
		const rect = menuEl.getBoundingClientRect();
		if (rect.right > window.innerWidth) menuEl.style.left = (x - rect.width) + 'px';
		if (rect.bottom > window.innerHeight) menuEl.style.top = (y - rect.height) + 'px';
	});

	const onOutside = (event) => {
		if (!event.target.closest?.(`#${MENU_ID}`) && !event.target.closest?.('.custom-ctx-submenu')) {
			hideContextMenu();
			document.removeEventListener('click', onOutside);
			document.removeEventListener('keydown', onEsc);
		}
	};
	const onEsc = (event) => {
		if (event.key === 'Escape') {
			hideContextMenu();
			document.removeEventListener('click', onOutside);
			document.removeEventListener('keydown', onEsc);
		}
	};
	document.addEventListener('click', onOutside);
	document.addEventListener('keydown', onEsc);

	return menuEl;
}

export function showContextMenu(items, x, y, opts = {}) {
	return showMenu(buildMenuEl(items, opts), x, y);
}

export function showTabbedContextMenu(tabDefs, x, y, opts = {}) {
	return showMenu(buildTabbedMenuEl(tabDefs, opts), x, y);
}
