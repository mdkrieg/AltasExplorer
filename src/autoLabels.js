const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const logger = require('./logger');

const AUTO_LABELS_DIR = path.join(os.homedir(), '.atlasexplorer', 'auto-labels');

class AutoLabelService {
  constructor() {
    this.ensureDirectories();
  }

  ensureDirectories() {
    if (!fs.existsSync(AUTO_LABELS_DIR)) {
      fs.mkdirSync(AUTO_LABELS_DIR, { recursive: true });
    }
  }

  /**
   * Load all auto-label rules from disk. Returns a plain object keyed by rule ID.
   */
  loadAutoLabels() {
    const rules = {};
    try {
      const files = fs.readdirSync(AUTO_LABELS_DIR);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const filePath = path.join(AUTO_LABELS_DIR, file);
          const content = fs.readFileSync(filePath, 'utf8');
          const rule = JSON.parse(content);
          if (rule && rule.id) {
            rules[rule.id] = rule;
          }
        } catch (err) {
          logger.warn(`autoLabels: failed to parse ${file}: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error('Error loading auto-labels:', err.message);
    }
    return rules;
  }

  /**
   * Get a single rule by ID.
   */
  getAutoLabel(id) {
    const filePath = path.join(AUTO_LABELS_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      logger.error(`autoLabels: failed to read rule ${id}: ${err.message}`);
      return null;
    }
  }

  /**
   * Create a new rule. Assigns a UUID as the ID.
   */
  createAutoLabel(data) {
    const id = randomUUID();
    const rule = {
      id,
      name: data.name || 'Unnamed Rule',
      description: data.description || '',
      applyType: data.applyType || 'tag',
      applyValue: data.applyValue || '',
      patterns: Array.isArray(data.patterns) ? data.patterns : []
    };
    const filePath = path.join(AUTO_LABELS_DIR, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(rule, null, 2));
    return rule;
  }

  /**
   * Update an existing rule. The ID cannot be changed.
   */
  updateAutoLabel(id, data) {
    const existing = this.getAutoLabel(id);
    if (!existing) throw new Error(`Auto-label rule "${id}" not found`);
    const rule = {
      id,
      name: data.name !== undefined ? data.name : existing.name,
      description: data.description !== undefined ? data.description : existing.description,
      applyType: data.applyType !== undefined ? data.applyType : existing.applyType,
      applyValue: data.applyValue !== undefined ? data.applyValue : existing.applyValue,
      patterns: Array.isArray(data.patterns) ? data.patterns : existing.patterns
    };
    const filePath = path.join(AUTO_LABELS_DIR, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(rule, null, 2));
    return rule;
  }

  /**
   * Delete a rule by ID.
   */
  deleteAutoLabel(id) {
    const filePath = path.join(AUTO_LABELS_DIR, `${id}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Evaluation engine
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Describe a single pattern in human-readable form (used for info tooltip).
   */
  describePattern(pattern) {
    const target = pattern.target === 'parent' ? 'Parent' : 'Self';
    switch (pattern.conditionType) {
      case 'hasCategory':
        return `${target} has category "${pattern.value}"`;
      case 'hasTags': {
        const tags = Array.isArray(pattern.value) ? pattern.value.join(', ') : pattern.value;
        return `${target} has any tag: ${tags}`;
      }
      case 'hasAttribute': {
        const { attr, attrValue } = pattern.value || {};
        return `${target} attribute "${attr}" = "${attrValue}"`;
      }
      case 'nameMatchesRegex':
        return `${target} name matches /${pattern.value}/${pattern.caseInsensitive ? 'i' : ''}`;
      case 'pathMatchesRegex': {
        const normalize = pattern.normalizePathSeparators ? ' (normalized)' : '';
        return `${target} path matches /${pattern.value}/${pattern.caseInsensitive ? 'i' : ''}${normalize}`;
      }
      default:
        return `${target}: unknown condition`;
    }
  }

  /**
   * Evaluate a single pattern against an item data object.
   *
   * itemData shape: { path, category, tags: string[], attributes: object }
   * Returns true if the condition is satisfied.
   */
  _evaluatePattern(pattern, itemData) {
    if (!itemData) return false;

    const tags = Array.isArray(itemData.tags) ? itemData.tags : [];
    const attributes = itemData.attributes || {};

    switch (pattern.conditionType) {
      case 'hasCategory':
        return itemData.category === pattern.value;

      case 'hasTags': {
        // OR logic: any one of the listed tags is present
        const requiredTags = Array.isArray(pattern.value) ? pattern.value : [pattern.value];
        return requiredTags.some(t => tags.includes(t));
      }

      case 'hasAttribute': {
        const { attr, attrValue } = pattern.value || {};
        if (!attr) return false;
        const storedVal = attributes[attr];
        // Compare as strings; treat null/undefined as empty string
        const stored = storedVal !== null && storedVal !== undefined ? String(storedVal) : '';
        const expected = attrValue !== null && attrValue !== undefined ? String(attrValue) : '';
        return stored === expected;
      }

      case 'nameMatchesRegex': {
        if (!pattern.value) return false;
        try {
          const basename = path.basename(itemData.path);
          const flags = pattern.caseInsensitive ? 'i' : '';
          return new RegExp(pattern.value, flags).test(basename);
        } catch {
          return false;
        }
      }

      case 'pathMatchesRegex': {
        if (!pattern.value) return false;
        try {
          let testPath = itemData.path;
          if (pattern.normalizePathSeparators) {
            testPath = testPath.replace(/\\/g, '/');
          }
          const flags = pattern.caseInsensitive ? 'i' : '';
          return new RegExp(pattern.value, flags).test(testPath);
        } catch {
          return false;
        }
      }

      default:
        return false;
    }
  }

  /**
   * Evaluate all patterns of a rule against a single item.
   *
   * selfData  : { path, category, tags, attributes } for the item itself
   * parentData: same shape for the parent directory (may be null)
   *
   * Returns: { matched: boolean, patternResults: [{ description, required, matched }] }
   */
  evaluateRule(rule, selfData, parentData) {
    const patterns = Array.isArray(rule.patterns) ? rule.patterns : [];

    if (patterns.length === 0) {
      return { matched: false, patternResults: [] };
    }

    const patternResults = patterns.map(pattern => {
      const targetData = pattern.target === 'parent' ? parentData : selfData;
      const matched = this._evaluatePattern(pattern, targetData);
      return {
        description: this.describePattern(pattern),
        required: !!pattern.required,
        matched
      };
    });

    const required = patternResults.filter(r => r.required);
    const nonRequired = patternResults.filter(r => !r.required);

    const allRequiredMatch = required.length === 0 || required.every(r => r.matched);
    const anyNonRequiredMatch = nonRequired.length === 0 || nonRequired.some(r => r.matched);

    return {
      matched: allRequiredMatch && anyNonRequiredMatch,
      patternResults
    };
  }

  /**
   * Evaluate all rules against all items in the current view.
   *
   * items: array of { path, inode, dirId, isDirectory, tags: string[], category: string, attributes: object }
   * parentDataCache: Map<parentPath, { path, category, tags, attributes }> (pre-fetched by caller)
   *
   * Returns array of suggestion objects, one per positive rule:
   * { ruleId, ruleName, ruleDescription, applyType, applyValue, matchedItems, patternResults }
   *
   * Silent-skip rule: if applyType === 'tag' and ALL matched items already carry the tag → omit
   */
  evaluateAllRules(rules, items, parentDataCache) {
    const suggestions = [];

    for (const rule of Object.values(rules)) {
      const matchedItems = [];
      let patternResultsForFirst = null;

      for (const item of items) {
        const selfData = {
          path: item.path,
          category: item.category,
          tags: item.tags || [],
          attributes: item.attributes || {}
        };

        const parentPath = path.dirname(item.path);
        const parentData = parentDataCache ? parentDataCache.get(parentPath) : null;

        const result = this.evaluateRule(rule, selfData, parentData);

        if (result.matched) {
          matchedItems.push(item);
          if (!patternResultsForFirst) {
            patternResultsForFirst = result.patternResults;
          }
        }
      }

      if (matchedItems.length === 0) continue;

      // Silent-skip: tag already present on ALL matched items
      if (rule.applyType === 'tag') {
        const allAlreadyHaveTag = matchedItems.every(item =>
          Array.isArray(item.tags) && item.tags.includes(rule.applyValue)
        );
        if (allAlreadyHaveTag) continue;
      }

      suggestions.push({
        ruleId: rule.id,
        ruleName: rule.name,
        ruleDescription: rule.description,
        applyType: rule.applyType,
        applyValue: rule.applyValue,
        matchedItems,
        patternResults: patternResultsForFirst || []
      });
    }

    return suggestions;
  }
}

module.exports = new AutoLabelService();
