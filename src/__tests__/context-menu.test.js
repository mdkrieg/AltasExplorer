/**
 * Context Menu Tests
 * Tests for w2ui context menu generation
 */

// Mock renderer.js functions for testing
const allCategories = {
  'Default': { name: 'Default', color: '#000000', icon: 'default.png' },
  'Project': { name: 'Project', color: '#FF0000', icon: 'project.png' },
  'Test': { name: 'Test', color: '#00FF00', icon: 'test.png' }
};

function generateW2UIContextMenu(selectedRecords, visiblePanelCount = 1) {
  const isMultiSelect = selectedRecords.length > 1;
  
  // Store context for onMenuClick handler
  panelContextMenuState = {
    selectedRecords: selectedRecords,
    isMultiSelect: isMultiSelect,
    selectedPaths: selectedRecords.map(r => r.path)
  };
  
  // Build "Open In" menu items for each available panel
  const availablePanels = [];
  for (let i = 1; i <= Math.min(visiblePanelCount + 1, 4); i++) {
    availablePanels.push(i);
  }
  
  const openInItems = availablePanels.map(panelNum => ({
    id: `open-in-${panelNum}`,
    text: `Panel ${panelNum}`,
    icon: 'fa fa-folder-open'
  }));
  
  // Build "Set Category" menu items for each category
  const categoryItems = Object.keys(allCategories).map(categoryName => ({
    id: `set-category-${categoryName}`,
    text: categoryName,
    icon: 'fa fa-tag'
  }));
  
  // Flatten into single menu array with separators
  const contextMenu = [];
  
  // Add "Open In" section
  contextMenu.push(...openInItems);
  
  // Separator
  contextMenu.push({ id: 'sep1', text: '-' });
  
  // Add "Set Category" section
  if (isMultiSelect) {
    contextMenu.push({
      id: 'set-category-label',
      text: 'Set Category (applies to all)',
      icon: 'fa fa-tags'
    });
  } else {
    contextMenu.push({
      id: 'set-category-label',
      text: 'Set Category',
      icon: 'fa fa-tag'
    });
  }
  
  // Add category items
  contextMenu.push(...categoryItems);
  
  return contextMenu;
}

// Mock state
let panelContextMenuState = {};

describe('w2ui Context Menu Generation', () => {
  describe('Menu Structure', () => {
    test('should return flat array of menu items', () => {
      const records = [{ path: 'C:\\test\\dir1', isFolder: true, filename: 'dir1' }];
      const menu = generateW2UIContextMenu(records, 1);
      
      expect(Array.isArray(menu)).toBe(true);
      expect(menu.length).toBeGreaterThan(0);
    });

    test('should have proper menu item structure with id and text', () => {
      const records = [{ path: 'C:\\test\\dir1', isFolder: true, filename: 'dir1' }];
      const menu = generateW2UIContextMenu(records, 1);
      
      menu.forEach(item => {
        expect(item).toHaveProperty('id');
        expect(item).toHaveProperty('text');
      });
    });

    test('should include separator', () => {
      const records = [{ path: 'C:\\test\\dir1', isFolder: true, filename: 'dir1' }];
      const menu = generateW2UIContextMenu(records, 1);
      
      const hasSeparator = menu.some(item => item.text === '-');
      expect(hasSeparator).toBe(true);
    });

    test('should have "Open In" panel items', () => {
      const records = [{ path: 'C:\\test\\dir1', isFolder: true, filename: 'dir1' }];
      const menu = generateW2UIContextMenu(records, 1);
      
      const panelItems = menu.filter(item => item.id.startsWith('open-in-'));
      expect(panelItems.length).toBeGreaterThan(0);
      expect(panelItems[0].text).toContain('Panel');
    });

    test('should have "Set Category" items', () => {
      const records = [{ path: 'C:\\test\\dir1', isFolder: true, filename: 'dir1' }];
      const menu = generateW2UIContextMenu(records, 1);
      
      const categoryItems = menu.filter(item => item.id.startsWith('set-category-') && item.id !== 'set-category-label');
      expect(categoryItems.length).toBeGreaterThan(0);
    });
  });

  describe('Single Directory Selection', () => {
    test('should show correct menu text for single selection', () => {
      const records = [{ path: 'C:\\test\\dir1', isFolder: true, filename: 'dir1' }];
      const menu = generateW2UIContextMenu(records, 1);
      
      const categoryLabel = menu.find(item => item.id === 'set-category-label');
      expect(categoryLabel.text).toBe('Set Category');
      expect(categoryLabel.text).not.toContain('applies to all');
    });

    test('should generate correct number of panel options for 1 visible panel', () => {
      const records = [{ path: 'C:\\test\\dir', isFolder: true, filename: 'dir' }];
      const menu = generateW2UIContextMenu(records, 1);
      
      const openInItems = menu.filter(item => item.id.startsWith('open-in-'));
      expect(openInItems.length).toBe(2); // Panels 1 and 2
    });

    test('should generate correct panel options for 2 visible panels', () => {
      const records = [{ path: 'C:\\test\\dir', isFolder: true, filename: 'dir' }];
      const menu = generateW2UIContextMenu(records, 2);
      
      const openInItems = menu.filter(item => item.id.startsWith('open-in-'));
      expect(openInItems.length).toBe(3); // Panels 1, 2, and 3
    });

    test('should generate correct panel options for 3 visible panels', () => {
      const records = [{ path: 'C:\\test\\dir', isFolder: true, filename: 'dir' }];
      const menu = generateW2UIContextMenu(records, 3);
      
      const openInItems = menu.filter(item => item.id.startsWith('open-in-'));
      expect(openInItems.length).toBe(4); // Panels 1, 2, 3, and 4
    });

    test('should not exceed 4 available panels', () => {
      const records = [{ path: 'C:\\test\\dir', isFolder: true, filename: 'dir' }];
      const menu = generateW2UIContextMenu(records, 4);
      
      const openInItems = menu.filter(item => item.id.startsWith('open-in-'));
      expect(openInItems.length).toBe(4); // Max is 4
      expect(openInItems.every((item, i) => item.text === `Panel ${i + 1}`)).toBe(true);
    });

    test('should include all available categories', () => {
      const records = [{ path: 'C:\\test\\dir', isFolder: true, filename: 'dir' }];
      const menu = generateW2UIContextMenu(records, 1);
      
      const categoryItems = menu.filter(item => item.id.startsWith('set-category-') && item.id !== 'set-category-label');
      const categoryTexts = categoryItems.map(item => item.text);
      
      expect(categoryTexts).toContain('Default');
      expect(categoryTexts).toContain('Project');
      expect(categoryTexts).toContain('Test');
    });
  });

  describe('Multi-Directory Selection', () => {
    test('should show "(applies to all)" text for multi-select', () => {
      const records = [
        { path: 'C:\\test\\dir1', isFolder: true, filename: 'dir1' },
        { path: 'C:\\test\\dir2', isFolder: true, filename: 'dir2' }
      ];
      const menu = generateW2UIContextMenu(records, 1);
      
      const categoryLabel = menu.find(item => item.id === 'set-category-label');
      expect(categoryLabel.text).toContain('applies to all');
    });

    test('should work with 3+ directory selection', () => {
      const records = [
        { path: 'C:\\test\\dir1', isFolder: true, filename: 'dir1' },
        { path: 'C:\\test\\dir2', isFolder: true, filename: 'dir2' },
        { path: 'C:\\test\\dir3', isFolder: true, filename: 'dir3' }
      ];
      const menu = generateW2UIContextMenu(records, 2);
      
      expect(Array.isArray(menu)).toBe(true);
      expect(menu.length).toBeGreaterThan(0);
      
      const categoryLabel = menu.find(item => item.id === 'set-category-label');
      expect(categoryLabel.text).toContain('applies to all');
    });
  });

  describe('Panel Availability', () => {
    test('should not offer panel 5 when max is 4', () => {
      const records = [{ path: 'C:\\test\\dir', isFolder: true, filename: 'dir' }];
      const menu = generateW2UIContextMenu(records, 3);
      
      const openInItems = menu.filter(item => item.id.startsWith('open-in-'));
      const panelTexts = openInItems.map(item => item.text);
      
      expect(panelTexts).toContain('Panel 4');
      expect(panelTexts).not.toContain('Panel 5');
    });

    test('should provide sequential panel numbers', () => {
      const records = [{ path: 'C:\\test\\dir', isFolder: true, filename: 'dir' }];
      
      for (let visible = 1; visible <= 3; visible++) {
        const menu = generateW2UIContextMenu(records, visible);
        const openInItems = menu.filter(item => item.id.startsWith('open-in-'));
        const expectedLength = visible + 1;
        
        expect(openInItems.length).toBe(expectedLength);
        openInItems.forEach((item, i) => {
          expect(item.text).toBe(`Panel ${i + 1}`);
        });
      }
    });
  });

  describe('Category Items', () => {
    test('should generate menu items for all categories', () => {
      const records = [{ path: 'C:\\test\\dir', isFolder: true, filename: 'dir' }];
      const menu = generateW2UIContextMenu(records, 1);
      
      const categoryItems = menu.filter(item => item.id.startsWith('set-category-') && item.id !== 'set-category-label');
      const categoryIds = categoryItems.map(item => item.id);
      
      expect(categoryIds).toContain('set-category-Default');
      expect(categoryIds).toContain('set-category-Project');
      expect(categoryIds).toContain('set-category-Test');
    });

    test('should have unique IDs for each category item', () => {
      const records = [{ path: 'C:\\test\\dir', isFolder: true, filename: 'dir' }];
      const menu = generateW2UIContextMenu(records, 1);
      
      const categoryItems = menu.filter(item => item.id.startsWith('set-category-'));
      const categoryIds = categoryItems.map(item => item.id);
      const uniqueIds = new Set(categoryIds);
      
      expect(uniqueIds.size).toBe(categoryIds.length);
    });
  });
});


