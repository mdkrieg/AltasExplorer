const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');

// Global grid-layout layer — the bottom of the Global -> Category -> Local
// inheritance chain. Stored as a flat JSON file so users can inspect/share it,
// consistent with categories/ and settings.json.
const GLOBAL_LAYOUT_PATH = path.join(os.homedir(), '.atlas-explorer', 'grid-layout-global.json');

/**
 * Normalize any stored grid-layout payload to the sparse v2 layer shape:
 *   { version: 2, columns: { field: {size, hidden, sizeConfig?} }, order?, sortData? }
 * - `columns` keys present = that column unit is set at this layer.
 * - `order` / `sortData` absent = inherit; `sortData: []` = explicit no-sort.
 * Legacy full snapshots ({columns: [...], sortData: [...]}) convert to a layer
 * with every column set, order = array order, and sort set iff non-empty
 * (legacy empty sort was never applied, so it maps to "inherit").
 */
function normalizeLayer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.version === 2) {
    const layer = { version: 2, columns: raw.columns && typeof raw.columns === 'object' ? raw.columns : {} };
    if (Array.isArray(raw.order)) layer.order = raw.order;
    if (Array.isArray(raw.sortData)) layer.sortData = raw.sortData;
    return layer;
  }
  if (!Array.isArray(raw.columns)) return null;
  const columns = {};
  for (const col of raw.columns) {
    if (!col || !col.field) continue;
    const unit = { size: col.size, hidden: !!col.hidden };
    if (col.sizeConfig) unit.sizeConfig = { ...col.sizeConfig };
    columns[col.field] = unit;
  }
  const layer = { version: 2, columns, order: raw.columns.map(c => c.field).filter(Boolean) };
  if (Array.isArray(raw.sortData) && raw.sortData.length > 0) layer.sortData = raw.sortData;
  return layer;
}

/**
 * True when a layer sets nothing — no column units, no order, no sort.
 * Empty layers are deleted from storage rather than persisted.
 */
function isEmptyLayer(layer) {
  if (!layer) return true;
  const hasColumns = layer.columns && Object.keys(layer.columns).length > 0;
  return !hasColumns && layer.order === undefined && layer.sortData === undefined;
}

function getGlobalGridLayout() {
  try {
    if (!fs.existsSync(GLOBAL_LAYOUT_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(GLOBAL_LAYOUT_PATH, 'utf8'));
    return normalizeLayer(raw);
  } catch (err) {
    logger.error('Error reading global grid layout:', err.message);
    return null;
  }
}

function setGlobalGridLayout(layer) {
  const normalized = normalizeLayer(layer);
  if (isEmptyLayer(normalized)) {
    if (fs.existsSync(GLOBAL_LAYOUT_PATH)) fs.unlinkSync(GLOBAL_LAYOUT_PATH);
    return null;
  }
  fs.mkdirSync(path.dirname(GLOBAL_LAYOUT_PATH), { recursive: true });
  fs.writeFileSync(GLOBAL_LAYOUT_PATH, JSON.stringify(normalized, null, 2));
  return normalized;
}

module.exports = {
  GLOBAL_LAYOUT_PATH,
  normalizeLayer,
  isEmptyLayer,
  getGlobalGridLayout,
  setGlobalGridLayout
};
