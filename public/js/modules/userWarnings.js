/**
 * User Warning system.
 *
 * Writes warnings to the console, and (via warnUserToast) also surfaces an
 * unobtrusive, dismissible toast in the UI — no alert()/modal-per-warning, per
 * design-principles.md ("modals for confirmations, never for error popups").
 *
 * Usage:
 *   import { warnUser, warnUserToast } from './userWarnings.js';
 *   warnUser('REMINDER keyword found on same line as TODO:', { line: 5, content: '...' });
 *   warnUserToast('Context menu: removed unrecognized item(s)', [{ id: 'foo', foundIn: 'Open' }]);
 */

/**
 * Issue a user-visible warning.
 *
 * @param {string} message  Human-readable description of the problem.
 * @param {object} [context] Optional structured details (line numbers, file path, etc.)
 */
export function warnUser(message, context = {}) {
	console.warn('[User Warning]', message, context);
}

const INLINE_ITEM_COUNT = 3;

let _toastEl = null;
let _toastHideTimer = null;

/**
 * Show an unobtrusive, auto-dismissing toast naming the first few items of a
 * warning inline, with an "(and N more)" link opening a modal listing all of
 * them when there are more than fit inline.
 *
 * @param {string} message Short summary shown in the toast.
 * @param {Array<{id: string, foundIn?: string}>} [items] Items the warning is about.
 */
export function warnUserToast(message, items = []) {
	console.warn('[User Warning]', message, items);
	_showToast(message, items);
}

function _showToast(message, items) {
	_toastEl?.remove();
	clearTimeout(_toastHideTimer);

	const shown = items.slice(0, INLINE_ITEM_COUNT).map(item => `"${item.id}"`).join(', ');
	const remaining = items.length - INLINE_ITEM_COUNT;

	const toast = document.createElement('div');
	toast.className = 'user-warning-toast';

	const text = document.createElement('span');
	text.className = 'user-warning-toast-text';
	text.textContent = items.length ? `${message}: ${shown}` : message;
	toast.appendChild(text);

	if (remaining > 0) {
		const link = document.createElement('a');
		link.href = '#';
		link.className = 'user-warning-toast-link';
		link.textContent = `(and ${remaining} more)`;
		link.addEventListener('click', (event) => {
			event.preventDefault();
			_showDetailsModal(message, items);
		});
		toast.appendChild(link);
	}

	const closeBtn = document.createElement('button');
	closeBtn.className = 'user-warning-toast-close';
	closeBtn.textContent = '\u00d7';
	closeBtn.title = 'Dismiss';
	closeBtn.addEventListener('click', _hideToast);
	toast.appendChild(closeBtn);

	document.body.appendChild(toast);
	_toastEl = toast;
	requestAnimationFrame(() => toast.classList.add('visible'));

	_toastHideTimer = setTimeout(_hideToast, 10000);
}

function _hideToast() {
	clearTimeout(_toastHideTimer);
	if (!_toastEl) return;
	const el = _toastEl;
	_toastEl = null;
	el.classList.remove('visible');
	setTimeout(() => el.remove(), 250);
}

function _showDetailsModal(message, items) {
	document.getElementById('user-warning-details-modal')?.remove();

	const overlay = document.createElement('div');
	overlay.id = 'user-warning-details-modal';
	overlay.className = 'user-warning-modal-overlay';
	overlay.addEventListener('click', (event) => {
		if (event.target === overlay) overlay.remove();
	});

	const box = document.createElement('div');
	box.className = 'user-warning-modal-box';

	const title = document.createElement('div');
	title.className = 'user-warning-modal-title';
	title.textContent = message;
	box.appendChild(title);

	const list = document.createElement('div');
	list.className = 'user-warning-modal-list';
	for (const item of items) {
		const row = document.createElement('div');
		row.className = 'user-warning-modal-row';
		row.textContent = item.foundIn ? `"${item.id}" — found in ${item.foundIn}` : `"${item.id}"`;
		list.appendChild(row);
	}
	box.appendChild(list);

	const closeBtn = document.createElement('button');
	closeBtn.className = 'user-warning-modal-close-btn';
	closeBtn.textContent = 'Close';
	closeBtn.addEventListener('click', () => overlay.remove());
	box.appendChild(closeBtn);

	overlay.appendChild(box);
	document.body.appendChild(overlay);
}

