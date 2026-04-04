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
  $children.show();
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
  $children.hide();
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

// Favorites rendering, drag/drop, and context menu are handled by
// the w2sidebar implementation in renderer.js (initializeFavoritesSidebar).
