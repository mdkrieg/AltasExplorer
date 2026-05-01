/**
 * Path Bar Autocomplete
 *
 * Provides scoring and ranked suggestion generation for the path bar input.
 * Scoring tiers:
 *   0   — exact case-insensitive prefix match
 *   1   — prefix Damerau-Levenshtein distance ≤ 1  (fragment.length ≥ 3 only)
 *   2   — case-insensitive substring (contains) match
 *   null — no match; exclude
 *
 * Within the same tier, recently-visited paths receive a -0.5 recency bonus
 * so they sort ahead of alphabetically-equal results.
 */

const MAX_SUGGESTIONS = 10;

/**
 * Damerau-Levenshtein distance (optimal string alignment variant).
 * Handles substitution, insertion, deletion, and adjacent transposition.
 * @param {string} a
 * @param {string} b
 * @returns {number}
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
	for (let j = 0; j <= lb; j++) {
		d[0][j] = j;
	}

	for (let i = 1; i <= la; i++) {
		for (let j = 1; j <= lb; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			d[i][j] = Math.min(
				d[i - 1][j] + 1,         // deletion
				d[i][j - 1] + 1,         // insertion
				d[i - 1][j - 1] + cost   // substitution
			);
			// transposition
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
			}
		}
	}
	return d[la][lb];
}

/**
 * Score a candidate directory name against the typed fragment.
 * Returns 0, 1, 2, or null (exclude).
 * @param {string} fragment
 * @param {string} name
 * @returns {number|null}
 */
export function scoreCandidate(fragment, name) {
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

/**
 * Split a typed path into the existing parent directory portion and the
 * trailing fragment still being typed.
 *
 *   "C:\Users\john\Doc" → { parentPath: "C:\Users\john\", fragment: "Doc" }
 *   "C:\Users\"         → { parentPath: "C:\Users\",      fragment: ""    }
 *   "/home/user/Doc"    → { parentPath: "/home/user/",    fragment: "Doc" }
 *
 * @param {string} typed
 * @returns {{ parentPath: string, fragment: string }}
 */
function splitTypedPath(typed) {
	const sepIdx = Math.max(typed.lastIndexOf('\\'), typed.lastIndexOf('/'));
	if (sepIdx < 0) return { parentPath: '', fragment: typed };
	return {
		parentPath: typed.slice(0, sepIdx + 1),
		fragment: typed.slice(sepIdx + 1),
	};
}

/**
 * Return the set of recently-visited full paths (lowercased) for a panel.
 * @param {object} panelState
 * @param {number} panelId
 * @returns {Set<string>}
 */
function getRecentPaths(panelState, panelId) {
	const history = panelState[panelId]?.navigationHistory || [];
	return new Set(history.map(p => p.toLowerCase()));
}

/**
 * Fetch and rank autocomplete suggestions for the current typed path value.
 *
 * @param {string} typedValue   The full current text in the path input.
 * @param {number} panelId      Active panel id (used for recency boost).
 * @param {object} panelState   The shared panelState object.
 * @returns {Promise<Array<{ name: string, fullPath: string, score: number }>>}
 */
export async function getPathSuggestions(typedValue, panelId, panelState) {
	const { parentPath, fragment } = splitTypedPath(typedValue);
	if (!parentPath) return [];

	let entries;
	try {
		entries = await window.electronAPI.readDirectory(parentPath);
	} catch {
		return [];
	}

	const recentPaths = getRecentPaths(panelState, panelId);
	const results = [];

	for (const entry of entries) {
		if (!entry.isDirectory) continue;
		const score = scoreCandidate(fragment, entry.filename);
		if (score === null) continue;
		const recencyBonus = recentPaths.has(entry.path.toLowerCase()) ? -0.5 : 0;
		results.push({
			name: entry.filename,
			fullPath: entry.path,
			score: score + recencyBonus,
		});
	}

	results.sort((a, b) => {
		if (a.score !== b.score) return a.score - b.score;
		return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
	});

	return results.slice(0, MAX_SUGGESTIONS);
}
