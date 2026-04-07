/**
 * Alerts module.
 * Owns the alert badge, the Alerts modal, and all three tabs:
 *   Summary      – grid of unacknowledged alerts with acknowledge action
 *   History      – grid of acknowledged alerts
 *   Configuration – alert rule management (grid + right-panel editor)
 */

import * as panels from './panels.js';
import { w2ui, w2grid } from './vendor/w2ui.es6.min.js';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const EVENT_LABELS = {
  fileAdded:    'File Added',
  fileRemoved:  'File Removed',
  fileRenamed:  'File Renamed',
  fileModified: 'File Modified',
  fileChanged:  'File Changed',
};

const ALL_EVENT_TYPES = Object.keys(EVENT_LABELS);

function formatEventType(type) {
  return EVENT_LABELS[type] || type;
}

function formatTs(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

/** Render a compact summary cell: "ANY" or "N (item1, item2...)" */
function summariseList(jsonOrAny, sep = ', ') {
  if (!jsonOrAny || jsonOrAny === 'ANY') return 'ANY';
  try {
    const arr = JSON.parse(jsonOrAny);
    if (!arr || arr.length === 0) return 'ANY';
    const label = arr.length === 1 ? arr[0] : `${arr.length}`;
    return `<span title="${arr.join(sep)}">${label}</span>`;
  } catch {
    return jsonOrAny;
  }
}

/** Summarise events: e.g. "3 (File Added, File Modified, File Changed)" */
function summariseEvents(jsonStr) {
  if (!jsonStr) return '—';
  try {
    const arr = JSON.parse(jsonStr);
    if (!arr || arr.length === 0) return '—';
    const labels = arr.map(e => EVENT_LABELS[e] || e);
    return `<span title="${labels.join(', ')}">${labels.length === 1 ? labels[0] : labels.length}</span>`;
  } catch {
    return jsonStr;
  }
}

/** Summarise attributes */
function summariseAttributes(jsonOrAny) {
  if (!jsonOrAny || jsonOrAny === 'ANY') return 'ANY';
  try {
    const arr = JSON.parse(jsonOrAny);
    if (!arr || arr.length === 0) return 'ANY';
    const tipLines = arr.map(a => `${a.name} = ${a.value}`).join('\n');
    return `<span title="${tipLines}">${arr.length}</span>`;
  } catch {
    return jsonOrAny;
  }
}

// ─────────────────────────────────────────────
// Badge
// ─────────────────────────────────────────────

export function updateAlertBadge() {
  const $badge = $('#alerts-badge');
  if (panels.unacknowledgedAlertCount > 0) {
    $badge.text(panels.unacknowledgedAlertCount > 99 ? '99+' : panels.unacknowledgedAlertCount).show();
  } else {
    $badge.hide();
  }
}

// ─────────────────────────────────────────────
// Modal open / close
// ─────────────────────────────────────────────

export async function showAlertsModal() {
  $('#alerts-modal').css('display', 'flex');
  await switchTab('summary');
}

export function hideAlertsModal() {
  $('#alerts-modal').hide();
  _destroyGrids();
}

function _destroyGrids() {
  ['alerts-summary-grid', 'alerts-history-grid', 'alerts-rules-grid'].forEach(name => {
    if (w2ui[name]) w2ui[name].destroy();
  });
}

// ─────────────────────────────────────────────
// Tab switching
// ─────────────────────────────────────────────

let _activeTab = 'summary';

export async function switchTab(tabName) {
  _activeTab = tabName;

  // Update tab bar styling
  $('.alerts-tab-btn').each(function () {
    const isActive = $(this).data('tab') === tabName;
    $(this).css({
      'border-bottom': isActive ? '3px solid #2196F3' : '3px solid transparent',
      'color': isActive ? '#2196F3' : '#666',
    });
  });

  // Show/hide content panels
  $('.alerts-tab-content').hide();
  $(`#alerts-tab-${tabName}`).css('display', 'flex');

  // Load data for the activated tab
  if (tabName === 'summary')       await loadAlertsSummary();
  if (tabName === 'history')       await loadAlertsHistory();
  if (tabName === 'configuration') await loadAlertRules();
}

// ─────────────────────────────────────────────
// Summary Tab
// ─────────────────────────────────────────────

export async function loadAlertsSummary() {
  const result = await window.electronAPI.getAlertsSummary();
  if (!result.success) {
    console.error('Error loading alerts summary:', result.error);
    return;
  }

  if (w2ui['alerts-summary-grid']) w2ui['alerts-summary-grid'].destroy();

  const records = (result.data || []).map((alert, idx) => ({
    recid: idx + 1,
    _id:   alert.id,
    detectedAt: formatTs(alert.created_at),
    eventType:  formatEventType(alert.type),
    filename:   alert.filename || '—',
    category:   alert.category || '—',
    directory:  alert.dirname || '—',
  }));

  w2ui['alerts-summary-grid'] = new w2grid({
    name:  'alerts-summary-grid',
    multiSelect: true,
    show:  { header: false, toolbar: false, footer: true },
    columns: [
      { field: 'detectedAt', text: 'Detected',   size: '160px', resizable: true, sortable: true },
      { field: 'eventType',  text: 'Event',       size: '130px', resizable: true, sortable: true },
      { field: 'filename',   text: 'File',        size: '25%',  resizable: true, sortable: true },
      { field: 'category',   text: 'Category',    size: '15%',  resizable: true, sortable: true },
      { field: 'directory',  text: 'Directory',   size: '30%',  resizable: true, sortable: true },
    ],
    records,
    onSelect:   () => setTimeout(() => _updateAcknowledgeButton(), 0),
    onUnselect: () => setTimeout(() => _updateAcknowledgeButton(), 0),
    onLoad: event => event.preventDefault(),
  });
  w2ui['alerts-summary-grid'].render($('#alerts-summary-grid')[0]);
  _updateAcknowledgeButton();
}

function _updateAcknowledgeButton() {
  const grid = w2ui['alerts-summary-grid'];
  const hasSelection = grid && grid.getSelection().length > 0;
  const $btn = $('#btn-alerts-acknowledge');
  $btn.prop('disabled', !hasSelection);
  $btn.css('opacity', hasSelection ? '1' : '0.5');
}

export async function acknowledgeSelected() {
  const grid = w2ui['alerts-summary-grid'];
  if (!grid) return;

  const selected = grid.getSelection();
  if (!selected || selected.length === 0) return;

  const ids = selected.map(recid => {
    const rec = grid.get(recid);
    return rec ? rec._id : null;
  }).filter(id => id !== null);

  if (ids.length === 0) return;

  const comment = $('#alerts-acknowledge-comment').val().trim() || null;
  const result = await window.electronAPI.acknowledgeAlerts(ids, comment);
  if (!result.success) {
    console.error('Error acknowledging alerts:', result.error);
    return;
  }

  panels.setUnacknowledgedAlertCount(result.newCount);
  updateAlertBadge();
  $('#alerts-acknowledge-comment').val('');
  await loadAlertsSummary();
}

// ─────────────────────────────────────────────
// History Tab
// ─────────────────────────────────────────────

export async function loadAlertsHistory() {
  const result = await window.electronAPI.getAlertsHistory();
  if (!result.success) {
    console.error('Error loading alerts history:', result.error);
    return;
  }

  if (w2ui['alerts-history-grid']) w2ui['alerts-history-grid'].destroy();

  const records = (result.data || []).map((alert, idx) => ({
    recid:           idx + 1,
    detectedAt:      formatTs(alert.created_at),
    eventType:       formatEventType(alert.type),
    filename:        alert.filename || '—',
    category:        alert.category || '—',
    directory:       alert.dirname || '—',
    acknowledgedAt:  formatTs(alert.acknowledged_at),
    comment:         alert.acknowledged_comment || '',
  }));

  w2ui['alerts-history-grid'] = new w2grid({
    name:  'alerts-history-grid',
    show:  { header: false, toolbar: false, footer: true },
    columns: [
      { field: 'detectedAt',     text: 'Detected',      size: '150px', resizable: true, sortable: true },
      { field: 'eventType',      text: 'Event',         size: '120px', resizable: true, sortable: true },
      { field: 'filename',       text: 'File',          size: '18%',  resizable: true, sortable: true },
      { field: 'category',       text: 'Category',      size: '12%',  resizable: true, sortable: true },
      { field: 'directory',      text: 'Directory',     size: '20%',  resizable: true, sortable: true },
      { field: 'acknowledgedAt', text: 'Acknowledged',  size: '150px', resizable: true, sortable: true },
      { field: 'comment',        text: 'Comment',       size: '20%',  resizable: true },
    ],
    records,
    onLoad: event => event.preventDefault(),
  });
  w2ui['alerts-history-grid'].render($('#alerts-history-grid')[0]);
}

// ─────────────────────────────────────────────
// Configuration Tab – Rules Grid
// ─────────────────────────────────────────────

let _editingRule = null; // null = new rule; object = existing rule

export async function loadAlertRules() {
  const result = await window.electronAPI.getAlertRules();
  if (!result.success) {
    console.error('Error loading alert rules:', result.error);
    return;
  }

  if (w2ui['alerts-rules-grid']) w2ui['alerts-rules-grid'].destroy();

  const records = (result.data || []).map((rule, idx) => ({
    recid:      idx + 1,
    _id:        rule.id,
    _raw:       rule,
    categories: summariseList(rule.categories),
    tags:       summariseList(rule.tags),
    attributes: summariseAttributes(rule.attributes),
    events:     summariseEvents(rule.events),
    enabled:    rule.enabled ? 'Yes' : 'No',
  }));

  w2ui['alerts-rules-grid'] = new w2grid({
    name:  'alerts-rules-grid',
    multiSelect: true,
    show:  { header: false, toolbar: false, footer: true },
    columns: [
      { field: 'categories', text: 'Categories', size: '18%', resizable: true, render: (rec) => rec.categories },
      { field: 'tags',       text: 'Tags',       size: '18%', resizable: true, render: (rec) => rec.tags },
      { field: 'attributes', text: 'Attributes', size: '15%', resizable: true, render: (rec) => rec.attributes },
      { field: 'events',     text: 'Events',     size: '20%', resizable: true, render: (rec) => rec.events },
      { field: 'enabled',    text: 'Enabled',    size: '70px', resizable: true },
    ],
    records,
    onSelect:   (e) => setTimeout(() => _onRuleSelect(e), 0),
    onUnselect: ()  => setTimeout(() => _updateRuleToolbar(), 0),
    onLoad: event => event.preventDefault(),
  });
  w2ui['alerts-rules-grid'].render($('#alerts-rules-grid')[0]);
  _updateRuleToolbar();

  // Wire resizable divider
  _initRuleDivider();
}

function _onRuleSelect(e) {
  _updateRuleToolbar();
  const grid = w2ui['alerts-rules-grid'];
  if (!grid) return;
  const sel = grid.getSelection();
  if (sel.length === 1) {
    const rec = grid.get(sel[0]);
    if (rec) openRuleEditor(rec._raw);
  }
}

function _updateRuleToolbar() {
  const grid = w2ui['alerts-rules-grid'];
  const count = grid ? grid.getSelection().length : 0;

  const $edit = $('#btn-alerts-rule-edit');
  const $del  = $('#btn-alerts-rule-delete');

  $edit.prop('disabled', count !== 1);
  $edit.css('opacity', count === 1 ? '1' : '0.5');

  $del.prop('disabled', count === 0);
  $del.css('opacity', count > 0 ? '1' : '0.5');
}

export function openNewRuleEditor() {
  _editingRule = null;
  openRuleEditor(null);
}

export function openRuleEditor(rule) {
  _editingRule = rule || null;
  _renderRuleEditorForm(rule);
  $('#alerts-rule-editor').css('display', 'flex');
}

export function closeRuleEditor() {
  $('#alerts-rule-editor').hide();
  _editingRule = null;
}

// ─────────────────────────────────────────────
// Rule Editor Form
// ─────────────────────────────────────────────

async function _renderRuleEditorForm(rule) {
  // Load available categories, tags, attributes from renderer state
  let allCategories = {};
  let allTags = [];
  let allAttributes = [];

  try {
    const catResult = await window.electronAPI.loadCategories();
    allCategories = catResult || {};
  } catch (e) { /* ignore */ }

  try {
    allTags = await window.electronAPI.getTagsList() || [];
  } catch (e) { /* ignore */ }

  try {
    allAttributes = await window.electronAPI.getAttributesList() || [];
  } catch (e) { /* ignore */ }

  // Parse current rule values
  const ruleCategories  = _parseListOrAny(rule ? rule.categories  : null);
  const ruleTags        = _parseListOrAny(rule ? rule.tags        : null);
  const ruleAttributes  = _parseAttrsOrAny(rule ? rule.attributes  : null);
  const ruleEvents      = _parseEventList(rule ? rule.events       : null);
  const ruleEnabled     = rule ? !!rule.enabled : true;

  const categoryNames = Object.keys(allCategories).sort();
  const tagNames      = allTags.map(t => t.name).sort();

  // Figure out which attributes are available given the currently-selected categories
  const selectedCatNames = ruleCategories === 'ANY' ? [] : ruleCategories;
  const availableAttrNames = _getAvailableAttributes(selectedCatNames, allCategories, allAttributes);

  let html = '';

  // ── Categories ──
  html += `<div class="alerts-rule-section">
    <div class="alerts-rule-section-label">Categories</div>
    <label class="alerts-rule-any-toggle">
      <input type="checkbox" id="rule-cat-any" ${ruleCategories === 'ANY' ? 'checked' : ''}> <span>ANY</span>
    </label>
    <div id="rule-cat-list" class="alerts-rule-options-list" style="${ruleCategories === 'ANY' ? 'display:none;' : ''}">
      ${categoryNames.map(c => `
        <label>
          <input type="checkbox" name="rule-cat" value="${_esc(c)}"
            ${ruleCategories !== 'ANY' && ruleCategories.includes(c) ? 'checked' : ''}>
          ${_esc(c)}
        </label>`).join('')}
    </div>
  </div>`;

  // ── Tags ──
  html += `<div class="alerts-rule-section">
    <div class="alerts-rule-section-label">Tags</div>
    <label class="alerts-rule-any-toggle">
      <input type="checkbox" id="rule-tag-any" ${ruleTags === 'ANY' ? 'checked' : ''}> <span>ANY</span>
    </label>
    <div id="rule-tag-list" class="alerts-rule-options-list" style="${ruleTags === 'ANY' ? 'display:none;' : ''}">
      ${tagNames.length === 0
        ? '<em style="font-size:11px;color:#999;">No tags defined</em>'
        : tagNames.map(t => `
          <label>
            <input type="checkbox" name="rule-tag" value="${_esc(t)}"
              ${ruleTags !== 'ANY' && ruleTags.includes(t) ? 'checked' : ''}>
            ${_esc(t)}
          </label>`).join('')}
    </div>
  </div>`;

  // ── Attributes ──
  const attrIsAny = ruleAttributes === 'ANY';
  html += `<div class="alerts-rule-section" id="rule-attr-section"
      style="${selectedCatNames.length === 0 && ruleCategories !== 'ANY' ? 'display:none;' : ''}">
    <div class="alerts-rule-section-label">Attributes</div>
    <label class="alerts-rule-any-toggle">
      <input type="checkbox" id="rule-attr-any" ${attrIsAny ? 'checked' : ''}> <span>ANY</span>
    </label>
    <div id="rule-attr-list" style="${attrIsAny ? 'display:none;' : ''}">
      ${_renderAttributeRows(availableAttrNames, allAttributes, attrIsAny ? [] : ruleAttributes)}
    </div>
  </div>`;

  // ── Events ──
  html += `<div class="alerts-rule-section">
    <div class="alerts-rule-section-label">Events <em style="font-weight:normal;color:#888;font-size:10px;">(at least one required)</em></div>
    <div class="alerts-rule-options-list">
      ${ALL_EVENT_TYPES.map(e => `
        <label>
          <input type="checkbox" name="rule-event" value="${e}"
            ${ruleEvents.includes(e) ? 'checked' : ''}>
          ${EVENT_LABELS[e]}
        </label>`).join('')}
    </div>
  </div>`;

  // ── Enabled ──
  html += `<div class="alerts-rule-section">
    <label class="alerts-rule-any-toggle">
      <input type="checkbox" id="rule-enabled" ${ruleEnabled ? 'checked' : ''}> <span>Enabled</span>
    </label>
  </div>`;

  const $body = $('#alerts-rule-editor-body');
  $body.html(html);

  // ── Dynamic behaviour wiring ──

  // ANY toggles for categories
  $body.find('#rule-cat-any').on('change', function () {
    const isAny = this.checked;
    $body.find('#rule-cat-list').toggle(!isAny);
    _refreshAttributeSection($body, allCategories, allAttributes);
  });

  // Category checkbox changes → refresh attribute section
  $body.find('input[name="rule-cat"]').on('change', function () {
    _refreshAttributeSection($body, allCategories, allAttributes);
  });

  // ANY toggles for tags
  $body.find('#rule-tag-any').on('change', function () {
    $body.find('#rule-tag-list').toggle(!this.checked);
  });

  // ANY toggle for attributes
  $body.find('#rule-attr-any').on('change', function () {
    $body.find('#rule-attr-list').toggle(!this.checked);
  });
}

function _renderAttributeRows(attrNames, allAttributes, currentValues) {
  if (!attrNames || attrNames.length === 0) {
    return '<em style="font-size:11px;color:#999;">Select specific categories first</em>';
  }
  return attrNames.map(attrName => {
    const def = allAttributes.find(a => a.name === attrName);
    const currentVal = (currentValues || []).find(a => a.name === attrName)?.value ?? '';
    let inputHtml;
    if (def && def.type === 'Selectable' && def.options && def.options.length > 0) {
      inputHtml = `<select name="rule-attr-val" data-attr="${_esc(attrName)}">
        <option value="">(any value)</option>
        ${def.options.map(opt => `<option value="${_esc(opt)}" ${currentVal === opt ? 'selected' : ''}>${_esc(opt)}</option>`).join('')}
      </select>`;
    } else {
      inputHtml = `<input type="text" name="rule-attr-val" data-attr="${_esc(attrName)}"
        value="${_esc(currentVal)}" placeholder="(any value)">`;
    }
    return `<div class="alerts-rule-attr-row">
      <span style="min-width:90px;font-size:11px;">${_esc(attrName)}</span>
      ${inputHtml}
    </div>`;
  }).join('');
}

function _refreshAttributeSection($body, allCategories, allAttributes) {
  const isAny = $body.find('#rule-cat-any').is(':checked');
  const selectedCats = isAny
    ? []
    : $body.find('input[name="rule-cat"]:checked').map(function () { return this.value; }).get();

  const $attrSection = $body.find('#rule-attr-section');
  if (!isAny && selectedCats.length === 0) {
    $attrSection.hide();
    return;
  }
  $attrSection.show();

  const availableAttrs = _getAvailableAttributes(selectedCats, allCategories, allAttributes);
  const currentAttrVals = _collectAttributeValues($body);
  $body.find('#rule-attr-list').html(
    _renderAttributeRows(availableAttrs, allAttributes, currentAttrVals)
  );
}

function _getAvailableAttributes(selectedCatNames, allCategories, allAttributes) {
  if (!selectedCatNames || selectedCatNames.length === 0) {
    // When ANY is selected, expose all defined attributes
    return allAttributes.map(a => a.name);
  }
  const attrSet = new Set();
  selectedCatNames.forEach(catName => {
    const cat = allCategories[catName];
    if (cat && cat.attributes) {
      cat.attributes.forEach(a => attrSet.add(a));
    }
  });
  return [...attrSet];
}

function _collectAttributeValues($body) {
  const result = [];
  $body.find('[name="rule-attr-val"]').each(function () {
    const name = $(this).data('attr');
    const value = $(this).val();
    if (name) result.push({ name, value: value || '' });
  });
  return result;
}

// ─────────────────────────────────────────────
// Save / Delete rules
// ─────────────────────────────────────────────

export async function saveRule() {
  const $body = $('#alerts-rule-editor-body');

  // Collect event selections — at least one required
  const events = $body.find('input[name="rule-event"]:checked').map(function () { return this.value; }).get();
  if (events.length === 0) {
    alert('Please select at least one event type.');
    return;
  }

  // Categories
  const catIsAny = $body.find('#rule-cat-any').is(':checked');
  const categories = catIsAny
    ? 'ANY'
    : JSON.stringify($body.find('input[name="rule-cat"]:checked').map(function () { return this.value; }).get());

  // Tags
  const tagIsAny = $body.find('#rule-tag-any').is(':checked');
  const tags = tagIsAny
    ? 'ANY'
    : JSON.stringify($body.find('input[name="rule-tag"]:checked').map(function () { return this.value; }).get());

  // Attributes
  const attrIsAny = $body.find('#rule-attr-any').is(':checked');
  let attributes = 'ANY';
  if (!attrIsAny) {
    const attrVals = _collectAttributeValues($body).filter(a => a.value !== '');
    attributes = JSON.stringify(attrVals);
  }

  const enabled = $body.find('#rule-enabled').is(':checked');

  const rule = {
    id:         _editingRule ? _editingRule.id : undefined,
    categories,
    tags,
    attributes,
    events:     JSON.stringify(events),
    enabled,
  };

  // Duplicate check: reject exact match against any existing rule (excluding self when editing)
  const grid = w2ui['alerts-rules-grid'];
  if (grid) {
    const sortedEvents = JSON.stringify([...events].sort());
    const duplicate = grid.records.find(rec => {
      if (_editingRule && rec._id === _editingRule.id) return false; // skip self
      const r = rec._raw;
      const rEvents = (() => { try { return JSON.stringify(JSON.parse(r.events || '[]').sort()); } catch { return '[]'; } })();
      return r.categories === categories &&
             r.tags       === tags       &&
             r.attributes === attributes &&
             rEvents      === sortedEvents &&
             !!r.enabled  === enabled;
    });
    if (duplicate) {
      alert('A rule with identical settings already exists. Please adjust the rule definition.');
      return;
    }
  }

  const result = await window.electronAPI.saveAlertRule(rule);
  if (!result.success) {
    console.error('Error saving alert rule:', result.error);
    return;
  }

  closeRuleEditor();
  await loadAlertRules();
}

export async function deleteRules() {
  const grid = w2ui['alerts-rules-grid'];
  if (!grid) return;

  const sel = grid.getSelection();
  if (sel.length === 0) return;

  const ids = sel.map(recid => {
    const rec = grid.get(recid);
    return rec ? rec._id : null;
  }).filter(id => id !== null);

  if (!confirm(`Delete ${ids.length} rule${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) return;

  const result = await window.electronAPI.deleteAlertRules(ids);
  if (!result.success) {
    console.error('Error deleting alert rules:', result.error);
    return;
  }

  closeRuleEditor();
  await loadAlertRules();
}

// ─────────────────────────────────────────────
// Rule editor divider (resizable)
// ─────────────────────────────────────────────

function _initRuleDivider() {
  const $divider = $('#alerts-rule-divider');
  if ($divider.data('divider-init')) return;
  $divider.data('divider-init', true);

  let startX = 0;
  let startWidth = 0;

  $divider.on('mousedown', function (e) {
    e.preventDefault();
    startX = e.clientX;
    const $editor = $('#alerts-rule-editor');
    startWidth = $editor.width();

    $(document).on('mousemove.ruleDivider', function (me) {
      const delta = startX - me.clientX;
      const newWidth = Math.max(260, Math.min(600, startWidth + delta));
      $editor.css('flex', `0 0 ${newWidth}px`);
    });

    $(document).on('mouseup.ruleDivider', function () {
      $(document).off('mousemove.ruleDivider mouseup.ruleDivider');
    });
  });
}

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

function _parseListOrAny(json) {
  if (!json || json === 'ANY') return 'ANY';
  try { return JSON.parse(json); } catch { return 'ANY'; }
}

function _parseAttrsOrAny(json) {
  if (!json || json === 'ANY') return 'ANY';
  try { return JSON.parse(json); } catch { return 'ANY'; }
}

function _parseEventList(json) {
  if (!json) return [];
  try { return JSON.parse(json) || []; } catch { return []; }
}

function _esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
