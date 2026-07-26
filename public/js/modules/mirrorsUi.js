/**
 * Mirror Items UI — sync-state badges, push wiring, and the adoption
 * review/diff modal. Backend counterpart: src/mirrors.js (design record:
 * agent-docs/DECISIONS.md).
 *
 * v1 renders badges in the detail grid only; gallery tiles are deferred
 * until the badge concept proves out (the gallery re-renders wholesale,
 * which needs its own patch path).
 */

import { panelState } from '../renderer.js';
import { w2utils, w2popup } from './vendor/w2ui.es6.min.js';
import { showPanelRefreshBanner, navigateToDirectory } from './panels.js';

// ---------------------------------------------------------------------------
// Badge rendering
// ---------------------------------------------------------------------------

const BADGE_DEFS = {
	'in-sync':      { glyph: '✓', label: 'In sync' },
	'remote-newer': { glyph: '↓', label: 'Remote is newer — Sync Now downloads it' },
	'local-newer':  { glyph: '↑', label: 'Local copy changed' },
	'conflict':     { glyph: '⚠', label: 'Conflict — both sides changed' },
	'tombstone':    { glyph: '✕', label: 'Remote file is gone (local copy kept)' },
	'error':        { glyph: '!', label: 'Mirror error' },
	'syncing':      { glyph: '⟳', label: 'Syncing…' },
	'unknown':      { glyph: '○', label: 'Not evaluated yet' }
};

function esc(s) {
	return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
		.replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function getMirrorBadgeHtml(status, remotePath, extra = '') {
	const def = BADGE_DEFS[status] || BADGE_DEFS.unknown;
	// The pinned path is always in the tooltip: pinning is confidently blind
	// to renamed successors (Rev4 problem), so staleness must at least be
	// legible on hover until the successor watch exists.
	const title = `Mirror: ${def.label}${extra ? ` (${extra})` : ''}\nPinned to ${remotePath}`;
	return `<span class="mirror-badge mirror-badge-${esc(status)}" title="${esc(title)}">${def.glyph}</span>`;
}

const BADGE_RE = /<span class="mirror-badge[^"]*"[^>]*>[^<]*<\/span>/;

function patchRecordBadge(record, mirror) {
	record.mirrorId = mirror.id;
	record.mirrorStatus = mirror.syncStatus ?? mirror.sync_status;
	record.mirrorRemotePath = mirror.remotePath ?? mirror.remote_path;
	record.mirrorDirection = mirror.direction;
	if (typeof record.filename === 'string') {
		const badge = getMirrorBadgeHtml(record.mirrorStatus, record.mirrorRemotePath,
			mirror.errorMessage ?? mirror.error_message ?? '');
		record.filename = record.filename.replace(BADGE_RE, '');
		record.filename += badge;
	}
}

function samePath(a, b) {
	if (!a || !b) return false;
	const norm = p => String(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
	return norm(a) === norm(b);
}

// ---------------------------------------------------------------------------
// Applying mirror info to panels
// ---------------------------------------------------------------------------

/**
 * Patch grid records for a panel with mirror state badges and surface a
 * pending adoption banner. Called after a scan (mirrorInfo from the scan
 * result) and from the mirror-state-updated push.
 */
export function applyMirrorInfo(panelId, dirPath, mirrorInfo) {
	if (!mirrorInfo) return;
	const state = panelState[panelId];
	if (!state || !samePath(state.currentPath, dirPath)) return;

	const mirrors = mirrorInfo.mirrors || [];
	const grid = state.w2uiGrid;
	if (grid && mirrors.length > 0) {
		const byName = new Map(mirrors.map(m => [(m.localName ?? m.local_name), m]));
		let touched = false;
		for (const record of grid.records) {
			const name = record.filenameRaw;
			if (name && byName.has(name)) {
				patchRecordBadge(record, byName.get(name));
				touched = true;
			} else if (record.mirrorId) {
				// Mirror was detached: drop the stale badge.
				record.mirrorId = null;
				record.mirrorStatus = null;
				if (typeof record.filename === 'string') {
					record.filename = record.filename.replace(BADGE_RE, '');
				}
				touched = true;
			}
		}
		if (touched) grid.refresh();
	}

	const pending = mirrorInfo.pendingAdoption;
	if (pending && !pending.resolved_at) {
		const payload = pending.payload || {};
		const n = Array.isArray(payload.entries) ? payload.entries.length : 0;
		const message = pending.source === 'sidecar-deleted'
			? 'Mirror declarations file was deleted off-app'
			: pending.source === 'sidecar-diff'
				? 'Mirror declarations changed off-app'
				: `${n} mirror declaration${n === 1 ? '' : 's'} found`;
		showPanelRefreshBanner(panelId, `${message} — review to adopt`, () => {
			openAdoptionReviewModal(panelId, dirPath);
		});
	}
}

// ---------------------------------------------------------------------------
// Push wiring (module-scoped, subscribed once at import)
// ---------------------------------------------------------------------------

function handleStateUpdated(data) {
	if (!data || !data.dirPath) return;
	for (const id of Object.keys(panelState)) {
		if (samePath(panelState[id]?.currentPath, data.dirPath)) {
			applyMirrorInfo(Number(id), panelState[id].currentPath, { mirrors: data.mirrors });
		}
	}
}

function handleTransferProgress(data) {
	if (!data || !data.dirPath) return;
	for (const id of Object.keys(panelState)) {
		const state = panelState[id];
		if (!samePath(state?.currentPath, data.dirPath) || !state.w2uiGrid) continue;
		const record = state.w2uiGrid.records.find(r => r.filenameRaw === data.localName);
		if (!record) continue;
		if (data.phase === 'copying' || data.phase === 'starting' || data.phase === 'verifying') {
			const pct = data.bytesTotal > 0 ? Math.round((data.bytesDone / data.bytesTotal) * 100) : 0;
			patchRecordBadge(record, {
				id: record.mirrorId, localName: data.localName, syncStatus: 'syncing',
				remotePath: record.mirrorRemotePath || '', errorMessage: `${pct}%`
			});
			state.w2uiGrid.refresh();
		}
		// 'done'/'error' are followed by a mirror-state-updated push with the
		// settled status — no need to guess here.
	}
}

if (window.electronAPI?.onMirrorStateUpdated) {
	window.electronAPI.onMirrorStateUpdated(handleStateUpdated);
	window.electronAPI.onMirrorTransferProgress(handleTransferProgress);
}

// ---------------------------------------------------------------------------
// Actions (context menu / modal call these)
// ---------------------------------------------------------------------------

export async function syncMirrorNow(mirrorId) {
	const res = await window.electronAPI.mirrorSync(mirrorId);
	if (res?.ok) {
		w2utils.notify('Mirror synced', { timeout: 2500 });
	} else {
		w2utils.notify(`Mirror sync failed: ${res?.error || 'unknown error'}`, { error: true, timeout: 5000 });
	}
	return res;
}

export async function detachMirror(mirrorId, deleteLocal = false) {
	const res = await window.electronAPI.mirrorDetach(mirrorId, deleteLocal);
	if (res?.ok) {
		w2utils.notify('Mirror detached', { timeout: 2500 });
	} else {
		w2utils.notify(`Detach failed: ${res?.error || 'unknown error'}`, { error: true, timeout: 5000 });
	}
	return res;
}

// ---------------------------------------------------------------------------
// Adoption review modal
// ---------------------------------------------------------------------------

function entryRowHtml(entry, idx) {
	const direction = entry.direction || entry.guessedDirection || 'remote-mirror';
	const isUpload = direction === 'local-mirror';
	// Upload-direction entries are unchecked by default: adopting one
	// overwrites a REMOTE file, and a declarations file can arrive via
	// OneDrive from a past self who's forgotten writing it.
	const checked = entry.valid && !isUpload ? 'checked' : '';
	const disabled = entry.valid ? '' : 'disabled';
	const note = entry.note ? `<div class="mirror-adopt-note${entry.valid ? '' : ' is-error'}">${esc(entry.note)}</div>` : '';
	const uploadFlag = isUpload ? '<span class="mirror-adopt-upload-flag" title="Adopting uploads the local file over the remote one">uploads to remote</span>' : '';
	return `
		<tr class="mirror-adopt-row${entry.valid ? '' : ' is-invalid'}">
			<td><input type="checkbox" class="mirror-adopt-check" data-idx="${idx}" ${checked} ${disabled}></td>
			<td class="mirror-adopt-remote" title="${esc(entry.remotePath)}">${esc(entry.remotePath)}${note}</td>
			<td class="mirror-adopt-local">${esc(entry.localName)}</td>
			<td>
				<select class="mirror-adopt-direction" data-idx="${idx}" ${disabled}>
					<option value="remote-mirror" ${direction === 'remote-mirror' ? 'selected' : ''}>download (remote is authority)</option>
					<option value="local-mirror" ${direction === 'local-mirror' ? 'selected' : ''}>upload (local is authority)</option>
				</select>
				${uploadFlag}
			</td>
		</tr>`;
}

function diffSectionHtml(diff) {
	if (!diff) return '';
	const item = (e) => `<li>${esc(e.remotePath)} → ${esc(e.localName)}</li>`;
	const parts = [];
	if (diff.removed?.length) {
		parts.push(`<div class="mirror-adopt-diff-block"><b>${diff.removed.length} removed</b> (adopting detaches these mirrors; local copies are kept):<ul>${diff.removed.map(item).join('')}</ul></div>`);
	}
	if (diff.changed?.length) {
		parts.push(`<div class="mirror-adopt-diff-block"><b>${diff.changed.length} changed</b>:<ul>${diff.changed.map(c => `<li>${esc(c.from.remotePath)}: ${esc(c.from.localName)} → ${esc(c.to.localName)}</li>`).join('')}</ul></div>`);
	}
	return parts.join('');
}

export async function openAdoptionReviewModal(panelId, dirPath) {
	let adoption, entries;
	try {
		const res = await window.electronAPI.mirrorAdoptionGet(dirPath);
		adoption = res?.adoption;
		entries = res?.entries || [];
	} catch (err) {
		w2utils.notify(`Could not load declarations: ${err.message}`, { error: true, timeout: 5000 });
		return;
	}
	if (!adoption) {
		w2utils.notify('Nothing pending to review', { timeout: 2500 });
		return;
	}

	const payload = adoption.payload || {};
	const isDeleted = adoption.source === 'sidecar-deleted';
	const rejected = Array.isArray(payload.rejected) ? payload.rejected : [];

	const bodyParts = [];
	if (payload.fileError) {
		bodyParts.push(`<div class="mirror-adopt-note is-error">File error: ${esc(payload.fileError)}</div>`);
	}
	if (isDeleted) {
		bodyParts.push(`<div class="mirror-adopt-diff-block">The sidecar tracking <b>${payload.mirrorCount ?? '?'}</b> mirror(s) in this directory was deleted outside Atlas.<br>
			<b>Release</b> detaches all mirrors here (local copies are kept). <b>Restore</b> rewrites the file from Atlas's last copy.</div>`);
	} else {
		bodyParts.push(diffSectionHtml(payload.diff));
		if (entries.length > 0) {
			bodyParts.push(`
				<table class="mirror-adopt-table">
					<thead><tr><th></th><th>Remote path</th><th>Local name</th><th>Direction</th></tr></thead>
					<tbody>${entries.map((e, i) => entryRowHtml(e, i)).join('')}</tbody>
				</table>`);
		}
		if (rejected.length > 0) {
			bodyParts.push(`<div class="mirror-adopt-diff-block"><b>${rejected.length} entr${rejected.length === 1 ? 'y' : 'ies'} rejected</b>:<ul>${
				rejected.map(r => `<li>${esc(JSON.stringify(r.entry))} — ${esc(r.reason)}</li>`).join('')}</ul></div>`);
		}
	}

	const actions = {};
	if (!isDeleted && entries.some(e => e.valid)) {
		actions['Adopt Selected'] = async () => {
			const chosen = [];
			document.querySelectorAll('#mirror-adopt-body .mirror-adopt-check:checked').forEach(cb => {
				const idx = Number(cb.dataset.idx);
				const sel = document.querySelector(`#mirror-adopt-body .mirror-adopt-direction[data-idx="${idx}"]`);
				chosen.push({ ...entries[idx], direction: sel ? sel.value : entries[idx].guessedDirection });
			});
			w2popup.close();
			const res = await window.electronAPI.mirrorAdoptionResolve(adoption.id, 'adopted', chosen);
			if (res?.ok) {
				const okCount = (res.results || []).filter(r => r.ok).length;
				w2utils.notify(`Adopted ${okCount} mirror${okCount === 1 ? '' : 's'}`, { timeout: 3000 });
				try { await navigateToDirectory(dirPath, panelId, false, false, true); } catch (_) { /* refresh best-effort */ }
			} else {
				w2utils.notify(`Adoption failed: ${res?.error || 'unknown error'}`, { error: true, timeout: 5000 });
			}
		};
	}
	if (isDeleted) {
		actions['Release Mirrors'] = async () => {
			w2popup.close();
			// "Adopting" a deletion = accept the removal of every declaration.
			const res = await window.electronAPI.mirrorAdoptionResolve(adoption.id, 'adopted', []);
			if (res?.ok) w2utils.notify('Mirrors released (local copies kept)', { timeout: 3000 });
			try { await navigateToDirectory(dirPath, panelId, false, false, true); } catch (_) { /* best-effort */ }
		};
	}
	if (adoption.source !== 'sidecar-new') {
		actions['Restore Previous'] = async () => {
			w2popup.close();
			const res = await window.electronAPI.mirrorAdoptionResolve(adoption.id, 'restored');
			if (res?.ok) w2utils.notify('Sidecar restored from last known copy', { timeout: 3000 });
		};
	}
	actions['Ignore'] = async () => {
		w2popup.close();
		await window.electronAPI.mirrorAdoptionResolve(adoption.id, 'rejected');
	};

	w2popup.open({
		title: isDeleted ? 'Mirror Sidecar Deleted' : 'Review Mirror Declarations',
		body: `<div id="mirror-adopt-body" class="mirror-adopt-modal">${bodyParts.join('')}</div>`,
		width: Math.min(Math.round(window.innerWidth * 0.7), 860),
		height: Math.min(Math.round(window.innerHeight * 0.7), 620),
		modal: true,
		showClose: true,
		actions
	});
}
