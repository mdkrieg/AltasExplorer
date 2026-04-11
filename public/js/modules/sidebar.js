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
import { navigateToDirectory } from './panels.js';
import {
  panelState,
  sidebarState,
  selectedItemState,
  activePanelId,
  w2layoutInstance
} from '../renderer.js';

// ── Module-level state (private to this module) ────────────────────────────
let w2uiFavoritesSidebar = null;
let favoritesContextMenuTarget = null;
let favIconMap = {};
let favEditMode = false;
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

function resizeSidebarGrids() {
  for (let panelId = 1; panelId <= 4; panelId++) {
    const grid = panelState[panelId].w2uiGrid;
    if (grid) grid.resize();
  }
}

function syncSidebarCollapsedUi() {
  const $sidebar = $('#sidebar-content');

  if (sidebarCollapsed) {
    if (favEditMode) {
      void exitFavoritesEditMode();
    }
    $sidebar.addClass('sidebar-collapsed');
    $('#btn-sidebar-collapse').html('&#10095;').attr('title', 'Expand sidebar');
  } else {
    $sidebar.removeClass('sidebar-collapsed');
    $('#btn-sidebar-collapse').html('&#10094;').attr('title', 'Collapse sidebar');
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

    console.log('Sidebar initialized');
  } catch (err) {
    console.error('Error initializing sidebar:', err);
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

  // Double-click to navigate
  $('#sidebar-tree').on('dblclick', '.sidebar-item-label', function (e) {
    e.stopPropagation();
    const $item = $(this).closest('.sidebar-item');
    const path = $item.attr('data-path');

    if (path) {
      // Navigate to directory in panel-1
      navigateToDirectory(path, 1);
      // Update sidebar selection
      updateSidebarSelection(path);
    }
  });

  // Single click to select
  $('#sidebar-tree').on('click', '.sidebar-item-label', function (e) {
    e.stopPropagation();
    const $item = $(this).closest('.sidebar-item');
    const path = $item.attr('data-path');

    if (path) {
      updateSidebarSelection(path);
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
    w2uiFavoritesSidebar = new w2sidebar({
      box: '#w2ui-favorites',
      name: 'favorites-sidebar',
      topHTML: `<div class="favorites-header"><span class="favorites-label favorites-label-full">FAVORITES</span><span class="favorites-label favorites-label-short">FAV</span><button id="btn-favorites-edit" class="btn-favorites-edit" title="Edit favorites">&#9998;</button></div>`,
      reorder: true,
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
        // Navigate to directory on click
        const node = w2uiFavoritesSidebar.get(event.target);
        if (node && node.path && !node.disabled) {
          await navigateToDirectory(node.path, 1);
          updateSidebarSelection(node.path);
        }
      },
      onContextMenu: (event) => {
        event.preventDefault();
        const node = w2uiFavoritesSidebar.get(event.target);
        if (node) {
          favoritesContextMenuTarget = node;
          showFavoritesContextMenu(event.clientX, event.clientY, node.group ? 'group' : 'item');
        }
      },
      onDragStart(event) {
        if (event.detail.node.id.startsWith("empty-")) {
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

    // Attach edit button handler using event delegation
    document.getElementById('w2ui-favorites').addEventListener('click', (e) => {
      if (e.target.closest('#btn-favorites-edit')) {
        toggleFavoritesEditMode();
      }
    });

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
        nodes: groupNodes
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
    if (node.id && (node.id.startsWith('empty-') || node.id.startsWith('edit-'))) {
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
      w2uiFavoritesSidebar.refresh();
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
 * Show the favorites context menu
 */
function showFavoritesContextMenu(x, y, targetType = 'item') {
  let $menu = $('#favorites-context-menu');
  if ($menu.length === 0) {
    $menu = $('<div>').attr('id', 'favorites-context-menu');
    $('body').append($menu);
  }

  $menu.empty();

  if (targetType === 'item') {
    // Item context menu
    $menu.append(
      $('<div>').addClass('fav-menu-item')
        .text('Remove from Favorites')
        .on('click', async function (e) {
          e.stopPropagation();
          if (favoritesContextMenuTarget && favoritesContextMenuTarget.path) {
            await removeFromFavorites(favoritesContextMenuTarget.path);
          }
          hideFavoritesContextMenu();
        })
    );
  } else if (targetType === 'group') {
    // Group context menu
    $menu.append(
      $('<div>').addClass('fav-menu-item')
        .text('Rename')
        .on('click', async function (e) {
          e.stopPropagation();
          if (favoritesContextMenuTarget) {
            const newName = await showInputPrompt('Enter new group name:', favoritesContextMenuTarget.text);
            if (newName && newName.trim()) {
              await renameGroup(favoritesContextMenuTarget, newName.trim());
            }
          }
          hideFavoritesContextMenu();
        })
    );
    $menu.append(
      $('<div>').addClass('fav-menu-item')
        .text('Add to Group')
        .on('click', async function (e) {
          e.stopPropagation();
          await showAddGroupPrompt();
          hideFavoritesContextMenu();
        })
    );
    $menu.append(
      $('<div>').addClass('fav-menu-item')
        .text('Delete')
        .on('click', async function (e) {
          e.stopPropagation();
          if (favoritesContextMenuTarget) {
            await deleteGroup(favoritesContextMenuTarget);
          }
          hideFavoritesContextMenu();
        })
    );
  }

  $menu.css({
    position: 'fixed',
    left: x,
    top: y,
    display: 'block',
    background: 'white',
    border: '1px solid #ccc',
    borderRadius: '4px',
    minWidth: '160px',
    zIndex: 10001
  });

  // Ensure menu stays in viewport
  const menuRect = $menu[0].getBoundingClientRect();
  if (menuRect.right > window.innerWidth) {
    $menu.css('left', x - menuRect.width);
  }
  if (menuRect.bottom > window.innerHeight) {
    $menu.css('top', y - menuRect.height);
  }
}

function hideFavoritesContextMenu() {
  $('#favorites-context-menu').hide();
}

// Hide context menu on outside click
$(document).on('click', function (e) {
  if (!$(e.target).closest('#favorites-context-menu').length) {
    hideFavoritesContextMenu();
  }
});

// ── Favorites Edit Mode ────────────────────────────────────────────────────

function toggleFavoritesEditMode() {
  if (favEditMode) {
    exitFavoritesEditMode();
  } else {
    enterFavoritesEditMode();
  }
}

function enterFavoritesEditMode() {
  favEditMode = true;
  $("#w2ui-favorites").addClass('edit-mode');

  // Disable dragging of items while in edit mode to prevent conflicts with renaming and deleting
  const itemNodes = w2uiFavoritesSidebar.nodes.filter(n => !n.group && !n.id.startsWith("edit-") );
  w2uiFavoritesSidebar.disable(...itemNodes.map(n => n.id));
  w2uiFavoritesSidebar.reorder = false;

  if (!w2uiFavoritesSidebar.get('edit-AddGroup')) {
    w2uiFavoritesSidebar.add([
      { id: 'edit-AddGroup', text: 'Add Group', icon: 'w2ui-icon-plus' },
      { id: 'edit-AddFav', text: 'Add Favorite', icon: 'w2ui-icon-plus' }
    ]);
  }

  const btn = document.getElementById('btn-favorites-edit');
  if (btn) {
    btn.innerHTML = '&#10003;';
    btn.title = 'Save changes';
    btn.classList.add('active');
  }

  const container = document.getElementById('w2ui-favorites');
  if (!container || !w2uiFavoritesSidebar) return;

  container.querySelectorAll('.w2ui-node-group').forEach(groupEl => {
    const nodeId = groupEl.dataset.id;
    if (!nodeId) return;
    const node = w2uiFavoritesSidebar.get(nodeId);
    if (!node || !node.group) return;

    // Replace group text span with an editable input
    const textSpan = groupEl.querySelector('.w2ui-group-text');
    if (textSpan && !groupEl.querySelector('.fav-group-edit-input')) {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = node.text;
      input.className = 'fav-group-edit-input';
      input.dataset.nodeId = nodeId;
      input.addEventListener('click', e => e.stopPropagation());
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') exitFavoritesEditMode();
        e.stopPropagation();
      });
      console.log(input);
      textSpan.replaceWith(input);
    }

    // Add trash button
    if (!groupEl.querySelector('.btn-fav-delete-group')) {
      const trashBtn = document.createElement('button');
      trashBtn.className = 'btn-fav-delete-group';
      trashBtn.innerHTML = '&#128465;';
      trashBtn.title = 'Delete group';
      trashBtn.dataset.nodeId = nodeId;
      trashBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await handleDeleteGroupInEditMode(nodeId);
      });
      groupEl.appendChild(trashBtn);
    }
  });

  // Add trash buttons to individual favorite items (non-group nodes)
  container.querySelectorAll('.w2ui-node:not(.w2ui-node-group)').forEach(itemEl => {
    const nodeId = itemEl.dataset.id;
    if (!nodeId || nodeId.startsWith('empty-') || nodeId.startsWith('edit-')) return;
    if (itemEl.querySelector('.btn-fav-delete-fav')) return; // Already added

    const trashBtn = document.createElement('button');
    trashBtn.className = 'btn-fav-delete-fav';
    trashBtn.innerHTML = '&#128465;';
    trashBtn.title = 'Delete favorite';
    trashBtn.dataset.nodeId = nodeId;
    trashBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await handleDeleteFavoriteInEditMode(nodeId, itemEl);
    });
    itemEl.appendChild(trashBtn);
  });
}

async function exitFavoritesEditMode() {
  favEditMode = false;
  $("#w2ui-favorites").removeClass('edit-mode');

  const btn = document.getElementById('btn-favorites-edit');
  if (btn) {
    btn.innerHTML = '&#9998;';
    btn.title = 'Edit favorites';
    btn.classList.remove('active');
  }

  const container = document.getElementById('w2ui-favorites');
  if (!container || !w2uiFavoritesSidebar) return;

  // Apply renames, then manually restore DOM so refresh() sees clean group rows
  container.querySelectorAll('.fav-group-edit-input').forEach(input => {
    const nodeId = input.dataset.nodeId;
    if (!nodeId) return;
    const node = w2uiFavoritesSidebar.get(nodeId);
    if (node && input.value.trim()) {
      node.text = input.value.trim();
    }
    // Restore the .w2ui-group-text span so enterFavoritesEditMode() can find it next time
    const span = document.createElement('span');
    span.className = 'w2ui-group-text';
    span.textContent = node ? node.text : input.value;
    input.replaceWith(span);
  });
  // Remove trash buttons
  container.querySelectorAll('.btn-fav-delete-group').forEach(trashBtn => trashBtn.remove());
  container.querySelectorAll('.btn-fav-delete-fav').forEach(trashBtn => trashBtn.remove());

  w2uiFavoritesSidebar.remove('edit-AddGroup', 'edit-AddFav');

  // Re-enable dragging of items after exiting edit mode
  const itemNodes = w2uiFavoritesSidebar.nodes.filter(n => !n.group);
  w2uiFavoritesSidebar.enable(...itemNodes.map(n => n.id));
  w2uiFavoritesSidebar.unlock();
  w2uiFavoritesSidebar.reorder = true;

  await persistW2UINodes();
  w2uiFavoritesSidebar.refresh();
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
  // Wait one tick for the sidebar's internal refresh to update the DOM,
  // then re-enter edit mode (guarded add() makes this safe to call again)
  await new Promise(r => setTimeout(r, 50));
  enterFavoritesEditMode();
  // Wait for DOM update from enterFavoritesEditMode before trying to focus
  await new Promise(r => setTimeout(r, 30));
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
      .map(recid => grid.records[recid - 1])
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
    await addToFavorites(dirs[0].path);
    enterFavoritesEditMode();
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
      await addToFavorites(d.path);
    }
    enterFavoritesEditMode();
  });

  overlay._escKeyHandler = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', overlay._escKeyHandler);
}

/**
 * Delete a favorite item in edit mode with animation
 */
async function handleDeleteFavoriteInEditMode(nodeId, domElement) {
  // Add animation class for the gap to collapse
  domElement.classList.add('fav-item-deleting');

  // Wait for animation to complete before removing from sidebar
  await new Promise(r => setTimeout(r, 200));

  // Delete from sidebar
  w2uiFavoritesSidebar.remove(nodeId);

  // Persist changes
  await persistW2UINodes();

  // Refresh to redraw
  w2uiFavoritesSidebar.refresh();

  // Re-enter edit mode to apply trash buttons again
  if (favEditMode) enterFavoritesEditMode();
}

async function handleDeleteGroupInEditMode(nodeId) {
  const node = w2uiFavoritesSidebar.get(nodeId);
  if (!node || !node.group) return;

  const realItems = (node.nodes || []).filter(n => !n.id.startsWith('empty-'));

  if (realItems.length === 0) {
    // Delete immediately — no real items
    deleteGroupById(nodeId);
    await persistW2UINodes();
    await refreshFavoritesSidebar();
    if (favEditMode) enterFavoritesEditMode();
  } else {
    // Show confirmation modal
    showFavDeleteGroupModal(nodeId, realItems);
  }
}

function deleteGroupById(nodeId) {
  const idx = w2uiFavoritesSidebar.nodes.findIndex(n => n.id === nodeId);
  if (idx !== -1) {
    w2uiFavoritesSidebar.nodes.splice(idx, 1);
    return true;
  }
  // Try one level of nesting
  for (const node of w2uiFavoritesSidebar.nodes) {
    if (node.group && node.nodes) {
      const childIdx = node.nodes.findIndex(n => n.id === nodeId);
      if (childIdx !== -1) {
        node.nodes.splice(childIdx, 1);
        return true;
      }
    }
  }
  return false;
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
