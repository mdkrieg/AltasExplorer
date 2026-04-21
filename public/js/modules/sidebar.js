/**
 * Sidebar Module
 * Handles sidebar navigation, tree expansion, favorites, and sidebar collapse.
 * All function bodies are extracted verbatim from renderer.js.
 *
 * Exports consumed by renderer.js:
 *   initializeSidebar, updateSidebarSelection, addToFavorites,
 *   refreshFavoritesSidebar, toggleSidebarCollapse, handleSidebarLayoutResize,
 *   applySidebarDragWidth
 */

import { w2sidebar } from './vendor/w2ui.es6.min.js';
import { navigateToDirectory, visiblePanels, addPanel, setActivePanelId, setGridFocusedPanelId } from './panels.js';
import { hideCustomContextMenu } from './contexts.js';
import {
  panelState,
  sidebarState,
  selectedItemState,
  activePanelId,
  sidebarHasFocus,
  activateSidebarContext,
  setPreviouslyActivePanel,
  w2layoutInstance
} from '../renderer.js';

// ── Module-level state (private to this module) ────────────────────────────
// Sidebar arrow-key focus: 'toolbar' or 'sections', plus an index within that zone
let sidebarFocusZone = null; // null | 'toolbar' | 'sections'
let sidebarFocusIndex = -1;
let previouslyFocusedPanelId = 1;

let w2uiFavoritesSidebar = null;
let favIconMap = {};
let favEditMode = false;
let favoritesEditSnapshot = null;
let favRefreshDecorateTimer = null;
let sidebarCollapsed = false;
const SIDEBAR_COLLAPSED_WIDTH = 50;
const SIDEBAR_EXPANDED_MIN_WIDTH = 150;
let sidebarExpandedWidth = parseInt(localStorage.getItem('sidebarExpandedWidth') || localStorage.getItem('sidebarWidth') || '250');

// ── Private helpers ────────────────────────────────────────────────────────
function showInputPrompt(label, defaultValue = '') {
  return Promise.resolve(window.prompt(label, defaultValue));
}
function showConfirmPrompt(msg) {
  return Promise.resolve(window.confirm(msg));
}

function getSidebarMaxWidth() {
  return window.innerWidth - 300;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cloneFavoriteData(value) {
  return JSON.parse(JSON.stringify(value ?? []));
}

function isPlaceholderFavoriteNode(node) {
  return !!(node?.id && (node.id.startsWith('empty-') || node.id.startsWith('edit-')));
}

function visitFavoriteNodes(nodes, visitor) {
  if (!Array.isArray(nodes)) return;

  for (const node of nodes) {
    visitor(node);
    if (Array.isArray(node.nodes) && node.nodes.length > 0) {
      visitFavoriteNodes(node.nodes, visitor);
    }
  }
}

function getFavoriteItemNodes(nodes = w2uiFavoritesSidebar?.nodes || []) {
  const items = [];
  visitFavoriteNodes(nodes, node => {
    if (!node.group && !isPlaceholderFavoriteNode(node)) {
      items.push(node);
    }
  });
  return items;
}

function findFavoriteNodeLabel(node) {
  if (!node) return '';
  return node.text || node.path || '';
}

function setFavoriteItemsDisabled(disabled) {
  if (!w2uiFavoritesSidebar) return;

  const itemIds = getFavoriteItemNodes().map(node => node.id);
  if (itemIds.length === 0) return;

  if (disabled) {
    w2uiFavoritesSidebar.disable(...itemIds);
  } else {
    w2uiFavoritesSidebar.enable(...itemIds);
  }
}

function applyFavoriteTooltips() {
  const container = document.getElementById('w2ui-favorites');
  if (!container || !w2uiFavoritesSidebar) return;

  container.querySelectorAll('.w2ui-node, .w2ui-node-group').forEach(element => {
    const nodeId = element.dataset.id;
    if (!nodeId) return;

    const node = w2uiFavoritesSidebar.get(nodeId);
    if (!node || isPlaceholderFavoriteNode(node)) {
      element.removeAttribute('title');
      return;
    }

    const label = findFavoriteNodeLabel(node);
    if (label) {
      element.setAttribute('title', label);
    } else {
      element.removeAttribute('title');
    }
  });
}

function refreshFavoritesDom() {
  if (!w2uiFavoritesSidebar) return;

  w2uiFavoritesSidebar.refresh();
  applyFavoriteTooltips();

  if (favEditMode) {
    decorateFavoritesEditMode();
  }
}

function isFavoritePathPresent(dirPath) {
  const normalized = dirPath.replace(/\\/g, '/');
  let present = false;

  visitFavoriteNodes(w2uiFavoritesSidebar?.nodes || [], node => {
    if (present || node.group || isPlaceholderFavoriteNode(node)) return;
    if ((node.path || '').replace(/\\/g, '/') === normalized) {
      present = true;
    }
  });

  return present;
}

async function createFavoriteNode(dirPath, name = null) {
  const nodeId = `fav-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const safeId = nodeId.replace(/[^a-z0-9]/gi, '_');
  const iconClass = `fav_icon_${safeId}`;

  try {
    const [category, initials] = await Promise.all([
      window.electronAPI.getCategoryForDirectory(dirPath),
      window.electronAPI.getDirectoryInitials(dirPath)
    ]);
    const iconUrl = await window.electronAPI.generateFolderIcon(category.bgColor, category.textColor, initials || null);
    favIconMap[safeId] = iconUrl;
    updateFavoriteIconStyles();
  } catch (err) {
    // Ignore icon-generation failures and keep the default styling.
  }

  return {
    id: nodeId,
    text: name || dirPath.split(/[\\/]/).filter(Boolean).pop() || dirPath,
    icon: iconClass,
    path: dirPath,
    group: false
  };
}

function applyFavoritesHeaderState() {
  const btn = document.getElementById('btn-favorites-edit');
  if (!btn) return;

  if (favEditMode) {
    btn.innerHTML = '&#10003;';
    btn.title = 'Confirm changes';
    btn.classList.add('active');
  } else {
    btn.innerHTML = '&#9998;';
    btn.title = 'Edit favorites';
    btn.classList.remove('active');
  }
}

function setFavoriteNodePendingDelete(nodeId) {
  const node = w2uiFavoritesSidebar?.get(nodeId);
  if (!node || isPlaceholderFavoriteNode(node)) return;

  node.pendingDelete = true;
  if (!node.group) {
    w2uiFavoritesSidebar.disable(node.id);
  }

  refreshFavoritesDom();
}

function syncFavoriteDeleteInheritance(nodes = w2uiFavoritesSidebar?.nodes || [], inheritedDelete = false) {
  if (!Array.isArray(nodes)) return;

  for (const node of nodes) {
    if (isPlaceholderFavoriteNode(node)) continue;

    node.pendingDeleteInherited = inheritedDelete;

    if (Array.isArray(node.nodes) && node.nodes.length > 0) {
      syncFavoriteDeleteInheritance(node.nodes, inheritedDelete || !!node.pendingDelete);
    }
  }
}

function decorateFavoritesEditMode() {
  const container = document.getElementById('w2ui-favorites');
  if (!container || !w2uiFavoritesSidebar) return;

  syncFavoriteDeleteInheritance();

  container.querySelectorAll('.w2ui-node-group').forEach(groupEl => {
    const nodeId = groupEl.dataset.id;
    if (!nodeId) return;

    const node = w2uiFavoritesSidebar.get(nodeId);
    if (!node || !node.group || isPlaceholderFavoriteNode(node)) return;

    const isMarkedDeleted = !!(node.pendingDelete || node.pendingDeleteInherited);

    groupEl.classList.toggle('fav-node-pending-delete', isMarkedDeleted);

    const existingTextEl = groupEl.querySelector('.fav-group-edit-input, .fav-group-static-text, .w2ui-group-text');
    if (isMarkedDeleted) {
      if (!groupEl.querySelector('.fav-group-static-text')) {
        const staticText = document.createElement('span');
        staticText.className = 'w2ui-group-text fav-group-static-text';
        staticText.textContent = node.text;
        if (existingTextEl) {
          existingTextEl.replaceWith(staticText);
        } else {
          groupEl.appendChild(staticText);
        }
      }
    } else if (!groupEl.querySelector('.fav-group-edit-input') && !groupEl.querySelector('.btn-fav-rename-group')) {
      // Add rename button; input is created on demand when clicked
      const renameBtn = document.createElement('button');
      renameBtn.className = 'btn-fav-rename-group';
      renameBtn.innerHTML = '&#9998;';
      renameBtn.title = 'Rename group';
      renameBtn.dataset.nodeId = nodeId;
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (node.pendingDelete || node.pendingDeleteInherited) return;
        const textEl = groupEl.querySelector('.w2ui-group-text');
        const input = document.createElement('input');
        input.type = 'text';
        input.value = node.text;
        input.className = 'fav-group-edit-input';
        input.dataset.nodeId = nodeId;
        input.addEventListener('click', ev => ev.stopPropagation());
        input.addEventListener('keydown', ev => {
          if (ev.key === 'Enter') {
            void exitFavoritesEditMode({ saveChanges: true });
          }
          ev.stopPropagation();
        });
        if (textEl) {
          textEl.replaceWith(input);
        } else {
          groupEl.insertBefore(input, renameBtn);
        }
        renameBtn.remove();
        input.focus();
        input.select();
      });
      if (existingTextEl) {
        existingTextEl.after(renameBtn);
      } else {
        groupEl.appendChild(renameBtn);
      }
    }

    if (!groupEl.querySelector('.btn-fav-toggle-group')) {
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'btn-fav-toggle-group';
      toggleBtn.dataset.nodeId = nodeId;
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (node.pendingDelete || node.pendingDeleteInherited) return;
        w2uiFavoritesSidebar.toggle(nodeId);
        applyFavoriteTooltips();
        if (favEditMode) {
          decorateFavoritesEditMode();
        }
      });
      groupEl.appendChild(toggleBtn);
    }

    const toggleBtn = groupEl.querySelector('.btn-fav-toggle-group');
    if (toggleBtn) {
      const hasChildren = (node.nodes || []).some(child => !isPlaceholderFavoriteNode(child));
      toggleBtn.innerHTML = node.expanded ? '&#9660;' : '&#9654;';
      toggleBtn.title = node.expanded ? 'Collapse group' : 'Expand group';
      toggleBtn.disabled = isMarkedDeleted || !hasChildren;
    }

    if (!groupEl.querySelector('.btn-fav-delete-group')) {
      const trashBtn = document.createElement('button');
      trashBtn.className = 'btn-fav-delete-group';
      trashBtn.innerHTML = '&#128465;';
      trashBtn.title = 'Delete group';
      trashBtn.dataset.nodeId = nodeId;
      trashBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setFavoriteNodePendingDelete(nodeId);
      });
      groupEl.appendChild(trashBtn);
    }

    const groupDeleteBtn = groupEl.querySelector('.btn-fav-delete-group');
    if (groupDeleteBtn) {
      groupDeleteBtn.disabled = isMarkedDeleted;
    }
  });

  container.querySelectorAll('.w2ui-node:not(.w2ui-node-group)').forEach(itemEl => {
    const nodeId = itemEl.dataset.id;
    if (!nodeId || nodeId.startsWith('empty-') || nodeId.startsWith('edit-')) return;

    const node = w2uiFavoritesSidebar.get(nodeId);
    if (!node || node.group) return;

  const isMarkedDeleted = !!(node.pendingDelete || node.pendingDeleteInherited);

  itemEl.classList.toggle('fav-node-pending-delete', isMarkedDeleted);

    if (!itemEl.querySelector('.btn-fav-delete-fav')) {
      const trashBtn = document.createElement('button');
      trashBtn.className = 'btn-fav-delete-fav';
      trashBtn.innerHTML = '&#128465;';
      trashBtn.title = 'Delete favorite';
      trashBtn.dataset.nodeId = nodeId;
      trashBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setFavoriteNodePendingDelete(nodeId);
      });
      itemEl.appendChild(trashBtn);
    }

    const itemDeleteBtn = itemEl.querySelector('.btn-fav-delete-fav');
    if (itemDeleteBtn) {
      itemDeleteBtn.disabled = isMarkedDeleted;
    }
  });
}

function resizeSidebarGrids() {
  for (let panelId = 1; panelId <= 4; panelId++) {
    const grid = panelState[panelId].w2uiGrid;
    if (grid) grid.resize();
  }
}

function syncSidebarCollapsedUi() {
  const $sidebar = $('#sidebar-content');
  const $btn = $('#btn-sidebar-collapse');

  if (sidebarCollapsed) {
    if (favEditMode) {
      void exitFavoritesEditMode({ saveChanges: false });
    }
    $sidebar.addClass('sidebar-collapsed');
    $btn.find('.sidebar-icon-collapse').hide();
    $btn.find('.sidebar-icon-expand').show();
    $btn.attr('title', 'Expand sidebar');
  } else {
    $sidebar.removeClass('sidebar-collapsed');
    $btn.find('.sidebar-icon-collapse').show();
    $btn.find('.sidebar-icon-expand').hide();
    $btn.attr('title', 'Collapse sidebar');
  }
}

function resolveSidebarWidth(rawWidth) {
  const clampedWidth = Math.max(SIDEBAR_COLLAPSED_WIDTH, Math.min(getSidebarMaxWidth(), rawWidth));

  if (sidebarCollapsed) {
    if (clampedWidth >= SIDEBAR_EXPANDED_MIN_WIDTH) {
      return {
        collapsed: false,
        width: clampedWidth
      };
    }

    return {
      collapsed: true,
      width: SIDEBAR_COLLAPSED_WIDTH
    };
  }

  if (clampedWidth <= SIDEBAR_COLLAPSED_WIDTH) {
    return {
      collapsed: true,
      width: SIDEBAR_COLLAPSED_WIDTH
    };
  }

  if (clampedWidth < SIDEBAR_EXPANDED_MIN_WIDTH) {
    return {
      collapsed: false,
      width: SIDEBAR_EXPANDED_MIN_WIDTH
    };
  }

  return {
    collapsed: false,
    width: clampedWidth
  };
}

function setSidebarWidth(width, collapsed) {
  const currentWidth = w2layoutInstance.get('left').size;
  sidebarCollapsed = collapsed;

  if (!collapsed) {
    sidebarExpandedWidth = width;
    localStorage.setItem('sidebarWidth', width);
    localStorage.setItem('sidebarExpandedWidth', width);
  }

  syncSidebarCollapsedUi();

  if (currentWidth !== width) {
    w2layoutInstance.set('left', { size: width });
    w2layoutInstance.resize();
  }

  resizeSidebarGrids();
}

export function applySidebarDragWidth(rawWidth) {
  const resolved = resolveSidebarWidth(rawWidth);
  setSidebarWidth(resolved.width, resolved.collapsed);
  return resolved.width;
}

export function handleSidebarLayoutResize(rawWidth) {
  const resolved = resolveSidebarWidth(rawWidth);
  setSidebarWidth(resolved.width, resolved.collapsed);
}

// ── Sidebar tree functions ─────────────────────────────────────────────────

/**
 * Initialize sidebar with favorites
 */
export async function initializeSidebar() {
  try {
    console.log('Initializing sidebar...');

    // Initialize W2UI favorites sidebar
    await initializeFavoritesSidebar();

    // Initialize stackable sidebar sections (expand/collapse + persistence)
    initializeSidebarSections();

    console.log('Sidebar initialized');
  } catch (err) {
    console.error('Error initializing sidebar:', err);
  }
}

// ── Stackable Sidebar Sections ────────────────────────────────────────────

const SECTION_EXPAND_CALLBACKS = new Map();

/**
 * Register a callback to run whenever a section transitions to expanded.
 * Used by module-specific renderers (e.g. TODO) to lazily populate on expand.
 */
export function onSidebarSectionExpanded(sectionName, callback) {
  SECTION_EXPAND_CALLBACKS.set(sectionName, callback);
}

function getExpandedSectionsSet() {
  if (!(sidebarState.expandedSections instanceof Set)) {
    sidebarState.expandedSections = new Set(Array.isArray(sidebarState.expandedSections) ? sidebarState.expandedSections : ['favorites']);
  }
  return sidebarState.expandedSections;
}

async function persistExpandedSections() {
  try {
    const settings = await window.electronAPI.getSettings();
    settings.sidebarExpandedSections = Array.from(getExpandedSectionsSet());
    await window.electronAPI.saveSettings(settings);
  } catch (err) {
    console.warn('Failed to persist expanded sections:', err);
  }
}

async function loadExpandedSectionsFromSettings() {
  try {
    const settings = await window.electronAPI.getSettings();
    const stored = settings.sidebarExpandedSections;
    if (Array.isArray(stored)) {
      sidebarState.expandedSections = new Set(stored);
    } else {
      sidebarState.expandedSections = new Set(['favorites']);
    }
  } catch (err) {
    sidebarState.expandedSections = new Set(['favorites']);
  }
}

function applySectionCollapsedState(section) {
  const name = section.dataset.section;
  const expanded = getExpandedSectionsSet().has(name);
  section.classList.toggle('collapsed', !expanded);
  const chevron = section.querySelector('.sidebar-section-chevron');
  if (chevron) chevron.innerHTML = expanded ? '&#9660;' : '&#9654;';
}

async function toggleSidebarSection(sectionName) {
  const expanded = getExpandedSectionsSet();
  const wasExpanded = expanded.has(sectionName);

  if (wasExpanded) {
    // Favorites: exit edit mode before collapsing so we don't leave stray edit UI.
    if (sectionName === 'favorites' && favEditMode) {
      await exitFavoritesEditMode({ saveChanges: true });
    }
    expanded.delete(sectionName);
  } else {
    expanded.add(sectionName);
  }

  const section = document.querySelector(`.sidebar-section[data-section="${sectionName}"]`);
  if (section) applySectionCollapsedState(section);

  await persistExpandedSections();

  if (!wasExpanded) {
    const cb = SECTION_EXPAND_CALLBACKS.get(sectionName);
    if (cb) {
      try { await cb(); } catch (err) { console.warn(`Section ${sectionName} expand callback failed:`, err); }
    }
  }
}

async function initializeSidebarSections() {
  await loadExpandedSectionsFromSettings();

  const container = document.getElementById('sidebar-sections');
  if (!container) return;

  container.querySelectorAll('.sidebar-section').forEach(applySectionCollapsedState);

  container.addEventListener('click', (e) => {
    const toggleEl = e.target.closest('[data-section-toggle]');
    if (!toggleEl) return;
    const header = e.target.closest('.sidebar-section-header');
    if (!header) return;
    e.stopPropagation();
    const sectionName = toggleEl.dataset.sectionToggle;
    if (sectionName) void toggleSidebarSection(sectionName);
  });

  // Fire expand callbacks for any sections that start expanded (e.g. TODO) so they
  // populate on app start without requiring a user click.
  for (const sectionName of getExpandedSectionsSet()) {
    const cb = SECTION_EXPAND_CALLBACKS.get(sectionName);
    if (cb) {
      try { await cb(); } catch (err) { console.warn(`Section ${sectionName} expand callback failed:`, err); }
    }
  }
}

/**
 * Create a sidebar item for a directory
 */
function createSidebarDirectoryItem(dirName, dirPath, level = 0) {
  const $item = $('<div>')
    .addClass('sidebar-item')
    .addClass(`sidebar-item-indent-${Math.min(level, 5)}`)
    .attr('data-path', dirPath)
    .attr('data-isDirectory', 'true')
    .attr('data-expanded', 'false');

  // Toggle arrow (will be hidden if no children, determined on first expand)
  const $arrow = $('<div>')
    .addClass('sidebar-toggle-arrow collapsed')
    .text('▶');

  // Directory label
  const $label = $('<div>')
    .addClass('sidebar-item-label')
    .text(dirName)
    .attr('title', dirPath);

  $item.append($arrow, $label);

  return $item;
}

/**
 * Load and expand children for a sidebar item
 */
async function loadSidebarItemChildren(path, $item) {
  try {
    // Check if already loaded
    const $children = $item.next('.sidebar-children');
    if ($children.length > 0) {
      return; // Already loaded
    }

    // Get directory contents
    const entries = await window.electronAPI.readDirectory(path);

    // Filter to only directories
    const directories = entries.filter(e => e.isDirectory);

    // If no directories, exit
    if (directories.length === 0) {
      // Update arrow to show no children
      $item.find('.sidebar-toggle-arrow').addClass('no-children');
      return;
    }

    // Create children container
    const $childrenContainer = $('<div>').addClass('sidebar-children');

    // Get current level from indentation class
    const levelMatch = $item.attr('class').match(/sidebar-item-indent-(\d+)/);
    let currentLevel = levelMatch ? parseInt(levelMatch[1]) : 0;
    const childLevel = currentLevel + 1;

    // Create items for each subdirectory
    for (const dir of directories) {
      const $childItem = createSidebarDirectoryItem(dir.filename, dir.path, childLevel);
      $childrenContainer.append($childItem);
    }

    // Insert children container after the item
    $item.after($childrenContainer);

    // Update arrow to show has children
    $item.find('.sidebar-toggle-arrow').removeClass('no-children');

    console.log(`Loaded ${directories.length} subdirectories for ${path}`);
  } catch (err) {
    console.error('Error loading sidebar item children:', err);
  }
}

/**
 * Toggle expansion of a sidebar item
 */
async function toggleSidebarItemExpansion($item) {
  const isExpanded = $item.attr('data-expanded') === 'true';
  const path = $item.attr('data-path');

  if (isExpanded) {
    // Collapse
    collapseSidebarItem($item);
  } else {
    // Expand - load children if not already loaded
    await expandSidebarItem($item, path);
  }
}

/**
 * Expand a sidebar item and show its children
 */
async function expandSidebarItem($item, path) {
  // Load children if not loaded yet
  await loadSidebarItemChildren(path, $item);

  // Show children container
  const $children = $item.next('.sidebar-children');
  if ($children.length > 0) {
    $children.show();
  }

  // Update arrow and state
  $item.attr('data-expanded', 'true');
  $item.find('.sidebar-toggle-arrow').removeClass('collapsed').text('▼');
}

/**
 * Collapse a sidebar item and hide its children
 */
function collapseSidebarItem($item) {
  // Hide children container
  const $children = $item.next('.sidebar-children');
  if ($children.length > 0) {
    $children.hide();
  }

  // Update arrow and state
  $item.attr('data-expanded', 'false');
  $item.find('.sidebar-toggle-arrow').addClass('collapsed').text('▶');
}

/**
 * Update sidebar selection to highlight a path
 */
export function updateSidebarSelection(path) {
  // Remove selection from all items
  $('.sidebar-item').removeClass('sidebar-item-selected');

  // Add selection to matching path
  if (path) {
    $(`.sidebar-item[data-path="${path}"]`).addClass('sidebar-item-selected');
    sidebarState.selectedPath = path;
  }
}

/**
 * Attach event listeners to sidebar items
 */
function attachSidebarEventListeners() {
  // Delegate click events for dynamic items
  $('#sidebar-tree').on('click', '.sidebar-toggle-arrow', function (e) {
    e.stopPropagation();
    const $item = $(this).closest('.sidebar-item');
    toggleSidebarItemExpansion($item);
  });

  // Double-click to navigate to previously focused panel
  $('#sidebar-tree').on('dblclick', '.sidebar-item-label', function (e) {
    e.stopPropagation();
    const $item = $(this).closest('.sidebar-item');
    const path = $item.attr('data-path');

    if (path) {
      navigateToDirectory(path, previouslyFocusedPanelId);
      updateSidebarSelection(path);
      setActivePanelId(previouslyFocusedPanelId);
      setGridFocusedPanelId(previouslyFocusedPanelId);
    }
  });

  // Single click to select and unify with keyboard focus style
  $('#sidebar-tree').on('click', '.sidebar-item-label', function (e) {
    e.stopPropagation();
    const $item = $(this).closest('.sidebar-item');
    const path = $item.attr('data-path');

    if (path) {
      // Capture previously focused panel when sidebar wasn't yet focused
      if (!sidebarHasFocus) {
        previouslyFocusedPanelId = activePanelId || 1;
        activateSidebarContext(previouslyFocusedPanelId);
      }
      updateSidebarSelection(path);
      // Move sidebar-arrow-focused to the clicked item
      const items = getVisibleSectionItems();
      const idx = items.findIndex(item => item.type === 'sidebar-item' && item.el === $item[0]);
      if (idx !== -1) {
        sidebarFocusZone = 'sections';
        sidebarFocusIndex = idx;
        applySidebarArrowFocus();
      }
      // Move DOM focus to the sidebar container so keydown events bypass
      // any child-element keyboard handlers.
      document.getElementById('sidebar-content')?.focus({ preventScroll: true });
    }
  });
}

// ── Favorites (W2UI Sidebar) ───────────────────────────────────────────────

/**
 * Initialize W2UI Favorites Sidebar
 */
async function initializeFavoritesSidebar() {
  try {
    // Wait for DOM to be ready
    await new Promise(resolve => {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', resolve);
      } else {
        resolve();
      }
    });

    // Debug: check DOM element
    const boxElement = document.getElementById('w2ui-favorites');
    console.log('[DEBUG] w2ui-favorites element exists:', !!boxElement);
    if (!boxElement) {
      console.warn('[DEBUG] w2ui-favorites element NOT FOUND in DOM');
      return;
    }

    // Check for w2sidebar class (proper w2ui naming in v2.0)
    if (typeof w2sidebar === 'undefined') {
      console.error('[DEBUG] w2sidebar class not found - w2ui may not have loaded');
      console.log('[DEBUG] Checking global scope for sidebar...',
        Object.keys(window).filter(k => k.toLowerCase().includes('sidebar')).slice(0, 5));
      return;
    }

    // Load existing favorites
    const favorites = await loadFavoritesFromSettings();
    console.log('[DEBUG] Loaded favorites:', JSON.stringify(favorites).substring(0, 200));

    // Convert to w2ui node format
    const nodes = await convertFavoritesToW2UINodes(favorites);
    console.log('[DEBUG] Converted to W2UI nodes count:', nodes.length);
    if (nodes.length > 0) {
      console.log('[DEBUG] First node:', JSON.stringify(nodes[0]).substring(0, 150));
    }

    console.log('Initializing W2UI favorites sidebar with', nodes.length, 'nodes');

    // Initialize w2ui sidebar using the w2sidebar class
    // (The favorites header row lives outside the w2ui container now — see index.html.)
    w2uiFavoritesSidebar = new w2sidebar({
      box: '#w2ui-favorites',
      name: 'favorites-sidebar',
      reorder: true,
      keyboard: false,
      nodes: nodes,
      onClick: async (event) => {
        if (event.target === 'edit-AddGroup') {
          event.preventDefault();
          await addGroupInEditMode();
          return;
        }
        if (event.target === 'edit-AddFav') {
          event.preventDefault();
          await addFavoritesFromSelection();
          return;
        }
        // Single click: select only (no navigation), unify with keyboard focus style
        if (favEditMode) return;
        const node = w2uiFavoritesSidebar.get(event.target);
        if (!node || node.group || node.disabled) return;

        // Capture previously focused panel when sidebar wasn't yet focused
        if (!sidebarHasFocus) {
          previouslyFocusedPanelId = activePanelId || 1;
          activateSidebarContext(previouslyFocusedPanelId);
        }

        // Move sidebar-arrow-focused to the clicked node
        const items = getVisibleSectionItems();
        const idx = items.findIndex(item => item.type === 'fav-item' && item.el.dataset?.id === String(node.id));
        if (idx !== -1) {
          sidebarFocusZone = 'sections';
          sidebarFocusIndex = idx;
          applySidebarArrowFocus();
        }

        // Move DOM focus to the sidebar container so keydown events bubble to document
        // without being intercepted by w2ui's child-element keyboard handlers.
        document.getElementById('sidebar-content')?.focus({ preventScroll: true });

        // Suppress w2ui's own selection highlight
        setTimeout(() => {
          if (w2uiFavoritesSidebar) w2uiFavoritesSidebar.unselect(event.target);
        }, 0);
      },
      onContextMenu: (event) => {
        event.preventDefault();
        const node = w2uiFavoritesSidebar.get(event.target);
        if (node) {
          const origEvent = event.detail?.originalEvent ?? event;
          showFavoritesContextMenu(origEvent.clientX, origEvent.clientY, node.group ? 'group' : 'item', node);
        }
      },
      onRefresh(event) {
        if (!favEditMode) return;
        const orig = event.onComplete;
        event.onComplete = () => {
          if (orig) orig.call(this, event);
          clearTimeout(favRefreshDecorateTimer);
          favRefreshDecorateTimer = setTimeout(() => {
            if (favEditMode) decorateFavoritesEditMode();
          }, 0);
        };
      },
      onDragStart(event) {
        if (!favEditMode || event.detail.node.id.startsWith("empty-")) {
          event.preventDefault()
        }
      },
      onDragOver(event) {
        return;
      },
      onReorder(event) {
        // The groups can't be dragged into if they're empty (or at least I can't figure it out)
        // So we add a temporary "empty" node to any group that would become empty
        // It gets a little complicated because this triggers before the reorder is finalized in the nodes list
        let removeNodes = [];
        for (const node of this.nodes) {
          if (!node.group) continue;
          const empty_id = `empty-${node.id}`;
          const hasEmptyNode = node.nodes.some(n => n.id.startsWith("empty-"));
          let realNodesCount = node.nodes.filter(n => !n.id.startsWith("empty-") && n.id !== event.target).length;
          if (event.detail.moveBefore && event.detail.moveBefore == empty_id) {
            realNodesCount += 1;
          }
          if (realNodesCount === 0 && !hasEmptyNode) {
            this.insert(node.id, null, [{ id: empty_id, text: '(empty)' }]);
            this.disable(empty_id)
          } else if (hasEmptyNode && realNodesCount > 0) {
            removeNodes.push(empty_id);
          }
        }
        // this has to come last, no removing nodes while looping them
        event.complete.then(() => {
          for (const nodeId of removeNodes) {
            this.remove(nodeId);
          }
        });
      }
    });

    // Double-click on a favorites item navigates to the previously focused panel
    $('#w2ui-favorites').on('dblclick', '.w2ui-node', function () {
      if (favEditMode) return;
      const nodeId = this.dataset?.id;
      if (!nodeId) return;
      const node = w2uiFavoritesSidebar?.get(nodeId);
      if (node && node.path && !node.disabled) {
        navigateToDirectory(node.path, previouslyFocusedPanelId);
        setActivePanelId(previouslyFocusedPanelId);
        setGridFocusedPanelId(previouslyFocusedPanelId);
      }
    });

    // Attach edit button handler using event delegation on the favorites section header
    const favoritesSection = document.querySelector('.sidebar-section[data-section="favorites"]');
    if (favoritesSection) {
      favoritesSection.addEventListener('click', async (e) => {
        if (e.target.closest('#btn-favorites-cancel')) {
          e.stopPropagation();
          await exitFavoritesEditMode({ saveChanges: false });
          return;
        }
        if (e.target.closest('#btn-favorites-edit')) {
          e.stopPropagation();
          await toggleFavoritesEditMode();
        }
      });
    }

    // Disable any (empty) placeholder nodes that were loaded from saved state
    visitFavoriteNodes(w2uiFavoritesSidebar.nodes, node => {
      if (node.id?.startsWith('empty-')) w2uiFavoritesSidebar.disable(node.id);
    });

    applyFavoriteTooltips();
    applyFavoritesHeaderState();

    console.log('W2UI favorites sidebar initialized successfully');
  } catch (err) {
    console.error('Error initializing favorites sidebar:', err);
  }
}

/**
 * Convert favorites array to w2ui node format
 */
async function convertFavoritesToW2UINodes(favorites, groupPath = []) {
  if (!Array.isArray(favorites)) return [];

  // Reset icon map at top level only
  if (groupPath.length === 0) favIconMap = {};

  const nodes = [];

  for (let i = 0; i < favorites.length; i++) {
    const fav = favorites[i];
    const nodeId = `fav-${groupPath.join('-')}-${i}`;

    if (fav.type === 'group') {
      // Groups use a standard folder icon class
      const groupNodes = await convertFavoritesToW2UINodes(fav.items || [], [...groupPath, i]);
      nodes.push({
        id: nodeId,
        text: fav.name,
        icon: 'fav-icon-group',
        group: true,
        expanded: !fav.collapsed,
        nodes: groupNodes.length > 0 ? groupNodes : [{ id: `empty-${nodeId}`, text: '(empty)' }]
      });
    } else {
      // Fetch the category-styled folder icon for this path
      const safeId = nodeId.replace(/[^a-z0-9]/gi, '_');
      const iconClass = `fav_icon_${safeId}`;
      try {
        const [category, initials] = await Promise.all([
          window.electronAPI.getCategoryForDirectory(fav.path),
          window.electronAPI.getDirectoryInitials(fav.path)
        ]);
        const iconUrl = await window.electronAPI.generateFolderIcon(category.bgColor, category.textColor, initials || null);
        favIconMap[safeId] = iconUrl;
      } catch (err) {
        // fallback – no entry means the default CSS will apply
      }

      const name = fav.name || fav.path.split(/[\\/]/).filter(Boolean).pop() || fav.path;
      nodes.push({
        id: nodeId,
        text: name,
        icon: iconClass,
        path: fav.path,
        group: false
      });
    }
  }

  // Rebuild the dynamic icon stylesheet at top level
  if (groupPath.length === 0) {
    updateFavoriteIconStyles();
  }

  return nodes;
}

/**
 * Build/update the <style> element that maps fav_icon_* classes to their data URLs
 */
function updateFavoriteIconStyles() {
  let styleEl = document.getElementById('fav-node-icon-styles');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'fav-node-icon-styles';
    document.head.appendChild(styleEl);
  }
  const css = Object.entries(favIconMap).map(([safeId, iconUrl]) => {
    return `.w2ui-node-image span.fav_icon_${safeId} {
      background-image: url('${iconUrl}');
      background-size: cover;
      background-repeat: no-repeat;
      background-position: center;
      width: 16px;
      height: 16px;
      display: inline-block;
    }`;
  }).join('\n');
  styleEl.textContent = css;
}

/**
 * Persist W2UI sidebar nodes back to favorites format
 */
async function persistW2UINodes() {
  if (!w2uiFavoritesSidebar) return;

  const nodes = w2uiFavoritesSidebar.nodes;
  const favorites = convertW2UINodesToFavorites(nodes);

  await saveFavoritesToSettings(favorites);
}

/**
 * Convert w2ui nodes back to favorites format
 */
function convertW2UINodesToFavorites(nodes, groupPath = []) {
  if (!Array.isArray(nodes)) return [];

  const favorites = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    // Skip placeholder nodes (empty items and edit controls)
    if (isPlaceholderFavoriteNode(node) || node.pendingDelete) {
      continue;
    }

    if (node.group) {
      // Convert to group
      favorites.push({
        type: 'group',
        name: node.text,
        collapsed: !node.expanded,
        items: convertW2UINodesToFavorites(node.nodes || [], [...groupPath, i])
      });
    } else {
      // Convert to favorite item
      favorites.push({
        type: 'favorite',
        path: node.path,
        name: node.text
      });
    }
  }

  return favorites;
}

/**
 * Load favorites array from settings (with migration support)
 */
async function loadFavoritesFromSettings() {
  try {
    const settings = await window.electronAPI.getSettings();
    let favorites = Array.isArray(settings.favorites) ? settings.favorites : [];

    // Apply migration if needed
    favorites = migrateFavoritesToGroupFormat(favorites);

    // If this was an old format, save the migrated version
    if (favorites.length > 0 && !settings.favorites[0]?.type) {
      settings.favorites = favorites;
      await window.electronAPI.saveSettings(settings);
    }

    return favorites;
  } catch (err) {
    console.error('Error loading favorites:', err);
    return [];
  }
}

/**
 * Save favorites array to settings
 */
async function saveFavoritesToSettings(favorites) {
  try {
    const settings = await window.electronAPI.getSettings();
    settings.favorites = favorites;
    await window.electronAPI.saveSettings(settings);
  } catch (err) {
    console.error('Error saving favorites:', err);
  }
}

/**
 * Migrate old flat favorites array to new hierarchical format with groups
 */
function migrateFavoritesToGroupFormat(oldFavorites) {
  if (!Array.isArray(oldFavorites)) return [];

  // If already migrated (has type field), return as-is
  if (oldFavorites.length > 0 && oldFavorites[0].type) {
    return oldFavorites;
  }

  // Convert old format to new format (all as root-level favorites)
  return oldFavorites.map(fav => ({
    type: 'favorite',
    path: fav.path,
    name: fav.name
  }));
}

/**
 * Add a directory path to favorites
 */
export async function addToFavorites(dirPath) {
  const favorites = await loadFavoritesFromSettings();
  const normalized = dirPath.replace(/\\/g, '/');

  // Check for duplicates
  const isDuplicate = (items) => {
    return items.some(item => {
      if (item.path?.replace(/\\/g, '/') === normalized) return true;
      if (item.items) return isDuplicate(item.items);
      return false;
    });
  };

  if (!isDuplicate(favorites)) {
    const name = dirPath.split(/[\\/]/).filter(Boolean).pop() || dirPath;
    favorites.push({
      type: 'favorite',
      path: dirPath,
      name: name
    });

    await saveFavoritesToSettings(favorites);
    await refreshFavoritesSidebar();
  }
}

/**
 * Remove a path from favorites
 */
async function removeFromFavorites(dirPath) {
  const favorites = await loadFavoritesFromSettings();
  const normalized = dirPath.replace(/\\/g, '/');

  const filterItems = (items) => {
    return items.filter(item => {
      if (item.type === 'favorite') {
        return item.path?.replace(/\\/g, '/') !== normalized;
      } else if (item.type === 'group') {
        item.items = filterItems(item.items || []);
      }
      return true;
    });
  };

  const updated = filterItems(favorites);
  await saveFavoritesToSettings(updated);
  await refreshFavoritesSidebar();
}

/**
 * Refresh the favorites sidebar
 */
export async function refreshFavoritesSidebar() {
  try {
    const favorites = await loadFavoritesFromSettings();
    const nodes = await convertFavoritesToW2UINodes(favorites);

    if (w2uiFavoritesSidebar) {
      w2uiFavoritesSidebar.nodes = nodes;
      refreshFavoritesDom();
    }
  } catch (err) {
    console.error('Error refreshing favorites sidebar:', err);
  }
}

/**
 * Show modal to add a new group
 */
async function showAddGroupPrompt() {
  const groupName = await showInputPrompt('Enter group name:', '');
  if (groupName && groupName.trim()) {
    await createGroup(groupName.trim());
  }
}

/**
 * Create a new group
 */
async function createGroup(name) {
  const favorites = await loadFavoritesFromSettings();
  favorites.push({
    type: 'group',
    name: name,
    collapsed: false,
    items: []
  });
  await saveFavoritesToSettings(favorites);
  await refreshFavoritesSidebar();
}

/**
 * Rename a group
 */
async function renameGroup(node, newName) {
  if (!node || !node.group) return;

  const favorites = await loadFavoritesFromSettings();

  // Find and update the group
  const updateGroup = (items) => {
    for (let item of items) {
      if (item.name === node.text && item.type === 'group') {
        item.name = newName;
        return true;
      }
      if (item.items && updateGroup(item.items)) return true;
    }
    return false;
  };

  if (updateGroup(favorites)) {
    await saveFavoritesToSettings(favorites);
    await refreshFavoritesSidebar();
  }
}

/**
 * Delete a group
 */
async function deleteGroup(node) {
  if (!node || !node.group) return;

  const hasItems = node.nodes && node.nodes.length > 0;
  let shouldDelete = false;

  if (hasItems) {
    const confirmed = await showConfirmPrompt(
      `Delete group "${node.text}"? This group contains ${node.nodes.length} item(s) which will be discarded.`
    );
    shouldDelete = confirmed;
  } else {
    shouldDelete = await showConfirmPrompt(`Delete group "${node.text}"?`);
  }

  if (shouldDelete) {
    const favorites = await loadFavoritesFromSettings();

    const removeGroup = (items) => {
      const index = items.findIndex(item => item.name === node.text && item.type === 'group');
      if (index !== -1) {
        items.splice(index, 1);
        return true;
      }
      for (let item of items) {
        if (item.items && removeGroup(item.items)) return true;
      }
      return false;
    };

    if (removeGroup(favorites)) {
      await saveFavoritesToSettings(favorites);
      await refreshFavoritesSidebar();
    }
  }
}

/**
 * Show the favorites context menu using the shared custom-ctx-menu style.
 */
function showFavoritesContextMenu(x, y, targetType = 'item', node = null) {
  hideCustomContextMenu();

  const menu = document.createElement('div');
  menu.id = 'custom-ctx-menu';
  menu.className = 'custom-ctx-menu';

  const addRow = (text, action, extraClass = '') => {
    const row = document.createElement('div');
    row.className = 'custom-ctx-item' + (extraClass ? ' ' + extraClass : '');
    const label = document.createElement('span');
    label.className = 'custom-ctx-label';
    label.textContent = text;
    row.appendChild(label);
    row.addEventListener('mouseenter', () => {
      menu.querySelectorAll('.custom-ctx-item').forEach(r => r.classList.remove('active'));
      row.classList.add('active');
    });
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      hideCustomContextMenu();
      action();
    });
    menu.appendChild(row);
  };

  const addSeparator = () => {
    const sep = document.createElement('div');
    sep.className = 'custom-ctx-separator';
    menu.appendChild(sep);
  };

  if (targetType === 'item' && node) {
    // One top-level entry per visible panel
    for (let i = 1; i <= visiblePanels; i++) {
      const panelId = i;
      addRow(`Open in Panel ${panelId}`, async () => {
        if (node.path) {
          await navigateToDirectory(node.path, panelId);
          setActivePanelId(panelId);
          setGridFocusedPanelId(panelId);
        }
      });
    }
    // N+1: open a new panel (capped at 4)
    if (visiblePanels < 4) {
      const newPanelId = visiblePanels + 1;
      addRow(`Open in new Panel ${newPanelId}`, async () => {
        if (node.path) {
          const created = addPanel();
          const targetId = created ?? newPanelId;
          await navigateToDirectory(node.path, targetId);
          setActivePanelId(targetId);
          setGridFocusedPanelId(targetId);
        }
      });
    }
    addSeparator();
    addRow('Remove from Favorites', async () => {
      if (node.path) await removeFromFavorites(node.path);
    }, 'custom-ctx-item-danger');
  } else if (targetType === 'group' && node) {
    addRow('Rename', async () => {
      const newName = await showInputPrompt('Enter new group name:', node.text);
      if (newName && newName.trim()) await renameGroup(node, newName.trim());
    });
    addRow('Delete', async () => {
      await deleteGroup(node);
    }, 'custom-ctx-item-danger');
  }

  if (!menu.children.length) return;

  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);

  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';
  });

  const onOutside = (e) => {
    if (!e.target.closest?.('#custom-ctx-menu')) {
      hideCustomContextMenu();
      document.removeEventListener('click', onOutside);
      document.removeEventListener('keydown', onEsc);
    }
  };
  const onEsc = (e) => {
    if (e.key === 'Escape') {
      hideCustomContextMenu();
      document.removeEventListener('click', onOutside);
      document.removeEventListener('keydown', onEsc);
    }
  };
  document.addEventListener('click', onOutside);
  document.addEventListener('keydown', onEsc);
}

// ── Favorites Edit Mode ────────────────────────────────────────────────────

function toggleFavoritesEditMode() {
  if (favEditMode) {
    return exitFavoritesEditMode({ saveChanges: true });
  } else {
    return enterFavoritesEditMode();
  }
}

function enterFavoritesEditMode() {
  if (!w2uiFavoritesSidebar) return;

  if (!favEditMode) {
    favoritesEditSnapshot = cloneFavoriteData(convertW2UINodesToFavorites(w2uiFavoritesSidebar.nodes));
  }

  favEditMode = true;
  $("#w2ui-favorites").addClass('edit-mode');
  $('.sidebar-section[data-section="favorites"]').addClass('edit-mode');

  if (!w2uiFavoritesSidebar.get('edit-AddGroup')) {
    w2uiFavoritesSidebar.add([
      { id: 'edit-AddGroup', text: 'Add Group', icon: 'w2ui-icon-plus' },
      { id: 'edit-AddFav', text: 'Add Favorite', icon: 'w2ui-icon-plus' }
    ]);
  }

  applyFavoritesHeaderState();
  refreshFavoritesDom();
}

async function exitFavoritesEditMode({ saveChanges = true } = {}) {
  if (!w2uiFavoritesSidebar) return;

  favEditMode = false;
  $("#w2ui-favorites").removeClass('edit-mode');
  $('.sidebar-section[data-section="favorites"]').removeClass('edit-mode');

  const container = document.getElementById('w2ui-favorites');
  if (!container) return;

  if (saveChanges) {
    container.querySelectorAll('.fav-group-edit-input').forEach(input => {
      const nodeId = input.dataset.nodeId;
      if (!nodeId) return;
      const node = w2uiFavoritesSidebar.get(nodeId);
      if (node && input.value.trim()) {
        node.text = input.value.trim();
      }
    });
  } else if (favoritesEditSnapshot) {
    w2uiFavoritesSidebar.nodes = await convertFavoritesToW2UINodes(cloneFavoriteData(favoritesEditSnapshot));
  }

  container.querySelectorAll('.fav-group-edit-input').forEach(input => {
    const nodeId = input.dataset.nodeId;
    const node = nodeId ? w2uiFavoritesSidebar.get(nodeId) : null;
    const span = document.createElement('span');
    span.className = 'w2ui-group-text';
    span.textContent = node ? node.text : input.value;
    input.replaceWith(span);
  });

  container.querySelectorAll('.fav-group-static-text').forEach(staticText => {
    if (!staticText.classList.contains('w2ui-group-text')) {
      staticText.classList.add('w2ui-group-text');
    }
  });

  container.querySelectorAll('.btn-fav-delete-group').forEach(trashBtn => trashBtn.remove());
  container.querySelectorAll('.btn-fav-delete-fav').forEach(trashBtn => trashBtn.remove());
  container.querySelectorAll('.btn-fav-toggle-group').forEach(toggleBtn => toggleBtn.remove());
  container.querySelectorAll('.btn-fav-rename-group').forEach(renameBtn => renameBtn.remove());

  w2uiFavoritesSidebar.remove('edit-AddGroup', 'edit-AddFav');

  if (saveChanges) {
    await persistW2UINodes();
    favoritesEditSnapshot = null;
    await refreshFavoritesSidebar();
  } else {
    favoritesEditSnapshot = null;
    refreshFavoritesDom();
  }

  applyFavoritesHeaderState();
}

async function addGroupInEditMode() {
  if (!w2uiFavoritesSidebar) return;
  const newId = `group-${Date.now()}`;
  w2uiFavoritesSidebar.insert(null, 'edit-AddGroup', [{
    id: newId,
    text: 'New Group',
    icon: 'fav-icon-group',
    group: true,
    expanded: true,
    nodes: [{ id: `empty-${newId}`, text: '(empty)' }]
  }]);
  refreshFavoritesDom();
  const input = document.querySelector(`.fav-group-edit-input[data-node-id="${newId}"]`);
  if (input) {
    input.focus();
    input.select();
  }
}

async function addFavoritesFromSelection() {
  const grid = panelState[activePanelId]?.w2uiGrid;
  let dirs = [];

  if (grid) {
    const selectedRecids = grid.getSelection();
    dirs = selectedRecids
      .map(recid => grid.records.find(r => r.recid === recid))
      .filter(r => r && r.isFolder && r.path);
  }

  // Fallback: use selectedItemState if it is a directory
  if (dirs.length === 0 && selectedItemState.isDirectory && selectedItemState.path) {
    const label = selectedItemState.filename
      || selectedItemState.path.split(/[\\/]/).filter(Boolean).pop()
      || selectedItemState.path;
    dirs = [{ path: selectedItemState.path, filenameRaw: label }];
  }

  if (dirs.length === 0) return;

  if (dirs.length === 1) {
    const dir = dirs[0];
    if (!isFavoritePathPresent(dir.path)) {
      const node = await createFavoriteNode(dir.path, dir.filenameRaw || dir.filename);
      w2uiFavoritesSidebar.insert(null, 'edit-AddGroup', [node]);
      refreshFavoritesDom();
    }
  } else {
    showAddFavConfirmModal(dirs);
  }
}

function showAddFavConfirmModal(dirs) {
  let overlay = document.getElementById('fav-add-confirm-modal');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'fav-add-confirm-modal';
    overlay.className = 'fav-modal-overlay';
    document.body.appendChild(overlay);
  }

  const listHtml = dirs.map(d => {
    const name = (d.filenameRaw || d.filename || d.path.split(/[\\/]/).filter(Boolean).pop() || d.path)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const pathEsc = (d.path || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div class="fav-modal-item-row"><span class="fav-modal-item-name" title="${pathEsc}">${name}</span></div>`;
  }).join('');

  overlay.innerHTML = `
    <div class="fav-modal-container" role="dialog" aria-modal="true">
      <div class="fav-modal-header">
        <span class="fav-modal-title">Add ${dirs.length} folders to Favorites?</span>
        <button class="fav-modal-close-btn" id="fav-addconfirm-close-btn" title="Cancel" aria-label="Close">&times;</button>
      </div>
      <div class="fav-modal-body">
        <div id="fav-addconfirm-list">${listHtml}</div>
      </div>
      <div class="fav-modal-footer">
        <button id="fav-addconfirm-ok-btn" class="fav-modal-btn-primary">OK</button>
        <button id="fav-addconfirm-cancel-btn" class="fav-modal-btn-cancel">Cancel</button>
      </div>
    </div>`;

  overlay.style.display = 'flex';

  const close = () => {
    if (overlay._escKeyHandler) {
      document.removeEventListener('keydown', overlay._escKeyHandler);
      overlay._escKeyHandler = null;
    }
    overlay.style.display = 'none';
  };

  document.getElementById('fav-addconfirm-close-btn').addEventListener('click', close);
  document.getElementById('fav-addconfirm-cancel-btn').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  document.getElementById('fav-addconfirm-ok-btn').addEventListener('click', async () => {
    close();
    for (const d of dirs) {
      if (isFavoritePathPresent(d.path)) continue;
      const node = await createFavoriteNode(d.path, d.filenameRaw || d.filename);
      w2uiFavoritesSidebar.insert(null, 'edit-AddGroup', [node]);
    }
    refreshFavoritesDom();
  });

  overlay._escKeyHandler = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', overlay._escKeyHandler);
}

function deleteGroupById(nodeId) {
  const removeById = (nodes) => {
    const idx = nodes.findIndex(n => n.id === nodeId);
    if (idx !== -1) {
      nodes.splice(idx, 1);
      return true;
    }

    for (const node of nodes) {
      if (node.group && Array.isArray(node.nodes) && removeById(node.nodes)) {
        return true;
      }
    }

    return false;
  };

  return removeById(w2uiFavoritesSidebar.nodes);
}

// ── Favorites Delete Group Modal ───────────────────────────────────────────

function buildFavGroupOptionHtml(excludeGroupId) {
  let html = `<option value="delete">Delete</option><option value="--root--">Move to: (root)</option>`;
  if (!w2uiFavoritesSidebar) return html;
  for (const node of w2uiFavoritesSidebar.nodes) {
    if (node.group && node.id !== excludeGroupId) {
      const escaped = (node.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      html += `<option value="${node.id}">Move to: ${escaped}</option>`;
    }
  }
  return html;
}

function showFavDeleteGroupModal(groupNodeId, realItems) {
  const node = w2uiFavoritesSidebar.get(groupNodeId);
  if (!node) return;

  let overlay = document.getElementById('fav-delete-group-modal');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'fav-delete-group-modal';
    overlay.className = 'fav-modal-overlay';
    document.body.appendChild(overlay);
  }

  const optionsHtml = buildFavGroupOptionHtml(groupNodeId);
  const groupNameEscaped = (node.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const itemRows = realItems.map(item => {
    const name = (item.text || item.id).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div class="fav-modal-item-row" data-node-id="${item.id}">
      <span class="fav-modal-item-name" title="${name}">${name}</span>
      <select class="fav-modal-item-select">${optionsHtml}</select>
    </div>`;
  }).join('');

  overlay.innerHTML = `
    <div class="fav-modal-container" role="dialog" aria-modal="true">
      <div class="fav-modal-header">
        <span class="fav-modal-title">Delete Group &ldquo;${groupNameEscaped}&rdquo;</span>
        <button class="fav-modal-close-btn" id="fav-modal-close-btn" title="Cancel" aria-label="Close">&times;</button>
      </div>
      <div class="fav-modal-body">
        <div class="fav-modal-bulk-row">
          <select id="fav-modal-bulk-select">${optionsHtml}</select>
          <button id="fav-modal-bulk-apply-btn">Apply to all</button>
        </div>
        <div id="fav-modal-items-list">${itemRows}</div>
      </div>
      <div class="fav-modal-footer">
        <button id="fav-modal-apply-btn" class="fav-modal-btn-primary">Apply</button>
        <button id="fav-modal-cancel-btn" class="fav-modal-btn-cancel">Cancel</button>
      </div>
    </div>`;

  overlay.style.display = 'flex';
  overlay.dataset.groupId = groupNodeId;

  document.getElementById('fav-modal-close-btn').addEventListener('click', closeFavDeleteGroupModal);
  document.getElementById('fav-modal-cancel-btn').addEventListener('click', closeFavDeleteGroupModal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeFavDeleteGroupModal();
  });

  document.getElementById('fav-modal-bulk-apply-btn').addEventListener('click', () => {
    const bulkValue = document.getElementById('fav-modal-bulk-select').value;
    overlay.querySelectorAll('.fav-modal-item-select').forEach(sel => { sel.value = bulkValue; });
  });

  document.getElementById('fav-modal-apply-btn').addEventListener('click', async () => {
    const itemActions = [];
    overlay.querySelectorAll('.fav-modal-item-row').forEach(row => {
      itemActions.push({ nodeId: row.dataset.nodeId, action: row.querySelector('.fav-modal-item-select').value });
    });
    closeFavDeleteGroupModal();
    await applyFavDeleteGroup(groupNodeId, itemActions);
  });

  overlay._escKeyHandler = (e) => { if (e.key === 'Escape') closeFavDeleteGroupModal(); };
  document.addEventListener('keydown', overlay._escKeyHandler);
}

function closeFavDeleteGroupModal() {
  const overlay = document.getElementById('fav-delete-group-modal');
  if (!overlay) return;
  if (overlay._escKeyHandler) {
    document.removeEventListener('keydown', overlay._escKeyHandler);
    overlay._escKeyHandler = null;
  }
  overlay.style.display = 'none';
}

async function applyFavDeleteGroup(groupNodeId, itemActions) {
  if (!w2uiFavoritesSidebar) return;

  const groupNode = w2uiFavoritesSidebar.get(groupNodeId);
  if (!groupNode) return;

  for (const { nodeId, action } of itemActions) {
    if (action === 'delete') continue;

    const itemNode = (groupNode.nodes || []).find(n => n.id === nodeId);
    if (!itemNode) continue;

    if (action === '--root--') {
      w2uiFavoritesSidebar.nodes.push({ ...itemNode });
    } else {
      const targetGroup = w2uiFavoritesSidebar.get(action);
      if (targetGroup && targetGroup.nodes) {
        // Remove empty placeholder if it was the only item
        const emptyIdx = targetGroup.nodes.findIndex(n => n.id.startsWith('empty-'));
        if (emptyIdx !== -1 && targetGroup.nodes.length === 1) {
          targetGroup.nodes.splice(emptyIdx, 1);
        }
        targetGroup.nodes.push({ ...itemNode });
      }
    }
  }

  deleteGroupById(groupNodeId);
  await persistW2UINodes();
  await refreshFavoritesSidebar();
  if (favEditMode) enterFavoritesEditMode();
}

// ── Sidebar collapse ───────────────────────────────────────────────────────

export function toggleSidebarCollapse() {
  if (sidebarCollapsed) {
    applySidebarDragWidth(sidebarExpandedWidth);
  } else {
    setSidebarWidth(SIDEBAR_COLLAPSED_WIDTH, true);
  }
}

// ── Sidebar arrow-key navigation ──────────────────────────────────────────

function getToolbarButtons() {
  return Array.from(document.querySelectorAll('#sidebar-toolbar button'));
}

/**
 * Build a flat, ordered list of every visible navigable element inside
 * #sidebar-sections.  Each entry is { el, type } where type is one of:
 *   'section-header' — the collapsible section header (Favorites / TODO)
 *   'fav-group'      — a w2ui favorites group node
 *   'fav-item'       — a w2ui favorites item node
 *   'sidebar-item'   — a directory item from the tree browser
 *   'todo-group'     — a TODO group header
 *   'todo-item'      — an individual TODO item
 */
function getVisibleSectionItems() {
  const items = [];
  const sections = document.querySelectorAll('#sidebar-sections .sidebar-section');

  for (const section of sections) {
    const header = section.querySelector('.sidebar-section-header');
    if (!header) continue;
    const sectionName = section.dataset.section;
    items.push({ el: header, type: 'section-header', section: sectionName });

    // Only include children if the section is expanded
    if (section.classList.contains('collapsed')) continue;

    if (sectionName === 'favorites') {
      // w2ui sidebar nodes — walk visible nodes in DOM order
      const favContainer = section.querySelector('.sidebar-section-body');
      if (favContainer) {
        const nodes = favContainer.querySelectorAll('.w2ui-node, .w2ui-node-group');
        for (const node of nodes) {
          // Skip nodes hidden by w2ui collapse (parent has display:none)
          if (node.offsetParent === null) continue;
          const isGroup = node.classList.contains('w2ui-node-group');
          items.push({ el: node, type: isGroup ? 'fav-group' : 'fav-item' });
        }
      }
      // Also include tree browser items (.sidebar-item) if they exist inside this section
      const treeItems = section.querySelectorAll('.sidebar-item');
      for (const item of treeItems) {
        if (item.offsetParent === null) continue;
        items.push({ el: item, type: 'sidebar-item' });
      }
    } else if (sectionName === 'todos') {
      const todoBody = section.querySelector('.sidebar-section-body');
      if (todoBody) {
        const groups = todoBody.querySelectorAll('.sidebar-todo-group');
        for (const group of groups) {
          const groupHeader = group.querySelector('.sidebar-todo-group-header');
          if (groupHeader) items.push({ el: groupHeader, type: 'todo-group', groupEl: group });
          // Only show items if the group is expanded
          if (!group.classList.contains('collapsed')) {
            const todoItems = group.querySelectorAll('.sidebar-todo-item');
            for (const item of todoItems) {
              if (item.offsetParent === null) continue;
              items.push({ el: item, type: 'todo-item' });
            }
          }
        }
      }
    }
  }
  return items;
}

export function clearSidebarArrowFocus() {
  document.querySelectorAll('.sidebar-arrow-focused').forEach(el => el.classList.remove('sidebar-arrow-focused'));
  const $sidebar = document.getElementById('sidebar-content');
  if ($sidebar) $sidebar.classList.remove('sidebar-toolbar-focused');
  sidebarFocusZone = null;
  sidebarFocusIndex = -1;
}

export function initSidebarFocus() {
  previouslyFocusedPanelId = activePanelId || 1;
  sidebarFocusZone = 'toolbar';
  sidebarFocusIndex = 0;
  applySidebarArrowFocus();
  // Keep DOM focus on the sidebar container so keydown events are not
  // intercepted by w2ui or other child-element handlers.
  document.getElementById('sidebar-content')?.focus({ preventScroll: true });
}

function applySidebarArrowFocus() {
  document.querySelectorAll('.sidebar-arrow-focused').forEach(el => el.classList.remove('sidebar-arrow-focused'));
  const $sidebar = document.getElementById('sidebar-content');
  if (sidebarFocusZone === 'toolbar') {
    const buttons = getToolbarButtons();
    if (buttons[sidebarFocusIndex]) buttons[sidebarFocusIndex].classList.add('sidebar-arrow-focused');
    if ($sidebar) $sidebar.classList.add('sidebar-toolbar-focused');
    setPreviouslyActivePanel(null);
  } else {
    if ($sidebar) $sidebar.classList.remove('sidebar-toolbar-focused');
    if (sidebarFocusZone === 'sections') {
      const items = getVisibleSectionItems();
      if (items[sidebarFocusIndex]) {
        items[sidebarFocusIndex].el.classList.add('sidebar-arrow-focused');
        items[sidebarFocusIndex].el.scrollIntoView({ block: 'nearest' });
      }
      // Show orange shadow on previously focused panel only when a fav-item is active
      const currentItem = items[sidebarFocusIndex];
      if (currentItem?.type === 'fav-item') {
        setPreviouslyActivePanel(previouslyFocusedPanelId);
      } else {
        setPreviouslyActivePanel(null);
      }
    }
  }
}

export function handleSidebarArrowKey(key) {
  const toolbarButtons = getToolbarButtons();

  // If nothing focused yet, start at first toolbar button
  if (sidebarFocusZone === null) {
    sidebarFocusZone = 'toolbar';
    sidebarFocusIndex = 0;
    applySidebarArrowFocus();
    return;
  }

  if (sidebarFocusZone === 'toolbar') {
    if (key === 'ArrowLeft') {
      if (sidebarFocusIndex > 0) sidebarFocusIndex--;
      applySidebarArrowFocus();
    } else if (key === 'ArrowRight') {
      if (sidebarFocusIndex < toolbarButtons.length - 1) sidebarFocusIndex++;
      applySidebarArrowFocus();
    } else if (key === 'ArrowDown') {
      const sectionItems = getVisibleSectionItems();
      if (sectionItems.length > 0) {
        sidebarFocusZone = 'sections';
        sidebarFocusIndex = 0;
        applySidebarArrowFocus();
      }
    } else if (key === 'Enter') {
      if (toolbarButtons[sidebarFocusIndex]) toolbarButtons[sidebarFocusIndex].click();
    }
    return;
  }

  // sections zone
  const items = getVisibleSectionItems();
  if (items.length === 0) return;
  const current = items[sidebarFocusIndex];

  if (key === 'ArrowUp') {
    if (sidebarFocusIndex > 0) {
      sidebarFocusIndex--;
      applySidebarArrowFocus();
    } else {
      // Move back to toolbar
      sidebarFocusZone = 'toolbar';
      sidebarFocusIndex = 0;
      applySidebarArrowFocus();
    }
  } else if (key === 'ArrowDown') {
    if (sidebarFocusIndex < items.length - 1) {
      sidebarFocusIndex++;
      applySidebarArrowFocus();
    }
  } else if (key === 'ArrowLeft') {
    if (current?.type === 'section-header') {
      // Collapse the section
      if (current.section && getExpandedSectionsSet().has(current.section)) {
        void toggleSidebarSection(current.section);
      }
    } else if (current?.type === 'sidebar-item') {
      // Collapse tree item
      const $item = $(current.el);
      if ($item.attr('data-expanded') === 'true') {
        void toggleSidebarItemExpansion($item);
      }
    } else if (current?.type === 'todo-group') {
      // Collapse todo group
      const group = current.groupEl;
      if (group && !group.classList.contains('collapsed')) {
        const groupHeader = group.querySelector('.sidebar-todo-group-header');
        if (groupHeader) groupHeader.click();
      }
    } else if (current?.type === 'fav-group' || current?.type === 'fav-item') {
      // Collapse w2ui node if expanded
      const nodeId = current.el.dataset?.id;
      if (nodeId && w2uiFavoritesSidebar) {
        const node = w2uiFavoritesSidebar.get(nodeId);
        if (node?.expanded) {
          w2uiFavoritesSidebar.collapse(nodeId);
          setTimeout(() => applySidebarArrowFocus(), 0);
        }
      }
    }
  } else if (key === 'ArrowRight') {
    if (current?.type === 'section-header') {
      // Expand the section
      if (current.section && !getExpandedSectionsSet().has(current.section)) {
        void toggleSidebarSection(current.section);
      }
    } else if (current?.type === 'sidebar-item') {
      // Expand tree item
      const $item = $(current.el);
      if ($item.attr('data-expanded') !== 'true') {
        void toggleSidebarItemExpansion($item);
      }
    } else if (current?.type === 'todo-group') {
      // Expand todo group
      const group = current.groupEl;
      if (group && group.classList.contains('collapsed')) {
        const groupHeader = group.querySelector('.sidebar-todo-group-header');
        if (groupHeader) groupHeader.click();
      }
    } else if (current?.type === 'fav-group' || current?.type === 'fav-item') {
      // Expand w2ui node if collapsed
      const nodeId = current.el.dataset?.id;
      if (nodeId && w2uiFavoritesSidebar) {
        const node = w2uiFavoritesSidebar.get(nodeId);
        if (node && !node.expanded && node.nodes?.length > 0) {
          w2uiFavoritesSidebar.expand(nodeId);
          setTimeout(() => applySidebarArrowFocus(), 0);
        }
      }
    }
  } else if (key === 'Enter') {
    if (current?.type === 'section-header') {
      void toggleSidebarSection(current.section);
    } else if (current?.type === 'fav-item') {
      const nodeId = current.el.dataset?.id;
      if (nodeId) {
        const node = w2uiFavoritesSidebar?.get(nodeId);
        if (node && node.path && !node.disabled) {
          navigateToDirectory(node.path, previouslyFocusedPanelId);
          setActivePanelId(previouslyFocusedPanelId);
          setGridFocusedPanelId(previouslyFocusedPanelId);
        }
      }
    } else if (current?.type === 'sidebar-item') {
      const path = current.el.getAttribute('data-path');
      if (path) {
        navigateToDirectory(path, previouslyFocusedPanelId);
        updateSidebarSelection(path);
        setActivePanelId(previouslyFocusedPanelId);
        setGridFocusedPanelId(previouslyFocusedPanelId);
      }
    } else if (current?.el) {
      current.el.click();
    }
  }
}
