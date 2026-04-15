/**
 * Alerts and Monitoring module.
 * Owns the alert badge plus the Alerts and Monitoring modal tabs:
 *   Summary           - unacknowledged alerts
 *   History           - acknowledged alerts
 *   Alerts            - alert rule management
 *   Active Monitoring - monitoring rule management
 *   Settings          - monitoring scheduler settings
 */

import * as panels from './panels.js';
import { w2ui, w2grid } from './vendor/w2ui.es6.min.js';
import { showFormError, showFormSuccess, clearFormStatus } from './utils.js';

const EVENT_LABELS = {
  fileAdded: 'File Added',
  fileRemoved: 'File Removed',
  fileRenamed: 'File Renamed',
  fileModified: 'File Modified',
  fileChanged: 'File Changed',
};

const ALL_EVENT_TYPES = Object.keys(EVENT_LABELS);
const MONITORING_INTERVAL_UNITS = ['seconds', 'minutes', 'hours', 'days'];

let activeTab = 'summary';
let editingAlertRule = null;
let editingMonitoringRule = null;

function formatEventType(type) {
  return EVENT_LABELS[type] || type;
}

function formatTs(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

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

function summariseEvents(jsonStr) {
  if (!jsonStr) return '—';
  try {
    const arr = JSON.parse(jsonStr);
    if (!arr || arr.length === 0) return '—';
    const labels = arr.map(eventType => EVENT_LABELS[eventType] || eventType);
    return `<span title="${labels.join(', ')}">${labels.length === 1 ? labels[0] : labels.length}</span>`;
  } catch {
    return jsonStr;
  }
}

function summariseAttributes(jsonOrAny) {
  if (!jsonOrAny || jsonOrAny === 'ANY') return 'ANY';
  try {
    const arr = JSON.parse(jsonOrAny);
    if (!arr || arr.length === 0) return 'ANY';
    const tipLines = arr.map(attr => `${attr.name} = ${attr.value}`).join('\n');
    return `<span title="${tipLines}">${arr.length}</span>`;
  } catch {
    return jsonOrAny;
  }
}

function summariseInterval(rule) {
  return `${Number(rule.interval_value) || 1} ${rule.interval_unit || 'days'}`;
}

function parseListOrAny(json) {
  if (!json || json === 'ANY') return 'ANY';
  try { return JSON.parse(json); } catch { return 'ANY'; }
}

function parseAttrsOrAny(json) {
  if (!json || json === 'ANY') return 'ANY';
  try { return JSON.parse(json); } catch { return 'ANY'; }
}

function parseEventList(json) {
  if (!json) return [];
  try { return JSON.parse(json) || []; } catch { return []; }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function destroyGrids() {
  ['alerts-summary-grid', 'alerts-history-grid', 'alerts-rules-grid', 'monitoring-rules-grid'].forEach(name => {
    if (w2ui[name]) w2ui[name].destroy();
  });
}

async function loadRuleDependencies() {
  let allCategories = {};
  let allTags = [];
  let allAttributes = [];

  try {
    allCategories = await window.electronAPI.loadCategories() || {};
  } catch {}

  try {
    allTags = await window.electronAPI.getTagsList() || [];
  } catch {}

  try {
    allAttributes = await window.electronAPI.getAttributesList() || [];
  } catch {}

  return { allCategories, allTags, allAttributes };
}

function getAvailableAttributes(selectedCatNames, allCategories, allAttributes) {
  if (!selectedCatNames || selectedCatNames.length === 0) {
    return allAttributes.map(attr => attr.name);
  }

  const attrSet = new Set();
  selectedCatNames.forEach(catName => {
    const category = allCategories[catName];
    if (category && category.attributes) {
      category.attributes.forEach(attrName => attrSet.add(attrName));
    }
  });
  return [...attrSet];
}

function collectAttributeValues($body) {
  const result = [];
  $body.find('[name="rule-attr-val"]').each(function () {
    const name = $(this).data('attr');
    const value = $(this).val();
    if (name) result.push({ name, value: value || '' });
  });
  return result;
}

function renderAttributeRows(attrNames, allAttributes, currentValues) {
  if (!attrNames || attrNames.length === 0) {
    return '<em style="font-size:11px;color:#999;">Select specific categories first</em>';
  }

  return attrNames.map(attrName => {
    const definition = allAttributes.find(attr => attr.name === attrName);
    const currentValue = (currentValues || []).find(attr => attr.name === attrName)?.value ?? '';

    let inputHtml;
    if (definition && definition.type === 'Selectable' && definition.options && definition.options.length > 0) {
      inputHtml = `<select name="rule-attr-val" data-attr="${escapeHtml(attrName)}">
        <option value="">(any value)</option>
        ${definition.options.map(option => `<option value="${escapeHtml(option)}" ${currentValue === option ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}
      </select>`;
    } else {
      inputHtml = `<input type="text" name="rule-attr-val" data-attr="${escapeHtml(attrName)}" value="${escapeHtml(currentValue)}" placeholder="(any value)">`;
    }

    return `<div class="alerts-rule-attr-row">
      <span style="min-width:90px;font-size:11px;">${escapeHtml(attrName)}</span>
      ${inputHtml}
    </div>`;
  }).join('');
}

function refreshAttributeSection($body, allCategories, allAttributes) {
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

  const availableAttrs = getAvailableAttributes(selectedCats, allCategories, allAttributes);
  const currentAttrVals = collectAttributeValues($body);
  $body.find('#rule-attr-list').html(renderAttributeRows(availableAttrs, allAttributes, currentAttrVals));
}

function buildCommonRuleHtml(rule, allCategories, allTags, allAttributes) {
  const ruleCategories = parseListOrAny(rule ? rule.categories : null);
  const ruleTags = parseListOrAny(rule ? rule.tags : null);
  const ruleAttributes = parseAttrsOrAny(rule ? rule.attributes : null);
  const categoryNames = Object.keys(allCategories).sort();
  const tagNames = allTags.map(tag => tag.name).sort();
  const selectedCatNames = ruleCategories === 'ANY' ? [] : ruleCategories;
  const attrNames = getAvailableAttributes(selectedCatNames, allCategories, allAttributes);
  const attrIsAny = ruleAttributes === 'ANY';

  return `
    <div class="alerts-rule-section">
      <div class="alerts-rule-section-label">Categories</div>
      <label class="alerts-rule-any-toggle">
        <input type="checkbox" id="rule-cat-any" ${ruleCategories === 'ANY' ? 'checked' : ''}> <span>ANY</span>
      </label>
      <div id="rule-cat-list" class="alerts-rule-options-list" style="${ruleCategories === 'ANY' ? 'display:none;' : ''}">
        ${categoryNames.map(categoryName => `
          <label>
            <input type="checkbox" name="rule-cat" value="${escapeHtml(categoryName)}" ${ruleCategories !== 'ANY' && ruleCategories.includes(categoryName) ? 'checked' : ''}>
            ${escapeHtml(categoryName)}
          </label>`).join('')}
      </div>
    </div>

    <div class="alerts-rule-section">
      <div class="alerts-rule-section-label">Tags</div>
      <label class="alerts-rule-any-toggle">
        <input type="checkbox" id="rule-tag-any" ${ruleTags === 'ANY' ? 'checked' : ''}> <span>ANY</span>
      </label>
      <div id="rule-tag-list" class="alerts-rule-options-list" style="${ruleTags === 'ANY' ? 'display:none;' : ''}">
        ${tagNames.length === 0
          ? '<em style="font-size:11px;color:#999;">No tags defined</em>'
          : tagNames.map(tagName => `
            <label>
              <input type="checkbox" name="rule-tag" value="${escapeHtml(tagName)}" ${ruleTags !== 'ANY' && ruleTags.includes(tagName) ? 'checked' : ''}>
              ${escapeHtml(tagName)}
            </label>`).join('')}
      </div>
    </div>

    <div class="alerts-rule-section" id="rule-attr-section" style="${selectedCatNames.length === 0 && ruleCategories !== 'ANY' ? 'display:none;' : ''}">
      <div class="alerts-rule-section-label">Attributes</div>
      <label class="alerts-rule-any-toggle">
        <input type="checkbox" id="rule-attr-any" ${attrIsAny ? 'checked' : ''}> <span>ANY</span>
      </label>
      <div id="rule-attr-list" style="${attrIsAny ? 'display:none;' : ''}">
        ${renderAttributeRows(attrNames, allAttributes, attrIsAny ? [] : ruleAttributes)}
      </div>
    </div>
  `;
}

function wireCommonRuleEvents($body, allCategories, allAttributes) {
  $body.find('#rule-cat-any').on('change', function () {
    const isAny = this.checked;
    $body.find('#rule-cat-list').toggle(!isAny);
    refreshAttributeSection($body, allCategories, allAttributes);
  });

  $body.find('input[name="rule-cat"]').on('change', function () {
    refreshAttributeSection($body, allCategories, allAttributes);
  });

  $body.find('#rule-tag-any').on('change', function () {
    $body.find('#rule-tag-list').toggle(!this.checked);
  });

  $body.find('#rule-attr-any').on('change', function () {
    $body.find('#rule-attr-list').toggle(!this.checked);
  });
}

function collectCommonRuleValues($body) {
  const catIsAny = $body.find('#rule-cat-any').is(':checked');
  const categories = catIsAny
    ? 'ANY'
    : JSON.stringify($body.find('input[name="rule-cat"]:checked').map(function () { return this.value; }).get());

  const tagIsAny = $body.find('#rule-tag-any').is(':checked');
  const tags = tagIsAny
    ? 'ANY'
    : JSON.stringify($body.find('input[name="rule-tag"]:checked').map(function () { return this.value; }).get());

  const attrIsAny = $body.find('#rule-attr-any').is(':checked');
  let attributes = 'ANY';
  if (!attrIsAny) {
    const attrVals = collectAttributeValues($body).filter(attr => attr.value !== '');
    attributes = JSON.stringify(attrVals);
  }

  return { categories, tags, attributes };
}

function updateAcknowledgeButton() {
  const grid = w2ui['alerts-summary-grid'];
  const hasRecords = !!(grid && grid.records.length > 0);
  const hasSelection = grid && grid.getSelection().length > 0;
  $('#btn-alerts-select-all').prop('disabled', !hasRecords).css('opacity', hasRecords ? '1' : '0.5');
  $('#btn-alerts-acknowledge').prop('disabled', !hasSelection).css('opacity', hasSelection ? '1' : '0.5');
}

function updateRuleToolbar(gridName, editSelector, deleteSelector) {
  const grid = w2ui[gridName];
  const count = grid ? grid.getSelection().length : 0;
  $(editSelector).prop('disabled', count !== 1).css('opacity', count === 1 ? '1' : '0.5');
  $(deleteSelector).prop('disabled', count === 0).css('opacity', count > 0 ? '1' : '0.5');
}

function initRuleDivider(dividerSelector, editorSelector) {
  const $divider = $(dividerSelector);
  if ($divider.data('divider-init')) return;
  $divider.data('divider-init', true);

  let startX = 0;
  let startWidth = 0;

  $divider.on('mousedown', function (event) {
    event.preventDefault();
    startX = event.clientX;
    const $editor = $(editorSelector);
    startWidth = $editor.width();

    $(document).on(`mousemove${dividerSelector}`, function (moveEvent) {
      const delta = startX - moveEvent.clientX;
      const newWidth = Math.max(260, Math.min(600, startWidth + delta));
      $editor.css('flex', `0 0 ${newWidth}px`);
    });

    $(document).on(`mouseup${dividerSelector}`, function () {
      $(document).off(`mousemove${dividerSelector} mouseup${dividerSelector}`);
    });
  });
}

function sortJsonArrayString(jsonStr) {
  try {
    return JSON.stringify((JSON.parse(jsonStr || '[]') || []).slice().sort());
  } catch {
    return '[]';
  }
}

function getNextAlertRuleName(rules) {
  const existingNames = new Set(
    (rules || [])
      .map(rule => String(rule?.name || '').trim().toLowerCase())
      .filter(Boolean)
  );

  let suffix = 1;
  while (existingNames.has(`alert ${suffix}`)) {
    suffix += 1;
  }

  return `Alert ${suffix}`;
}

export function updateAlertBadge() {
  const $badge = $('#alerts-badge');
  const $collapsedBadge = $('#alerts-badge-collapsed');
  if (panels.unacknowledgedAlertCount > 0) {
    const badgeText = panels.unacknowledgedAlertCount > 99 ? '99+' : panels.unacknowledgedAlertCount;
    $badge.text(badgeText).show();
    $collapsedBadge.text(badgeText).addClass('has-alerts');
  } else {
    $badge.hide();
    $collapsedBadge.text('').removeClass('has-alerts');
  }
}

export async function showAlertsModal() {
  $('#alerts-modal').css('display', 'flex');
  await switchTab('summary');
}

export function hideAlertsModal() {
  $('#alerts-modal').hide();
  closeRuleEditor();
  closeMonitoringRuleEditor();
  destroyGrids();
}

export async function switchTab(tabName) {
  activeTab = tabName;

  $('.alerts-tab-btn').each(function () {
    const isActive = $(this).data('tab') === tabName;
    $(this).css({
      'border-bottom': isActive ? '3px solid #2196F3' : '3px solid transparent',
      'color': isActive ? '#2196F3' : '#666',
    });
  });

  $('.alerts-tab-content').hide();
  $(`#alerts-tab-${tabName}`).css('display', 'flex');

  if (tabName === 'summary') await loadAlertsSummary();
  if (tabName === 'history') await loadAlertsHistory();
  if (tabName === 'alerts') await loadAlertRules();
  if (tabName === 'monitoring') await loadMonitoringRules();
  if (tabName === 'settings') await loadMonitoringSettings();
}

export async function loadAlertsSummary() {
  const result = await window.electronAPI.getAlertsSummary();
  if (!result.success) {
    console.error('Error loading alerts summary:', result.error);
    return;
  }

  if (w2ui['alerts-summary-grid']) w2ui['alerts-summary-grid'].destroy();

  const records = (result.data || []).map((alert, idx) => ({
    recid: idx + 1,
    _id: alert.id,
    detectedAt: formatTs(alert.created_at),
    ruleName: alert.rule_name || '—',
    eventType: formatEventType(alert.type),
    filename: alert.filename || '—',
    category: alert.category || '—',
    directory: alert.dirname || '—',
  }));

  w2ui['alerts-summary-grid'] = new w2grid({
    name: 'alerts-summary-grid',
    multiSelect: true,
    show: { header: false, toolbar: false, footer: true },
    columns: [
      { field: 'detectedAt', text: 'Detected', size: '160px', resizable: true, sortable: true },
      { field: 'ruleName', text: 'Rule', size: '160px', resizable: true, sortable: true },
      { field: 'eventType', text: 'Event', size: '130px', resizable: true, sortable: true },
      { field: 'filename', text: 'File', size: '25%', resizable: true, sortable: true },
      { field: 'category', text: 'Category', size: '15%', resizable: true, sortable: true },
      { field: 'directory', text: 'Directory', size: '30%', resizable: true, sortable: true },
    ],
    records,
    onSelect: () => setTimeout(() => updateAcknowledgeButton(), 0),
    onUnselect: () => setTimeout(() => updateAcknowledgeButton(), 0),
    onLoad: event => event.preventDefault(),
  });
  w2ui['alerts-summary-grid'].render($('#alerts-summary-grid')[0]);
  updateAcknowledgeButton();
}

export function selectAllSummaryAlerts() {
  const grid = w2ui['alerts-summary-grid'];
  if (!grid || grid.records.length === 0) return;

  grid.selectAll();
  updateAcknowledgeButton();
}

export async function acknowledgeSelected() {
  const grid = w2ui['alerts-summary-grid'];
  if (!grid) return;

  const selected = grid.getSelection();
  if (!selected || selected.length === 0) return;

  const ids = selected.map(recid => {
    const record = grid.get(recid);
    return record ? record._id : null;
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

export async function loadAlertsHistory() {
  const result = await window.electronAPI.getAlertsHistory();
  if (!result.success) {
    console.error('Error loading alerts history:', result.error);
    return;
  }

  if (w2ui['alerts-history-grid']) w2ui['alerts-history-grid'].destroy();

  const records = (result.data || []).map((alert, idx) => ({
    recid: idx + 1,
    detectedAt: formatTs(alert.created_at),
    ruleName: alert.rule_name || '—',
    eventType: formatEventType(alert.type),
    filename: alert.filename || '—',
    category: alert.category || '—',
    directory: alert.dirname || '—',
    acknowledgedAt: formatTs(alert.acknowledged_at),
    comment: alert.acknowledged_comment || '',
  }));

  w2ui['alerts-history-grid'] = new w2grid({
    name: 'alerts-history-grid',
    show: { header: false, toolbar: false, footer: true },
    columns: [
      { field: 'detectedAt', text: 'Detected', size: '150px', resizable: true, sortable: true },
      { field: 'ruleName', text: 'Rule', size: '150px', resizable: true, sortable: true },
      { field: 'eventType', text: 'Event', size: '120px', resizable: true, sortable: true },
      { field: 'filename', text: 'File', size: '18%', resizable: true, sortable: true },
      { field: 'category', text: 'Category', size: '12%', resizable: true, sortable: true },
      { field: 'directory', text: 'Directory', size: '20%', resizable: true, sortable: true },
      { field: 'acknowledgedAt', text: 'Acknowledged', size: '150px', resizable: true, sortable: true },
      { field: 'comment', text: 'Comment', size: '20%', resizable: true },
    ],
    records,
    onLoad: event => event.preventDefault(),
  });
  w2ui['alerts-history-grid'].render($('#alerts-history-grid')[0]);
}

export async function loadAlertRules() {
  const result = await window.electronAPI.getAlertRules();
  if (!result.success) {
    console.error('Error loading alert rules:', result.error);
    return;
  }

  if (w2ui['alerts-rules-grid']) w2ui['alerts-rules-grid'].destroy();

  const records = (result.data || []).map((rule, idx) => ({
    recid: idx + 1,
    _id: rule.id,
    _raw: rule,
    name: rule.name || '—',
    categories: summariseList(rule.categories),
    tags: summariseList(rule.tags),
    attributes: summariseAttributes(rule.attributes),
    events: summariseEvents(rule.events),
    enabled: rule.enabled ? 'Yes' : 'No',
  }));

  w2ui['alerts-rules-grid'] = new w2grid({
    name: 'alerts-rules-grid',
    multiSelect: true,
    show: { header: false, toolbar: false, footer: true },
    columns: [
      { field: 'name', text: 'Name', size: '160px', resizable: true, sortable: true },
      { field: 'categories', text: 'Categories', size: '18%', resizable: true, render: rec => rec.categories },
      { field: 'tags', text: 'Tags', size: '18%', resizable: true, render: rec => rec.tags },
      { field: 'attributes', text: 'Attributes', size: '15%', resizable: true, render: rec => rec.attributes },
      { field: 'events', text: 'Events', size: '20%', resizable: true, render: rec => rec.events },
      { field: 'enabled', text: 'Enabled', size: '70px', resizable: true },
    ],
    records,
    onSelect: () => setTimeout(() => onAlertRuleSelect(), 0),
    onUnselect: () => setTimeout(() => updateRuleToolbar('alerts-rules-grid', '#btn-alerts-rule-edit', '#btn-alerts-rule-delete'), 0),
    onLoad: event => event.preventDefault(),
  });
  w2ui['alerts-rules-grid'].render($('#alerts-rules-grid')[0]);
  updateRuleToolbar('alerts-rules-grid', '#btn-alerts-rule-edit', '#btn-alerts-rule-delete');
  initRuleDivider('#alerts-rule-divider', '#alerts-rule-editor');
}

function onAlertRuleSelect() {
  updateRuleToolbar('alerts-rules-grid', '#btn-alerts-rule-edit', '#btn-alerts-rule-delete');
  const grid = w2ui['alerts-rules-grid'];
  if (!grid) return;
  const selection = grid.getSelection();
  if (selection.length === 1) {
    const record = grid.get(selection[0]);
    if (record) openRuleEditor(record._raw);
  }
}

export function openNewRuleEditor() {
  editingAlertRule = null;
  openRuleEditor(null);
}

export function openRuleEditor(rule) {
  editingAlertRule = rule || null;
  renderAlertRuleEditorForm(rule);
  $('#alerts-rule-editor').css('display', 'flex');
}

export function closeRuleEditor() {
  $('#alerts-rule-editor').hide();
  editingAlertRule = null;
}

async function renderAlertRuleEditorForm(rule) {
  const { allCategories, allTags, allAttributes } = await loadRuleDependencies();
  const rulesResult = await window.electronAPI.getAlertRules();
  const defaultRuleName = getNextAlertRuleName(rulesResult.success ? rulesResult.data : []);
  const ruleEvents = parseEventList(rule ? rule.events : null);
  const ruleEnabled = rule ? !!rule.enabled : true;
  const ruleName = rule?.name || defaultRuleName;
  let html = `<div class="alerts-rule-section">
    <div class="alerts-rule-section-label">Name <em style="font-weight:normal;color:#888;font-size:10px;">(required)</em></div>
    <input type="text" id="alert-rule-name" maxlength="120" required value="${escapeHtml(ruleName)}" placeholder="Alert name">
  </div>`;

  html += buildCommonRuleHtml(rule, allCategories, allTags, allAttributes);

  html += `<div class="alerts-rule-section">
    <div class="alerts-rule-section-label">Events <em style="font-weight:normal;color:#888;font-size:10px;">(at least one required)</em></div>
    <div class="alerts-rule-options-list">
      ${ALL_EVENT_TYPES.map(eventType => `
        <label>
          <input type="checkbox" name="rule-event" value="${eventType}" ${ruleEvents.includes(eventType) ? 'checked' : ''}>
          ${EVENT_LABELS[eventType]}
        </label>`).join('')}
    </div>
  </div>`;

  html += `<div class="alerts-rule-section">
    <label class="alerts-rule-any-toggle">
      <input type="checkbox" id="rule-enabled" ${ruleEnabled ? 'checked' : ''}> <span>Enabled</span>
    </label>
  </div>`;

  const $body = $('#alerts-rule-editor-body');
  $body.html(html);
  wireCommonRuleEvents($body, allCategories, allAttributes);
}

export async function saveRule() {
  clearFormStatus(null, 'alerts-rule-status');
  const $body = $('#alerts-rule-editor-body');
  const name = String($body.find('#alert-rule-name').val() || '').trim();
  if (!name) {
    showFormError('alerts-rule-status', 'Rule name is required.', 'alert-rule-name');
    $body.find('#alert-rule-name').trigger('focus');
    return;
  }

  const events = $body.find('input[name="rule-event"]:checked').map(function () { return this.value; }).get();
  if (events.length === 0) {
    showFormError('alerts-rule-status', 'Select at least one event type.');
    return;
  }

  const common = collectCommonRuleValues($body);
  const enabled = $body.find('#rule-enabled').is(':checked');
  const rule = {
    id: editingAlertRule ? editingAlertRule.id : undefined,
    name,
    ...common,
    events: JSON.stringify(events),
    enabled,
  };

  const grid = w2ui['alerts-rules-grid'];
  if (grid) {
    const normalizedName = name.toLowerCase();
    const nameConflict = grid.records.find(rec => {
      if (editingAlertRule && rec._id === editingAlertRule.id) return false;
      return String(rec._raw?.name || '').trim().toLowerCase() === normalizedName;
    });
    if (nameConflict) {
      showFormError('alerts-rule-status', 'An alert with that name already exists.', 'alert-rule-name');
      $body.find('#alert-rule-name').trigger('focus');
      return;
    }

    const sortedEvents = JSON.stringify([...events].sort());
    const duplicate = grid.records.find(rec => {
      if (editingAlertRule && rec._id === editingAlertRule.id) return false;
      const existing = rec._raw;
      return existing.categories === rule.categories &&
        existing.tags === rule.tags &&
        existing.attributes === rule.attributes &&
        sortJsonArrayString(existing.events) === sortedEvents &&
        !!existing.enabled === enabled;
    });
    if (duplicate) {
      showFormError('alerts-rule-status', 'A rule with identical settings already exists.');
      return;
    }
  }

  const result = await window.electronAPI.saveAlertRule(rule);
  if (!result.success) {
    showFormError('alerts-rule-status', result.error || 'Error saving alert rule.');
    console.error('Error saving alert rule:', result.error);
    return;
  }

  closeRuleEditor();
  await loadAlertRules();
}

export async function deleteRules() {
  const grid = w2ui['alerts-rules-grid'];
  if (!grid) return;

  const selected = grid.getSelection();
  if (selected.length === 0) return;

  const ids = selected.map(recid => {
    const record = grid.get(recid);
    return record ? record._id : null;
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

export async function loadMonitoringRules() {
  const result = await window.electronAPI.getMonitoringRules();
  if (!result.success) {
    console.error('Error loading monitoring rules:', result.error);
    return;
  }

  if (w2ui['monitoring-rules-grid']) w2ui['monitoring-rules-grid'].destroy();

  const records = (result.data || []).map((rule, idx) => ({
    recid: idx + 1,
    _id: rule.id,
    _raw: rule,
    categories: summariseList(rule.categories),
    tags: summariseList(rule.tags),
    attributes: summariseAttributes(rule.attributes),
    interval: summariseInterval(rule),
    maxDepth: String(rule.max_depth ?? 0),
    enabled: rule.enabled ? 'Yes' : 'No',
  }));

  w2ui['monitoring-rules-grid'] = new w2grid({
    name: 'monitoring-rules-grid',
    multiSelect: true,
    show: { header: false, toolbar: false, footer: true },
    columns: [
      { field: 'categories', text: 'Categories', size: '18%', resizable: true, render: rec => rec.categories },
      { field: 'tags', text: 'Tags', size: '18%', resizable: true, render: rec => rec.tags },
      { field: 'attributes', text: 'Attributes', size: '15%', resizable: true, render: rec => rec.attributes },
      { field: 'interval', text: 'Interval', size: '120px', resizable: true },
      { field: 'maxDepth', text: 'Depth', size: '70px', resizable: true },
      { field: 'enabled', text: 'Enabled', size: '70px', resizable: true },
    ],
    records,
    onSelect: () => setTimeout(() => onMonitoringRuleSelect(), 0),
    onUnselect: () => setTimeout(() => updateRuleToolbar('monitoring-rules-grid', '#btn-monitoring-rule-edit', '#btn-monitoring-rule-delete'), 0),
    onLoad: event => event.preventDefault(),
  });
  w2ui['monitoring-rules-grid'].render($('#monitoring-rules-grid')[0]);
  updateRuleToolbar('monitoring-rules-grid', '#btn-monitoring-rule-edit', '#btn-monitoring-rule-delete');
  initRuleDivider('#monitoring-rule-divider', '#monitoring-rule-editor');
}

function onMonitoringRuleSelect() {
  updateRuleToolbar('monitoring-rules-grid', '#btn-monitoring-rule-edit', '#btn-monitoring-rule-delete');
  const grid = w2ui['monitoring-rules-grid'];
  if (!grid) return;
  const selection = grid.getSelection();
  if (selection.length === 1) {
    const record = grid.get(selection[0]);
    if (record) openMonitoringRuleEditor(record._raw);
  }
}

export function openNewMonitoringRuleEditor() {
  editingMonitoringRule = null;
  openMonitoringRuleEditor(null);
}

export function openMonitoringRuleEditor(rule) {
  editingMonitoringRule = rule || null;
  renderMonitoringRuleEditorForm(rule);
  $('#monitoring-rule-editor').css('display', 'flex');
}

export function closeMonitoringRuleEditor() {
  $('#monitoring-rule-editor').hide();
  editingMonitoringRule = null;
}

async function renderMonitoringRuleEditorForm(rule) {
  const { allCategories, allTags, allAttributes } = await loadRuleDependencies();
  const intervalValue = Number(rule ? rule.interval_value : 1) || 1;
  const intervalUnit = rule ? (rule.interval_unit || 'days') : 'days';
  const maxDepth = Number(rule ? rule.max_depth : 0) || 0;
  const ruleEnabled = rule ? !!rule.enabled : true;

  let html = buildCommonRuleHtml(rule, allCategories, allTags, allAttributes);
  html += `<div class="alerts-rule-section">
    <div class="alerts-rule-section-label">Scan Interval</div>
    <div style="display:flex;gap:8px;align-items:center;">
      <input type="number" id="monitoring-interval-value" min="1" max="100000" value="${intervalValue}" style="width:100px;">
      <select id="monitoring-interval-unit">
        ${MONITORING_INTERVAL_UNITS.map(unit => `<option value="${unit}" ${intervalUnit === unit ? 'selected' : ''}>${unit}</option>`).join('')}
      </select>
    </div>
  </div>`;

  html += `<div class="alerts-rule-section">
    <div class="alerts-rule-section-label">Maximum Recursive Depth</div>
    <input type="number" id="monitoring-max-depth" min="0" max="99" value="${maxDepth}">
  </div>`;

  html += `<div class="alerts-rule-section">
    <label class="alerts-rule-any-toggle">
      <input type="checkbox" id="monitoring-rule-enabled" ${ruleEnabled ? 'checked' : ''}> <span>Enabled</span>
    </label>
  </div>`;

  const $body = $('#monitoring-rule-editor-body');
  $body.html(html);
  wireCommonRuleEvents($body, allCategories, allAttributes);
}

export async function saveMonitoringRule() {
  const $body = $('#monitoring-rule-editor-body');
  const common = collectCommonRuleValues($body);
  let intervalValue = parseInt($body.find('#monitoring-interval-value').val() || '1', 10);
  let maxDepth = parseInt($body.find('#monitoring-max-depth').val() || '0', 10);
  const intervalUnit = $body.find('#monitoring-interval-unit').val() || 'days';
  const enabled = $body.find('#monitoring-rule-enabled').is(':checked');

  if (Number.isNaN(intervalValue) || intervalValue < 1) intervalValue = 1;
  if (Number.isNaN(maxDepth) || maxDepth < 0) maxDepth = 0;

  const rule = {
    id: editingMonitoringRule ? editingMonitoringRule.id : undefined,
    ...common,
    interval_value: intervalValue,
    interval_unit: intervalUnit,
    max_depth: maxDepth,
    enabled,
  };

  const grid = w2ui['monitoring-rules-grid'];
  if (grid) {
    const duplicate = grid.records.find(rec => {
      if (editingMonitoringRule && rec._id === editingMonitoringRule.id) return false;
      const existing = rec._raw;
      return existing.categories === rule.categories &&
        existing.tags === rule.tags &&
        existing.attributes === rule.attributes &&
        Number(existing.interval_value) === rule.interval_value &&
        existing.interval_unit === rule.interval_unit &&
        Number(existing.max_depth) === rule.max_depth &&
        !!existing.enabled === enabled;
    });
    if (duplicate) {
      alert('A monitoring rule with identical settings already exists. Please adjust the rule definition.');
      return;
    }
  }

  const result = await window.electronAPI.saveMonitoringRule(rule);
  if (!result.success) {
    console.error('Error saving monitoring rule:', result.error);
    return;
  }

  closeMonitoringRuleEditor();
  await loadMonitoringRules();
}

export async function deleteMonitoringRules() {
  const grid = w2ui['monitoring-rules-grid'];
  if (!grid) return;

  const selected = grid.getSelection();
  if (selected.length === 0) return;

  const ids = selected.map(recid => {
    const record = grid.get(recid);
    return record ? record._id : null;
  }).filter(id => id !== null);

  if (!confirm(`Delete ${ids.length} monitoring rule${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) return;

  const result = await window.electronAPI.deleteMonitoringRules(ids);
  if (!result.success) {
    console.error('Error deleting monitoring rules:', result.error);
    return;
  }

  closeMonitoringRuleEditor();
  await loadMonitoringRules();
}

export async function loadMonitoringSettings() {
  const settings = await window.electronAPI.getSettings();
  $('#alerts-settings-monitoring-enabled').prop('checked', !!settings.monitoring_enabled);
  $('#alerts-settings-scheduler-interval').val(settings.monitoring_scheduler_interval || 15);
  $('#alerts-settings-max-dirs-per-pass').val(settings.monitoring_max_dirs_per_pass || 10);
  $('#alerts-settings-inter-scan-delay').val(settings.monitoring_inter_scan_delay_ms || 50);
}

export async function saveMonitoringSettings() {
  try {
    const settings = await window.electronAPI.getSettings();
    let schedulerInterval = parseInt($('#alerts-settings-scheduler-interval').val() || '15', 10);
    let maxDirsPerPass = parseInt($('#alerts-settings-max-dirs-per-pass').val() || '10', 10);
    let interScanDelay = parseInt($('#alerts-settings-inter-scan-delay').val() || '50', 10);

    if (Number.isNaN(schedulerInterval) || schedulerInterval < 5) schedulerInterval = 5;
    if (Number.isNaN(maxDirsPerPass) || maxDirsPerPass < 1) maxDirsPerPass = 1;
    if (Number.isNaN(interScanDelay) || interScanDelay < 0) interScanDelay = 0;

    settings.monitoring_enabled = $('#alerts-settings-monitoring-enabled').is(':checked');
    settings.monitoring_scheduler_interval = schedulerInterval;
    settings.monitoring_max_dirs_per_pass = maxDirsPerPass;
    settings.monitoring_inter_scan_delay_ms = interScanDelay;

    const result = await window.electronAPI.saveSettings(settings);
    if (!result || result.success === false) {
      throw new Error(result?.error || 'Unable to save monitoring settings');
    }

    if (settings.monitoring_enabled) {
      await window.electronAPI.startActiveMonitoring();
    } else {
      await window.electronAPI.stopActiveMonitoring();
    }
  } catch (err) {
    alert('Error saving monitoring settings: ' + err.message);
  }
}