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
 * Fetch a map of filename → string[] tags for a single directory.
 * Returns an empty object when the directory isn't in the DB yet.
 */
function getTagsForDir(dirPath) {
	try {
		if (!db.db) return {};
		const dirRow = db.db.prepare('SELECT id FROM dirs WHERE dirname = ?').get(dirPath);
		if (!dirRow) return {};
		const rows = db.db.prepare(
			'SELECT filename, tags FROM files WHERE dir_id = ? AND tags IS NOT NULL'
		).all(dirRow.id);
		const map = {};
		for (const row of rows) {
			try {
				const parsed = JSON.parse(row.tags);
				if (Array.isArray(parsed) && parsed.length > 0) map[row.filename] = parsed;
			} catch { /* malformed JSON, skip */ }
		}
		return map;
	} catch {
		return {};
	}
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start an async breadth-first deep search.
 *
 * Yields between directory iterations (via `setImmediate`) so the main
 * process event loop stays responsive. Results are batched: `onBatch` is
 * called whenever 50 matches accumulate OR 200 ms have elapsed without a
 * flush, whichever comes first.  When the BFS is complete (or cancelled)
 * `onBatch([], true)` is called once as a sentinel.
 *
 * @param {string}   rootPath       Directory to search recursively.
 * @param {string}   query          Search term (raw, not pre-lowercased).
 * @param {Function} onBatch        Callback `(batch: Array, done: boolean)`.
 * @param {{ cancelled: boolean }} cancellationRef
 *   Shared mutable reference.  Set `.cancelled = true` to abort the search;
 *   the loop checks this flag between directories.
 *
 * Each item in `batch` has the shape:
 *   { filename, path, relPath, isDirectory, score, tags, size, dateModified }
 * where `relPath` is the directory path relative to `rootPath` (empty string
 * for items directly inside rootPath), and `tags` is an array of tag name strings.
 */
async function startDeepSearch(rootPath, query, onBatch, cancellationRef) {
	if (!query || !query.trim()) {
		onBatch([], true);
		return;
	}

	const q = query.trim();
	const qLower = q.toLowerCase();
	const queue = [rootPath];
	const pendingBatch = [];
	let lastFlushTime = Date.now();
	const BATCH_INTERVAL_MS = 200;
	const BATCH_SIZE = 50;

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
		const tagsMap = getTagsForDir(dirPath);

		for (const entry of entries) {
			if (cancellationRef.cancelled) break;

			// Always enqueue subdirectories for BFS even if they don't match.
			if (entry.isDirectory) {
				queue.push(entry.path);
			}

			const entryTags = tagsMap[entry.filename] || [];
			const baseScore = scoreFilename(q, entry.filename);

			// Check whether any tag matches the query.
			let tagMatches = false;
			for (const tag of entryTags) {
				if (scoreCandidate(q, tag) !== null) { tagMatches = true; break; }
			}

			// Check whether the file's notes section contains the query.
			const noteSectionContent = (notesSections && notesSections[entry.filename]) || '';
			const notesMatches = noteSectionContent.toLowerCase().includes(qLower);

			// Skip if nothing matches at all.
			if (baseScore === null && !tagMatches && !notesMatches) continue;

			// Determine final score.
			// Filename match is the primary signal; tags/notes add bonuses or
			// act as a floor when the filename alone doesn't match.
			let score;
			if (baseScore !== null) {
				score = baseScore;
				if (tagMatches)  score = Math.min(100, score + 10);
				if (notesMatches) score = Math.min(100, score + 10);
			} else if (tagMatches) {
				score = 35;
				if (notesMatches) score = Math.min(100, score + 10);
			} else {
				// notes-only match
				score = 25;
			}

			pendingBatch.push({
				filename: entry.filename,
				path: entry.path,
				relPath: path.relative(rootPath, path.dirname(entry.path)),
				isDirectory: entry.isDirectory,
				score,
				tags: entryTags,
				size: entry.size,
				dateModified: entry.dateModified,
			});
		}

		// Flush batch periodically to keep UI responsive.
		const now = Date.now();
		if (pendingBatch.length >= BATCH_SIZE || now - lastFlushTime >= BATCH_INTERVAL_MS) {
			if (pendingBatch.length > 0) {
				onBatch(pendingBatch.splice(0), false);
			}
			lastFlushTime = Date.now();
		}

		// Yield to main-process event loop between directories.
		await new Promise(r => setImmediate(r));
	}

	// Final flush of any remaining accumulated results.
	if (!cancellationRef.cancelled && pendingBatch.length > 0) {
		onBatch(pendingBatch.splice(0), false);
	}

	if (!cancellationRef.cancelled) {
		onBatch([], true);
	}
}

module.exports = { startDeepSearch };
