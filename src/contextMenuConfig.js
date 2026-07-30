const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');

const CONTEXT_MENU_CONFIG_PATH = path.join(os.homedir(), '.atlas-explorer', 'context-menu.json');

/**
 * Read the persisted context-menu groups config.
 * Returns null if the file doesn't exist or is unreadable — the renderer is
 * responsible for seeding/validating defaults, since only it has the command
 * registry (CONTEXT_MENU_REGISTRY) needed to make sense of the raw item ids.
 */
function getContextMenuConfig() {
	try {
		const content = fs.readFileSync(CONTEXT_MENU_CONFIG_PATH, 'utf8');
		return JSON.parse(content);
	} catch (err) {
		if (err.code !== 'ENOENT') {
			logger.error('Error loading context-menu config:', err.message);
		}
		return null;
	}
}

/**
 * Persist the context-menu groups config (full replace).
 */
function saveContextMenuConfig(config) {
	fs.writeFileSync(CONTEXT_MENU_CONFIG_PATH, JSON.stringify(config, null, 2));
}

module.exports = { getContextMenuConfig, saveContextMenuConfig };
