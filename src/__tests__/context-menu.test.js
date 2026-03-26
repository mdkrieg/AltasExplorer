/**
 * Context Menu Tests
 * Tests for context menu option generation and multi-select handling
 */

// Mock renderer.js functions for testing
function generateContextMenuOptions(selectedRecords, visiblePanelCount = 1) {
  const isMultiSelect = selectedRecords.length > 1;
  const hasDirectories = selectedRecords.some(record => record.isFolder);
  const hasFiles = selectedRecords.some(record => !record.isFolder);
  
  // Available panels: current visible panels plus one more if not at max (4)
  const availablePanels = [];
  for (let i = 1; i <= Math.min(visiblePanelCount + 1, 4); i++) {
    availablePanels.push(i);
  }
  
  return {
    isMultiSelect,
    hasDirectories,
    hasFiles,
    availablePanels,
    // Can apply bulk operations to directories in multi-select
    canApplyBulkOps: hasDirectories,
    // Send To is available for single-select OR multi-select with all directories
    canSendTo: !hasFiles || !isMultiSelect
  };
}

describe('Context Menu Options Generation', () => {
  describe('Single Directory Selection', () => {
    test('should show options for single directory', () => {
      const records = [
        { path: 'C:\\test\\dir1', isFolder: true, filename: 'dir1' }
      ];
      const options = generateContextMenuOptions(records, 1);
      
      expect(options.isMultiSelect).toBe(false);
      expect(options.hasDirectories).toBe(true);
      expect(options.hasFiles).toBe(false);
      expect(options.canApplyBulkOps).toBe(true);
      expect(options.canSendTo).toBe(true);
    });

    test('should provide correct available panels when 1 panel visible', () => {
      const records = [{ path: 'C:\\test\\dir', isFolder: true, filename: 'dir' }];
      const options = generateContextMenuOptions(records, 1);
      
      expect(options.availablePanels).toEqual([1, 2]);
    });

    test('should provide correct available panels when 2 panels visible', () => {
      const records = [{ path: 'C:\\test\\dir', isFolder: true, filename: 'dir' }];
      const options = generateContextMenuOptions(records, 2);
      
      expect(options.availablePanels).toEqual([1, 2, 3]);
    });

    test('should not exceed 4 available panels', () => {
      const records = [{ path: 'C:\\test\\dir', isFolder: true, filename: 'dir' }];
      const options = generateContextMenuOptions(records, 4);
      
      expect(options.availablePanels).toEqual([1, 2, 3, 4]);
      expect(options.availablePanels.length).toBe(4);
    });
  });

  describe('Multi-Directory Selection', () => {
    test('should identify multi-select correctly', () => {
      const records = [
        { path: 'C:\\test\\dir1', isFolder: true, filename: 'dir1' },
        { path: 'C:\\test\\dir2', isFolder: true, filename: 'dir2' }
      ];
      const options = generateContextMenuOptions(records, 1);
      
      expect(options.isMultiSelect).toBe(true);
      expect(options.hasDirectories).toBe(true);
      expect(options.hasFiles).toBe(false);
      expect(options.canApplyBulkOps).toBe(true);
      expect(options.canSendTo).toBe(true);
    });

    test('should handle 3+ directory selection', () => {
      const records = [
        { path: 'C:\\test\\dir1', isFolder: true, filename: 'dir1' },
        { path: 'C:\\test\\dir2', isFolder: true, filename: 'dir2' },
        { path: 'C:\\test\\dir3', isFolder: true, filename: 'dir3' }
      ];
      const options = generateContextMenuOptions(records, 2);
      
      expect(options.isMultiSelect).toBe(true);
      expect(options.hasDirectories).toBe(true);
      expect(options.canApplyBulkOps).toBe(true);
    });
  });

  describe('Mixed Selection (Directories and Files)', () => {
    test('should identify mixed selection', () => {
      const records = [
        { path: 'C:\\test\\dir1', isFolder: true, filename: 'dir1' },
        { path: 'C:\\test\\file.txt', isFolder: false, filename: 'file.txt' }
      ];
      const options = generateContextMenuOptions(records, 1);
      
      expect(options.isMultiSelect).toBe(true);
      expect(options.hasDirectories).toBe(true);
      expect(options.hasFiles).toBe(true);
      expect(options.canApplyBulkOps).toBe(true);
      // Send To should NOT be available when multi-select contains files
      expect(options.canSendTo).toBe(false);
    });

    test('should disable Send To for mixed multi-select', () => {
      const records = [
        { path: 'C:\\test\\dir1', isFolder: true, filename: 'dir1' },
        { path: 'C:\\test\\file1.txt', isFolder: false, filename: 'file1.txt' },
        { path: 'C:\\test\\dir2', isFolder: true, filename: 'dir2' }
      ];
      const options = generateContextMenuOptions(records, 2);
      
      expect(options.canSendTo).toBe(false);
      expect(options.canApplyBulkOps).toBe(true);
    });
  });

  describe('File-Only Selection', () => {
    test('should mark files in selection', () => {
      const records = [
        { path: 'C:\\test\\file.txt', isFolder: false, filename: 'file.txt' }
      ];
      const options = generateContextMenuOptions(records, 1);
      
      expect(options.hasFiles).toBe(true);
      expect(options.hasDirectories).toBe(false);
      expect(options.canApplyBulkOps).toBe(false);
      // Send To available for single file (per original behavior)
      expect(options.canSendTo).toBe(true);
    });

    test('should disable operations for file-only multi-select', () => {
      const records = [
        { path: 'C:\\test\\file1.txt', isFolder: false, filename: 'file1.txt' },
        { path: 'C:\\test\\file2.txt', isFolder: false, filename: 'file2.txt' }
      ];
      const options = generateContextMenuOptions(records, 1);
      
      expect(options.isMultiSelect).toBe(true);
      expect(options.hasDirectories).toBe(false);
      expect(options.canApplyBulkOps).toBe(false);
      expect(options.canSendTo).toBe(false);
    });
  });

  describe('Panel Availability', () => {
    test('should show option to open in panel 5 is blocked at max (4)', () => {
      const records = [{ path: 'C:\\test\\dir', isFolder: true, filename: 'dir' }];
      const options = generateContextMenuOptions(records, 3);
      
      // With 3 visible, we should offer panels 1,2,3,4 (next available is 4)
      expect(options.availablePanels).toEqual([1, 2, 3, 4]);
      expect(options.availablePanels).not.toContain(5);
    });

    test('should provide sequential panel numbers', () => {
      const records = [{ path: 'C:\\test\\dir', isFolder: true, filename: 'dir' }];
      
      for (let visible = 1; visible <= 3; visible++) {
        const options = generateContextMenuOptions(records, visible);
        const expected = Array.from({ length: visible + 1 }, (_, i) => i + 1);
        expect(options.availablePanels).toEqual(expected);
      }
    });
  });
});
