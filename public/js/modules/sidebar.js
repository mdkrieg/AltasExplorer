/**
 * Sidebar Module
 * Handles sidebar navigation, tree expansion, and favorites
 * Note: Functions here can reference globals (activePanelId, sidebarState, etc) from renderer.js
 */

/**
 * Initialize sidebar with root drives
 */
export async function initializeSidebar() {
  try {
    const drives = await window.electronAPI.getRootDrives();
    sidebarState.drives = drives || [];
    await renderSidebarTree(drives);
    attachSidebarEventListeners();
  } catch (err) {
    console.error('Error initializing sidebar:', err);
  }
}

/**
 * Render the sidebar tree starting with root drives
 */
export async function renderSidebarTree(drives) {
  const $tree = $('#sidebar-tree');
  $tree.empty();
  for (const drive of drives) {
    const $driveEl = createSidebarDriveItem(drive);
    $tree.append($driveEl);
  }
}

/**
 * Create a sidebar item for a drive
 */
export function createSidebarDriveItem(drive) {
  const driveName = drive.includes(':') ? drive : `${drive} Drive`;
  const $item = $(`
    <div class="sidebar-item sidebar-drive" data-path="${drive}">
      <span class="sidebar-icon">🖥️</span>
      <span class="sidebar-label">${driveName}</span>
      <span class="sidebar-expand-icon" style="display:none;">▼</span>
    </div>
    <div class="sidebar-children" style="display:none;"></div>
  `);
  return $item;
}

/**
 * Create a sidebar item for a directory
 */
export function createSidebarDirectoryItem(dirName, dirPath, level = 0) {
  const $item = $(`
    <div class="sidebar-item sidebar-dir" data-path="${dirPath}" style="padding-left: ${level * 16}px;">
      <span class="sidebar-icon">📁</span>
      <span class="sidebar-label">${dirName}</span>
      <span class="sidebar-expand-icon">▶</span>
    </div>
    <div class="sidebar-children" style="display:none;"></div>
  `);
  return $item;
}

/**
 * Load and expand children for a sidebar item
 */
export async function loadSidebarItemChildren(path, $item) {
  try {
    const children = await window.electronAPI.readDirectory(path);
    if (!children) return;

    const dirs = children
      .filter(e => e.isFolder)
      .sort((a, b) => a.filename.localeCompare(b.filename))
      .slice(0, 20); // Limit to 20 folders per level

    const $children = $item.find('.sidebar-children').first();
    $children.empty();

    for (const dir of dirs) {
      const fullPath = path.includes('\\') 
        ? `${path}\\${dir.filename}`
        : `${path}/${dir.filename}`;
      const $childItem = createSidebarDirectoryItem(dir.filename, fullPath, 1);
      $children.append($childItem);
    }
  } catch (err) {
    console.error('Error loading sidebar children:', err);
  }
}

/**
 * Toggle expansion of a sidebar item
 */
export async function toggleSidebarItemExpansion($item) {
  const $expandIcon = $item.find('.sidebar-expand-icon').first();
  const $children = $item.next('.sidebar-children');
  const path = $item.data('path');

  if ($children.is(':visible')) {
    collapseSidebarItem($item);
  } else {
    await expandSidebarItem($item, path);
  }
}

/**
 * Expand a sidebar item and show its children
 */
export async function expandSidebarItem($item, path) {
  const $children = $item.next('.sidebar-children');
  const $expandIcon = $item.find('.sidebar-expand-icon').first();

  if ($children.children().length === 0) {
    await loadSidebarItemChildren(path, $item);
  }

  $expandIcon.text('▼');
  $children.slideDown(150);
  sidebarState.expandedPaths.add(path);
}

/**
 * Collapse a sidebar item and hide its children
 */
export function collapseSidebarItem($item) {
  const $children = $item.next('.sidebar-children');
  const $expandIcon = $item.find('.sidebar-expand-icon').first();
  const path = $item.data('path');

  $expandIcon.text('▶');
  $children.slideUp(150);
  sidebarState.expandedPaths.delete(path);
}

/**
 * Update sidebar selection to highlight a path
 */
export function updateSidebarSelection(path) {
  $('.sidebar-item').removeClass('selected');
  $(`.sidebar-item[data-path="${path}"]`).addClass('selected');
  sidebarState.selectedPath = path;
}

/**
 * Attach event listeners to sidebar items
 */
export function attachSidebarEventListeners() {
  $(document)
    .off('click', '.sidebar-item')
    .on('click', '.sidebar-item', async function(e) {
      e.stopPropagation();
      const path = $(this).data('path');
      
      if (e.target.closest('.sidebar-expand-icon')) {
        await toggleSidebarItemExpansion($(this));
      } else {
        updateSidebarSelection(path);
        if (activePanelId === 1) {
          await navigateToDirectory(path, activePanelId);
        }
      }
    });
}

/**
 * Load favorites array from settings
 */
export async function loadFavoritesFromSettings() {
  try {
    const settings = await window.electronAPI.getSettings();
    return settings.favorites || [];
  } catch (err) {
    console.error('Error loading favorites:', err);
    return [];
  }
}

/**
 * Save favorites array to settings
 */
export async function saveFavoritesToSettings(favorites) {
  try {
    const settings = await window.electronAPI.getSettings();
    settings.favorites = favorites || [];
    await window.electronAPI.saveSettings(settings);
  } catch (err) {
    console.error('Error saving favorites:', err);
  }
}

/**
 * Render the favorites list in the sidebar
 */
export async function renderFavoritesList() {
  try {
    const favorites = await loadFavoritesFromSettings();
    const $list = $('#favorites-list');
    $list.empty();

    for (let i = 0; i < favorites.length; i++) {
      const fav = favorites[i];
      const $item = $(`
        <div class="favorite-item" data-path="${fav}" data-index="${i}">
          <div class="favorite-icon">★</div>
          <div class="favorite-label">${fav}</div>
          <div class="favorite-menu-btn">⋮</div>
        </div>
      `);
      $list.append($item);
    }

    attachFavoritesEventListeners();
  } catch (err) {
    console.error('Error rendering favorites:', err);
  }
}

/**
 * Add a directory path to favorites (avoiding duplicates)
 */
export async function addToFavorites(dirPath) {
  const favorites = await loadFavoritesFromSettings();
  if (!favorites.includes(dirPath)) {
    favorites.push(dirPath);
    await saveFavoritesToSettings(favorites);
    await renderFavoritesList();
  }
}

/**
 * Remove a path from favorites
 */
export async function removeFromFavorites(dirPath) {
  let favorites = await loadFavoritesFromSettings();
  favorites = favorites.filter(f => f !== dirPath);
  await saveFavoritesToSettings(favorites);
  await renderFavoritesList();
}

/**
 * Attach event listeners for the favorites list (drag/drop, click, right-click)
 */
export function attachFavoritesEventListeners() {
  $(document)
    .off('click', '.favorite-item')
    .on('click', '.favorite-item', async function() {
      const path = $(this).data('path');
      await navigateToDirectory(path, activePanelId);
    })
    .off('contextmenu', '.favorite-item')
    .on('contextmenu', '.favorite-item', function(e) {
      e.preventDefault();
      const x = e.clientX;
      const y = e.clientY;
      favoritesContextMenuTarget = $(this).data('path');
      showFavoritesContextMenu(x, y);
    })
    .off('dragstart', '.favorite-item')
    .on('dragstart', '.favorite-item', function() {
      favoriteDragSrcIndex = $(this).data('index');
    })
    .off('dragover', '.favorite-item')
    .on('dragover', '.favorite-item', function(e) {
      e.preventDefault();
    })
    .off('drop', '.favorite-item')
    .on('drop', '.favorite-item', async function() {
      const srcIdx = favoriteDragSrcIndex;
      const destIdx = $(this).data('index');
      if (srcIdx !== destIdx) {
        const favorites = await loadFavoritesFromSettings();
        [favorites[srcIdx], favorites[destIdx]] = [favorites[destIdx], favorites[srcIdx]];
        await saveFavoritesToSettings(favorites);
        await renderFavoritesList();
      }
    });
}

/**
 * Show the favorites right-click context menu
 */
export function showFavoritesContextMenu(x, y) {
  const $menu = buildFavoritesContextMenuEl();
  $menu.css({ position: 'fixed', left: x, top: y, zIndex: 10000 });
  $('body').append($menu);
}

/**
 * Build favorites context menu element
 */
export function buildFavoritesContextMenuEl() {
  const $menu = $(`
    <div id="favorites-context-menu" class="custom-context-menu">
      <div class="menu-item" data-action="remove-favorite">Remove</div>
    </div>
  `);
  $menu.on('click', '.menu-item', async function() {
    const action = $(this).data('action');
    if (action === 'remove-favorite') {
      await removeFromFavorites(favoritesContextMenuTarget);
    }
    hideFavoritesContextMenu();
  });
  return $menu;
}

/**
 * Hide context menu
 */
export function hideFavoritesContextMenu() {
  $('#favorites-context-menu').remove();
}
