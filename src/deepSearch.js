/**
 * Deep Search Engine
 *
 * Asynchronous BFS filesystem search with fuzzy scoring.
 * Called from the Electron main process via `startDeepSearch`.
 *
 * NOTE: `scoreCandidate` and `damerauLevenshtein` are inlined here because
 * the originals live in public/js/modules/path-autocomplete.js — a browser
 * ES module that cannot be `require()`-d from Node.
 */

'use strict';

const path    = require('path');
const fsSync  = require('fs');
const filesystem  = require('./filesystem');
const notesParser = require('./notesParser');
const logger      = require('./logger');
const db          = require('./db');

// ─── Inlined scoring helpers (mirrors path-autocomplete.js) ───────────────────

/**
 * Damerau-Levenshtein distance (optimal string alignment variant).
 * Handles substitution, insertion, deletion, and adjacent transposition.
 */
function damerauLevenshtein(a, b) {
	const la = a.length;
	const lb = b.length;
	if (la === 0) return lb;
	if (lb === 0) return la;

	const d = [];
	for (let i = 0; i <= la; i++) {
		d[i] = new Array(lb + 1);
		d[i][0] = i;
	}
	for (let j = 0; j <= lb; j++) d[0][j] = j;

	for (let i = 1; i <= la; i++) {
		for (let j = 1; j <= lb; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			d[i][j] = Math.min(
				d[i - 1][j] + 1,
				d[i][j - 1] + 1,
				d[i - 1][j - 1] + cost
			);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
			}
		}
	}
	return d[la][lb];
}

/**
 * Score a candidate name against the typed fragment.
 * Returns 0 (prefix), 1 (fuzzy DL≤1), 2 (contains), or null (no match).
 */
function scoreCandidate(fragment, name) {
	const f = fragment.toLowerCase();
	const n = name.toLowerCase();
	if (f === '') return 0;
	if (n.startsWith(f)) return 0;
	if (n.includes(f)) return 2;
	if (f.length >= 3) {
		const prefix = n.slice(0, f.length);
		if (damerauLevenshtein(f, prefix) <= 1) return 1;
	}
	return null;
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Score a filename against the query string.
 * Returns an integer 0–100, or null (exclude from results).
 *
 * Score tiers:
 *   100 – exact case-insensitive match
 *    90 – prefix match (filename starts with query)
 *    80 – contains (filename contains query as substring)
 *    60 – fuzzy full-name prefix (DL distance ≤ 1)
 *    50 – word-break exact/contains (query matches any word within filename)
 *    40 – word-break fuzzy (DL ≤ 1 against any word)
 *  null – no match
 */
function scoreFilename(query, filename) {
	const full = scoreCandidate(query, filename);
	if (filename.toLowerCase() === query.toLowerCase()) return 100;
	if (full === 0) return 90;
	if (full === 2) return 80;
	if (full === 1) return 60;

	// Word-break fallback — split on spaces, hyphens, underscores, dots
	const words = filename.split(/[\s\-_.]+/).filter(w => w.length > 0);
	let bestWordScore = null;
	for (const word of words) {
		const s = scoreCandidate(query, word);
		if (s === 0 || s === 2) { bestWordScore = 50; break; }  // exact word hit
		if (s === 1 && bestWordScore === null) bestWordScore = 40;  // fuzzy word hit
	}
	return bestWordScore; // null when no match
}

// ─── Notes helpers ────────────────────────────────────────────────────────────

/**
 * Read and parse a directory's notes.txt, returning the keyed sections map.
 * Returns null on error or if the file does not exist.
 * Format: `@<filename>` headers produced by notesParser.parseNotesFileSections.
 */
function readNotesSections(dirPath) {
	try {
		const notesPath = path.join(dirPath, 'notes.txt');
		if (!fsSync.existsSync(notesPath)) return null;
		const content = fsSync.readFileSync(notesPath, 'utf-8');
		return notesParser.parseNotesFileSections(content);
	} catch (err) {
		logger.warn(`[deepSearch] Could not read notes.txt in ${dirPath}: ${err.message}`);
		return null;
	}
}

/**
 * Fetch all DB-enrichment data for a directory in one pass.
 * Returns:
 *   dirId        – integer DB id, or null if directory not yet scanned
 *   fileRows     – map of filename → { inode, tags, attributes, checksumStatus, checksumValue, dateCreated }
 *   dirInitials  – resolved initials for the directory itself (for folder icon), or null
 */
function getEnrichmentForDir(dirPath) {
	if (!db.db) return { dirId: null, fileRows: {}, dirInitials: null };
	try {
		const dirRow = db.db.prepare('SELECT id, initials FROM dirs WHERE dirname = ?').get(dirPath);
		if (!dirRow) return { dirId: null, fileRows: {}, dirInitials: null };

		const rows = db.db.prepare(
			`SELECT inode, filename, tags, attributes, checksumStatus, checksumValue, dateCreated
			 FROM files WHERE dir_id = ?`
		).all(dirRow.id);

		const fileRows = {};
		for (const row of rows) {
			fileRows[row.filename] = {
				inode:          row.inode,
				tags:           row.tags || null,
				attributes:     row.attributes || null,
				checksumStatus: row.checksumStatus || null,
				checksumValue:  row.checksumValue || null,
				dateCreated:    row.dateCreated || null,
			};
		}

		// Resolve initials for the directory itself (used for folder icon in renderer)
		let dirInitials = null;
		try { dirInitials = db.resolveDirectoryInitials(dirPath).value || null; } catch { /* ignore */ }

		return { dirId: dirRow.id, fileRows, dirInitials };
	} catch {
		return { dirId: null, fileRows: {}, dirInitials: null };
	}
}

// ─── Phase 1 helpers ─────────────────────────────────────────────────────────

/**
 * Parse a tags JSON string (stored in the DB) into an array of tag name strings.
 * Returns [] on null input or parse error.
 */
function parseTags(tagsJson) {
	if (!tagsJson) return [];
	try {
		const parsed = JSON.parse(tagsJson);
		return Array.isArray(parsed) ? parsed.filter(t => typeof t === 'string') : [];
	} catch { return []; }
}

/**
 * Compute a search score for a DB entry, incorporating filename, tag, and attribute matches.
 * Returns an integer 0–100 or null (exclude from results).
 */
function scoreDbEntry(query, filename, tagsJson, attributesJson) {
	const qLower = query.toLowerCase();
	const baseScore = scoreFilename(query, filename);
	const tags = parseTags(tagsJson);
	const tagMatches = tags.some(t => scoreCandidate(query, t) !== null);
	const attrMatches = !!attributesJson && attributesJson.toLowerCase().includes(qLower);

	if (baseScore !== null) {
		let score = baseScore;
		if (tagMatches)  score = Math.min(100, score + 10);
		if (attrMatches) score = Math.min(100, score + 5);
		return score;
	} else if (tagMatches) {
		return attrMatches ? Math.min(100, 35 + 5) : 35;
	} else if (attrMatches) {
		return 30;
	}
	return null;
}

/**
 * Query the DB for all files and directories under rootPath that match query.
 * Searches filename, tags JSON, and attributes JSON.
 * Returns an array of enriched entry objects shaped for buildGridRecords.
 */
function queryDbPhase1(rootPath, query) {
	if (!db.db) return [];

	const results = [];
	const qLower   = query.toLowerCase();
	const likePat  = `%${qLower}%`;
	const rootLike = rootPath + path.sep + '%';

	// ── Files ─────────────────────────────────────────────────────────────────
	try {
		const fileRows = db.db.prepare(`
			SELECT f.inode, f.filename, f.dateModified, f.dateCreated, f.size,
			       f.tags, f.attributes, f.checksumValue, f.checksumStatus,
			       d.id AS dir_id, d.dirname
			FROM files f
			JOIN dirs d ON f.dir_id = d.id
			WHERE f.filename != '.'
			  AND (d.dirname = ? OR d.dirname LIKE ?)
			  AND (
			    LOWER(f.filename) LIKE ?
			    OR (f.tags IS NOT NULL AND LOWER(f.tags) LIKE ?)
			    OR (f.attributes IS NOT NULL AND LOWER(f.attributes) LIKE ?)
			  )
		`).all(rootPath, rootLike, likePat, likePat, likePat);

		for (const row of fileRows) {
			const score = scoreDbEntry(query, row.filename, row.tags, row.attributes);
			if (score === null) continue;

			results.push({
				filename:      row.filename,
				path:          path.join(row.dirname, row.filename),
				relPath:       path.relative(rootPath, row.dirname),
				isDirectory:   false,
				score,
				inode:         row.inode,
				dir_id:        row.dir_id,
				tags:          row.tags   || null,
				attributes:    row.attributes || null,
				checksumStatus: row.checksumStatus || null,
				checksumValue:  row.checksumValue  || null,
				dateCreated:   row.dateCreated   || null,
				dateModified:  row.dateModified  || null,
				size:          row.size || null,
				initials:      null,
				hasNotes:      false,
				todoCounts:    null,
				changeState:   null,
				perms:         null,
			});
		}
	} catch (err) {
		logger.warn(`[deepSearch] Phase 1 files query error: ${err.message}`);
	}

	// ── Directories ───────────────────────────────────────────────────────────
	// Fetch all dirs under rootPath, filter by basename score in JS.
	// Directory tags/attributes are stored with filename='.' in the files table.
	try {
		const dirRows = db.db.prepare(`
			SELECT d.id, d.dirname, d.inode, d.initials,
			       f.tags, f.attributes
			FROM dirs d
			LEFT JOIN files f ON f.dir_id = d.id AND f.filename = '.'
			WHERE (d.dirname = ? OR d.dirname LIKE ?)
			  AND d.parent_id IS NOT NULL
		`).all(rootPath, rootLike);

		for (const row of dirRows) {
			const basename = path.basename(row.dirname);
			const score = scoreDbEntry(query, basename, row.tags, row.attributes);
			if (score === null) continue;

			let initials = row.initials || null;
			try {
				const resolved = db.resolveDirectoryInitials(row.dirname);
				if (resolved && resolved.value) initials = resolved.value;
			} catch { /* ignore */ }

			results.push({
				filename:      basename,
				path:          row.dirname,
				relPath:       path.relative(rootPath, path.dirname(row.dirname)),
				isDirectory:   true,
				score,
				inode:         row.inode || null,
				dir_id:        row.id,
				tags:          row.tags   || null,
				attributes:    row.attributes || null,
				checksumStatus: null,
				checksumValue:  null,
				dateCreated:   null,
				dateModified:  null,
				size:          null,
				initials,
				hasNotes:      false,
				todoCounts:    null,
				changeState:   null,
				perms:         null,
			});
		}
	} catch (err) {
		logger.warn(`[deepSearch] Phase 1 dirs query error: ${err.message}`);
	}

	// ── Notes enrichment ───────────────────────────────────────────────────────
	// hasNotes, todoCounts, and notesMatch come from notes.txt flat files — not
	// stored in SQLite — so they are computed in a post-query pass over results.
	// Reads are cached per directory to avoid redundant I/O.
	const dirNotesCache = {};
	const getNotesForDir = (dirPath) => {
		if (!dirNotesCache[dirPath]) {
			dirNotesCache[dirPath] = readNotesSections(dirPath) || {};
		}
		return dirNotesCache[dirPath];
	};

	for (const result of results) {
		if (result.isDirectory) {
			// Dir notes live in the dir's OWN notes.txt under the __dir__ section.
			const sections    = getNotesForDir(result.path);
			const dirSec      = sections['__dir__'] || '';
			result.hasNotes   = dirSec.trim().length > 0;
			const counts      = notesParser.countTodoItems(dirSec);
			result.todoCounts = counts.total > 0 ? counts : null;
			result.notesMatch = dirSec.toLowerCase().includes(qLower);
		} else {
			// File notes live in the PARENT dir's notes.txt under @filename.
			const sections    = getNotesForDir(path.dirname(result.path));
			const fileSec     = sections[result.filename] || '';
			result.hasNotes   = fileSec.trim().length > 0;
			const counts      = notesParser.countTodoItems(fileSec);
			result.todoCounts = counts.total > 0 ? counts : null;
			result.notesMatch = fileSec.toLowerCase().includes(qLower);
		}
	}

	return results;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start a 2-phase deep search:
 *
 *   Phase 1 — synchronous DB query for files/dirs that match query on
 *              filename, tags, or attributes.  Sends one batch immediately
 *              with phase=1 so the renderer can show results without waiting
 *              for the filesystem walk.
 *
 *   Phase 2 — async BFS filesystem walk.  Emits entries NOT found in Phase 1
 *              (new/unscanned files) as batches with phase=2.  After the walk
 *              completes, any Phase 1 entry whose path was never seen on disk
 *              is reported as an orphan candidate in the final done callback.
 *
 * @param {string}   rootPath       Directory to search recursively.
 * @param {string}   query          Search term (raw, not pre-lowercased).
 * @param {Function} onBatch        Callback `(batch, done, phase, orphans)`.
 * @param {{ cancelled: boolean }} cancellationRef
 */
async function startDeepSearch(rootPath, query, onBatch, cancellationRef) {
	if (!query || !query.trim()) {
		onBatch([], true, 2, []);
		return;
	}

	const q      = query.trim();
	const qLower = q.toLowerCase();

	// ── Phase 1: DB query ────────────────────────────────────────────────────
	const phase1Entries = queryDbPhase1(rootPath, q);
	const phase1Paths   = new Set(phase1Entries.map(e => e.path));
	if (phase1Entries.length > 0) {
		onBatch(phase1Entries, false, 1, null);
	}

	// ── Phase 2: filesystem BFS walk ─────────────────────────────────────────
	// Only emits items NOT already covered by Phase 1.
	// Tracks all paths seen on disk to detect DB entries that have gone missing.
	const visitedPaths  = new Set();
	visitedPaths.add(rootPath); // rootPath itself may appear in Phase 1 results
	const queue         = [rootPath];
	const pendingBatch  = [];
	let lastFlushTime   = Date.now();
	const BATCH_INTERVAL_MS = 200;
	const BATCH_SIZE        = 50;

	while (queue.length > 0) {
		if (cancellationRef.cancelled) break;

		const dirPath = queue.shift();
		let entries;
		try {
			entries = filesystem.readDirectory(dirPath);
		} catch (err) {
			logger.warn(`[deepSearch] Skipping unreadable directory ${dirPath}: ${err.message}`);
			await new Promise(r => setImmediate(r));
			continue;
		}

		const notesSections = readNotesSections(dirPath);
		const enrichment    = getEnrichmentForDir(dirPath);

		for (const entry of entries) {
			if (cancellationRef.cancelled) break;

			// Track every filesystem path so we can compute orphans afterward.
			visitedPaths.add(entry.path);

			// Always enqueue subdirectories for BFS.
			if (entry.isDirectory) queue.push(entry.path);

			// Already returned in Phase 1 — don't duplicate.
			if (phase1Paths.has(entry.path)) continue;

			const fileRow = enrichment.fileRows[entry.filename];
			const tagsJson = entry.isDirectory ? null : (fileRow ? fileRow.tags : null);
			const baseScore = scoreFilename(q, entry.filename);
			const tags = parseTags(tagsJson);
			const tagMatches = tags.some(t => scoreCandidate(q, t) !== null);
			const noteSectionContent = (notesSections && notesSections[entry.filename]) || '';
			const notesMatches = noteSectionContent.toLowerCase().includes(qLower);

			if (baseScore === null && !tagMatches && !notesMatches) continue;

			let score;
			if (baseScore !== null) {
				score = baseScore;
				if (tagMatches)   score = Math.min(100, score + 10);
				if (notesMatches) score = Math.min(100, score + 10);
			} else if (tagMatches) {
				score = 35;
				if (notesMatches) score = Math.min(100, score + 10);
			} else {
				score = 25; // notes-only match
			}

			pendingBatch.push({
				filename:       entry.filename,
				path:           entry.path,
				relPath:        path.relative(rootPath, path.dirname(entry.path)),
				isDirectory:    entry.isDirectory,
				score,
				inode:          (fileRow ? fileRow.inode : null) || entry.inode || null,
				dir_id:         entry.isDirectory ? null : (enrichment.dirId || null),
				tags:           tagsJson,
				attributes:     entry.isDirectory ? null : (fileRow ? fileRow.attributes : null),
				checksumStatus: entry.isDirectory ? null : (fileRow ? fileRow.checksumStatus : null),
				checksumValue:  entry.isDirectory ? null : (fileRow ? fileRow.checksumValue  : null),
				dateCreated:    (fileRow ? fileRow.dateCreated : null) || entry.dateCreated || null,
				dateModified:   entry.dateModified,
				size:           entry.size || null,
				initials:       entry.isDirectory ? (enrichment.dirInitials || null) : null,
				hasNotes:       entry.isDirectory ? false : !!(noteSectionContent),
				todoCounts:     null,  // computed below
				notesMatch:     notesMatches,
				changeState:    null,
				perms:          null,
			});

			// Populate todoCounts (and dir hasNotes/notesMatch) which need their own read.
			const pushed = pendingBatch[pendingBatch.length - 1];
			if (entry.isDirectory) {
				// Dir notes live in the dir's OWN notes.txt under __dir__.
				const dirSections  = readNotesSections(entry.path) || {};
				const dirSec       = dirSections['__dir__'] || '';
				pushed.hasNotes    = dirSec.trim().length > 0;
				const dc           = notesParser.countTodoItems(dirSec);
				pushed.todoCounts  = dc.total > 0 ? dc : null;
				pushed.notesMatch  = dirSec.toLowerCase().includes(qLower);
			} else {
				const fc           = notesParser.countTodoItems(noteSectionContent);
				pushed.todoCounts  = fc.total > 0 ? fc : null;
			}
		}

		const now = Date.now();
		if (pendingBatch.length >= BATCH_SIZE || now - lastFlushTime >= BATCH_INTERVAL_MS) {
			if (pendingBatch.length > 0) {
				onBatch(pendingBatch.splice(0), false, 2, null);
			}
			lastFlushTime = Date.now();
		}

		await new Promise(r => setImmediate(r));
	}

	// Final flush of remaining Phase 2 results.
	if (!cancellationRef.cancelled && pendingBatch.length > 0) {
		onBatch(pendingBatch.splice(0), false, 2, null);
	}

	if (!cancellationRef.cancelled) {
		// Orphans: Phase 1 DB entries whose paths were never seen during the walk.
		const orphanPaths = [];
		for (const p of phase1Paths) {
			if (!visitedPaths.has(p)) orphanPaths.push(p);
		}
		onBatch([], true, 2, orphanPaths);
	}
}

module.exports = { startDeepSearch };
