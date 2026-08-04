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
const contentExtractor = require('./contentExtractor');

// ─── Live content search: session-scoped LRU ─────────────────────────────────
// Promoted ("search contents now") searches over folders whose category has
// NOT opted into permanent caching keep their extracted text here instead of
// SQLite: keyed by path|mtime|size so edits invalidate naturally, bounded,
// and gone on app exit.
const liveContentCache = new Map(); // key → { text: string|null }
const LIVE_CACHE_MAX_ENTRIES = 300;

async function getLiveContentText(entry, sizeCapBytes) {
	const key = `${entry.path}|${entry.dateModified}|${entry.size}`;
	if (liveContentCache.has(key)) {
		const hit = liveContentCache.get(key);
		liveContentCache.delete(key);
		liveContentCache.set(key, hit); // LRU bump
		return hit.text;
	}
	let text = null;
	try {
		const result = await contentExtractor.extractContent(entry.path, { sizeCapBytes });
		text = result.text; // null for skipped/error/unsupported
	} catch (err) {
		logger.warn(`[deepSearch] Live extraction failed for ${entry.path}: ${err.message}`);
	}
	liveContentCache.set(key, { text });
	if (liveContentCache.size > LIVE_CACHE_MAX_ENTRIES) {
		liveContentCache.delete(liveContentCache.keys().next().value);
	}
	return text;
}

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
 * Parse a raw query into content-search terms.
 * Quoted strings ("like this") become contiguous phrases; the remainder is
 * split into keywords. An unbalanced quote is treated as a literal character.
 * All terms are lowercased. A file content-matches iff EVERY term is a
 * case-insensitive substring of its cached text.
 */
function parseContentTerms(query) {
	const phrases = [];
	const rest = query.replace(/"([^"]+)"/g, (_m, p) => {
		const t = p.trim().toLowerCase();
		if (t) phrases.push(t);
		return ' ';
	});
	const keywords = rest.replace(/"/g, ' ').split(/\s+/)
		.map(s => s.trim().toLowerCase()).filter(Boolean);
	return { phrases, keywords, terms: [...phrases, ...keywords] };
}

/**
 * Build a short display snippet around the first term hit: ±radius chars,
 * snapped to word boundaries, whitespace collapsed, ellipsized.
 */
function buildContentSnippet(text, terms, radius = 60) {
	const lower = text.toLowerCase();
	let idx = -1;
	let len = 0;
	for (const t of terms) {
		const i = lower.indexOf(t);
		if (i !== -1 && (idx === -1 || i < idx)) { idx = i; len = t.length; }
	}
	if (idx === -1) return '';
	let start = Math.max(0, idx - radius);
	let end = Math.min(text.length, idx + len + radius);
	if (start > 0) {
		const sp = text.indexOf(' ', start);
		if (sp !== -1 && sp < idx) start = sp + 1;
	}
	if (end < text.length) {
		const sp = text.lastIndexOf(' ', end);
		if (sp > idx + len) end = sp;
	}
	const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
	return (start > 0 ? '…' : '') + snippet + (end < text.length ? '…' : '');
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
	// Quotes drive phrase semantics for content matching; strip them for
	// filename/tag/attribute matching so "foo bar" still matches foo bar.txt.
	const nameQuery = query.replace(/"/g, ' ').trim() || query;
	const qLower   = nameQuery.toLowerCase();
	const likePat  = `%${qLower}%`;
	const rootLike = rootPath + path.sep + '%';

	// ── Content matches (cache-only) ─────────────────────────────────────────
	// SQL instr() on the longest term is a coarse prefilter (SQLite lower() is
	// ASCII-only); every term is then verified in JS with correct case folding.
	const contentHits = new Map();
	try {
		const { terms } = parseContentTerms(query);
		if (terms.length > 0) {
			const longest = terms.reduce((a, b) => (b.length > a.length ? b : a));
			const contentRows = db.db.prepare(`
				SELECT f.inode, f.filename, f.dateModified, f.dateCreated, f.size,
				       f.tags, f.attributes, f.checksumValue, f.checksumStatus,
				       d.id AS dir_id, d.dirname, c.text, c.status AS contentStatus
				FROM file_content c
				JOIN files f ON f.id = c.file_id
				JOIN dirs d ON f.dir_id = d.id
				WHERE f.deleted_at IS NULL
				  AND f.filename != '.'
				  AND (d.dirname = ? OR d.dirname LIKE ?)
				  AND c.text IS NOT NULL
				  AND instr(lower(c.text), ?) > 0
			`).all(rootPath, rootLike, longest);

			for (const row of contentRows) {
				const textLower = row.text.toLowerCase();
				if (!terms.every(t => textLower.includes(t))) continue;
				contentHits.set(path.join(row.dirname, row.filename), {
					row,
					snippet: buildContentSnippet(row.text, terms),
					contentStatus: row.contentStatus
				});
			}
		}
	} catch (err) {
		logger.warn(`[deepSearch] Phase 1 content query error: ${err.message}`);
	}

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
			const entryPath = path.join(row.dirname, row.filename);
			const hit = contentHits.get(entryPath);
			let score = scoreDbEntry(nameQuery, row.filename, row.tags, row.attributes);
			if (score === null && !hit) continue;
			// Content hit boosts a name/tag/attr match; content-only sits at 28
			// (between attribute-only 30 and notes-only 25).
			if (hit) {
				score = score !== null ? Math.min(100, score + 8) : 28;
				contentHits.delete(entryPath);
			}

			results.push({
				filename:      row.filename,
				path:          entryPath,
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
				contentMatch:   !!hit,
				contentSnippet: hit ? hit.snippet : null,
				contentStatus:  hit ? hit.contentStatus : null,
			});
		}
	} catch (err) {
		logger.warn(`[deepSearch] Phase 1 files query error: ${err.message}`);
	}

	// ── Content-only matches ──────────────────────────────────────────────────
	// Files whose cached text matched but whose name/tags/attributes did not —
	// they were never selected by the files query above.
	for (const [entryPath, hit] of contentHits) {
		const row = hit.row;
		results.push({
			filename:      row.filename,
			path:          entryPath,
			relPath:       path.relative(rootPath, row.dirname),
			isDirectory:   false,
			score:         28,
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
			contentMatch:   true,
			contentSnippet: hit.snippet,
			contentStatus:  hit.contentStatus,
		});
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
			const score = scoreDbEntry(nameQuery, basename, row.tags, row.attributes);
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
 * @param {{ contentMode?: 'cached'|'live', sizeCapBytes?: number }} [options]
 *   contentMode 'cached' (default): content matches come only from the
 *   permanent file_content cache (Phase 1). 'live' (promoted search): Phase 2
 *   additionally extracts text on the fly for uncached supported files,
 *   caching results in the session-scoped memory LRU — never in SQLite.
 */
async function startDeepSearch(rootPath, query, onBatch, cancellationRef, options = {}) {
	if (!query || !query.trim()) {
		onBatch([], true, 2, []);
		return;
	}

	const q      = query.trim();
	// Quotes are phrase delimiters for content matching (handled inside
	// queryDbPhase1); Phase 2 scores filenames/tags/notes, so strip them here.
	const nameQ  = q.replace(/"/g, ' ').trim() || q;
	const qLower = nameQ.toLowerCase();
	const liveContent  = options.contentMode === 'live';
	const sizeCapBytes = options.sizeCapBytes || (10 * 1024 * 1024);
	const contentTerms = liveContent ? parseContentTerms(q).terms : [];

	// ── Phase 1: DB query ────────────────────────────────────────────────────
	// Content matching is Phase 1 / cache-only by design: disk-only files seen
	// in Phase 2 have no file_content row, so Phase 2 never reads file bodies.
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

			// Enqueue real subdirectories for BFS. Links are matched as results
			// but never walked into — a junction's contents are already reached
			// through the target's own path, and the profile root's legacy
			// aliases point at each other, so following them loops.
			if (entry.isDirectory && !entry.isLink) queue.push(entry.path);

			// Already returned in Phase 1 — don't duplicate.
			if (phase1Paths.has(entry.path)) continue;

			const fileRow = enrichment.fileRows[entry.filename];
			const tagsJson = entry.isDirectory ? null : (fileRow ? fileRow.tags : null);
			const baseScore = scoreFilename(nameQ, entry.filename);
			const tags = parseTags(tagsJson);
			const tagMatches = tags.some(t => scoreCandidate(nameQ, t) !== null);
			const noteSectionContent = (notesSections && notesSections[entry.filename]) || '';
			const notesMatches = noteSectionContent.toLowerCase().includes(qLower);

			// Promoted live search: when nothing else matched, extract text on
			// the fly (session LRU) and test the content terms. Files with a
			// permanent cache row were already content-matched in Phase 1.
			let liveContentMatch = false;
			let liveContentSnippet = null;
			if (liveContent && !entry.isDirectory &&
				baseScore === null && !tagMatches && !notesMatches &&
				contentTerms.length > 0 && contentExtractor.isSupported(entry.filename)) {
				const text = await getLiveContentText(entry, sizeCapBytes);
				if (text) {
					const textLower = text.toLowerCase();
					if (contentTerms.every(t => textLower.includes(t))) {
						liveContentMatch = true;
						liveContentSnippet = buildContentSnippet(text, contentTerms);
					}
				}
				if (cancellationRef.cancelled) break;
			}

			if (baseScore === null && !tagMatches && !notesMatches && !liveContentMatch) continue;

			let score;
			if (baseScore !== null) {
				score = baseScore;
				if (tagMatches)   score = Math.min(100, score + 10);
				if (notesMatches) score = Math.min(100, score + 10);
			} else if (tagMatches) {
				score = 35;
				if (notesMatches) score = Math.min(100, score + 10);
			} else if (notesMatches) {
				score = 25; // notes-only match
			} else {
				score = 28; // content-only match (live), same tier as cached content-only
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
				contentMatch:   liveContentMatch,
				contentSnippet: liveContentSnippet,
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

// parseContentTerms / buildContentSnippet exported for unit tests.
module.exports = { startDeepSearch, parseContentTerms, buildContentSnippet };
