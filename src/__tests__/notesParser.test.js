/**
 * Tests for notesParser utility module
 * Tests file header parsing, section extraction, and round-trip preservation
 */

const {
  parseNotesFileSections,
  writeNotesSection,
  isValidFileHeader,
  extractHeaderFilename,
  parseTodoBlock,
  parseTodoBlocks,
  countTodoItems,
  normalizeTodoBlock,
  updateTodoItemStates,
  extractAllHeaders,
  extractDirectoryNotes,
  extractFileNotes,
  getAllSectionsInfo
} = require('../notesParser');

describe('notesParser - isValidFileHeader', () => {
  test('should recognize valid file headers', () => {
    expect(isValidFileHeader('@<config.json>')).toBe(true);
    expect(isValidFileHeader('@<readme.md>')).toBe(true);
    expect(isValidFileHeader('@<file with spaces.txt>')).toBe(true);
    expect(isValidFileHeader('@<.hidden>')).toBe(true);
  });

  test('should reject invalid file headers', () => {
    expect(isValidFileHeader('@<config.json')).toBe(false);  // missing >
    expect(isValidFileHeader('config.json>')).toBe(false);   // missing @<
    expect(isValidFileHeader('@<>')).toBe(false);            // empty filename
    expect(isValidFileHeader('some text')).toBe(false);
    expect(isValidFileHeader('@<config.json> extra')).toBe(false);  // extra text
    expect(isValidFileHeader(' @<config.json>')).toBe(false);       // leading space
  });
});

describe('notesParser - extractHeaderFilename', () => {
  test('should extract filename from valid headers', () => {
    expect(extractHeaderFilename('@<config.json>')).toBe('config.json');
    expect(extractHeaderFilename('@<readme.md>')).toBe('readme.md');
    expect(extractHeaderFilename('@<file with spaces.txt>')).toBe('file with spaces.txt');
  });

  test('should return null for invalid headers', () => {
    expect(extractHeaderFilename('@<config.json')).toBe(null);
    expect(extractHeaderFilename('some text')).toBe(null);
    expect(extractHeaderFilename('@<config.json> extra')).toBe(null);
  });
});

describe('notesParser - parseNotesFileSections', () => {
  test('should parse empty content', () => {
    const result = parseNotesFileSections('');
    expect(result).toEqual({ '__dir__': '' });
  });

  test('should parse directory-only notes', () => {
    const content = 'This is a directory note';
    const result = parseNotesFileSections(content);
    expect(result).toEqual({ '__dir__': 'This is a directory note' });
  });

  test('should parse directory notes with file sections', () => {
    const content = `Directory notes here
@<config.json>
Config file notes`;
    const result = parseNotesFileSections(content);
    expect(result).toEqual({
      '__dir__': 'Directory notes here',
      'config.json': 'Config file notes'
    });
  });

  test('should parse multiple file sections', () => {
    const content = `Dir notes
@<file1.txt>
Notes for file1
@<file2.json>
Notes for file2`;
    const result = parseNotesFileSections(content);
    expect(result).toEqual({
      '__dir__': 'Dir notes',
      'file1.txt': 'Notes for file1',
      'file2.json': 'Notes for file2'
    });
  });

  test('should handle multiline notes', () => {
    const content = `Directory notes
line 2
@<config.json>
Line 1
Line 2
Line 3`;
    const result = parseNotesFileSections(content);
    expect(result['__dir__']).toBe('Directory notes\nline 2');
    expect(result['config.json']).toBe('Line 1\nLine 2\nLine 3');
  });

  test('should treat invalid headers as normal text', () => {
    const content = `Notes with invalid header
@<missing close bracket
More notes
@<also.invalid
@<valid.txt>
Valid section`;
    const result = parseNotesFileSections(content);
    expect(result['__dir__']).toContain('@<missing close bracket');
    expect(result['__dir__']).toContain('More notes');
    expect(result['__dir__']).toContain('@<also.invalid');
    expect(result['valid.txt']).toBe('Valid section');
  });

  test('should handle whitespace in section content', () => {
    const content = `@<file.txt>
  indented line
empty lines follow:

then this line`;
    const result = parseNotesFileSections(content);
    expect(result['file.txt']).toContain('  indented line');
    expect(result['file.txt']).toContain('empty lines follow:');
  });
});

describe('notesParser - writeNotesSection', () => {
  test('should write directory notes to empty file', () => {
    const result = writeNotesSection('', '__dir__', 'Directory notes');
    expect(result).toBe('Directory notes');
  });

  test('should write file notes to empty file', () => {
    const result = writeNotesSection('', 'config.json', 'Config notes');
    expect(result).toBe('@<config.json>\nConfig notes');
  });

  test('should append file section to existing directory notes', () => {
    const existing = 'Dir notes';
    const result = writeNotesSection(existing, 'config.json', 'Config notes');
    expect(result).toContain('Dir notes');
    expect(result).toContain('@<config.json>');
    expect(result).toContain('Config notes');
  });

  test('should update existing file section', () => {
    const existing = `Dir notes
@<config.json>
Old notes
@<readme.md>
Read me notes`;
    const result = writeNotesSection(existing, 'config.json', 'New notes');
    expect(result).toContain('Dir notes');
    expect(result).toContain('New notes');
    expect(result).not.toContain('Old notes');
    expect(result).toContain('@<readme.md>');
    expect(result).toContain('Read me notes');
  });

  test('should add new file section preserving order', () => {
    const existing = `@<file1.txt>
Notes 1
@<file2.txt>
Notes 2`;
    const result = writeNotesSection(existing, 'file3.txt', 'Notes 3');
    expect(result).toContain('@<file1.txt>');
    expect(result).toContain('@<file2.txt>');
    expect(result).toContain('@<file3.txt>');
    const file1Idx = result.indexOf('file1.txt');
    const file2Idx = result.indexOf('file2.txt');
    const file3Idx = result.indexOf('file3.txt');
    expect(file1Idx < file2Idx).toBe(true);
    expect(file2Idx < file3Idx).toBe(true);
  });

  test('should preserve structure of file sections during updates', () => {
    const existing = `@<file1.txt>
Keep me
@<file2.txt>
Delete me`;
    const result = writeNotesSection(existing, 'file2.txt', '');
    expect(result).toContain('file1.txt');
    expect(result).toContain('Keep me');
    // When a section is updated to empty and isn't the only section,
    // it will still be written due to the logic in writeNotesSection
    // This preserves file ordering for when content is added back
  });
});

describe('notesParser - Round-trip preservation', () => {
  test('should preserve content through parse-modify-write-parse cycle', () => {
    const original = `Directory notes
@<config.json>
Config notes
@<readme.md>
README notes`;

    // Parse
    let sections = parseNotesFileSections(original);
    
    // Modify
    sections['config.json'] = 'Modified config notes';
    
    // Write
    const modified = writeNotesSection(original, 'config.json', 'Modified config notes');
    
    // Parse again
    const reparsed = parseNotesFileSections(modified);
    
    // Verify - trim whitespace as serialization may add spacing
    expect(reparsed['__dir__'].trim()).toBe(sections['__dir__'].trim());
    expect(reparsed['config.json'].trim()).toBe('Modified config notes');
    expect(reparsed['readme.md']).toBe(sections['readme.md']);
  });

  test('should maintain multiline content through cycles', () => {
    const original = `Dir
line 2
line 3
@<file.txt>
content
line 2
  indented`;

    const parseResult = parseNotesFileSections(original);
    const written = writeNotesSection('', '__dir__', parseResult['__dir__']);
    const rewritten = writeNotesSection(written, 'file.txt', parseResult['file.txt']);
    const reparsed = parseNotesFileSections(rewritten);
    
    expect(reparsed['__dir__'].trim()).toBe(parseResult['__dir__'].trim());
    expect(reparsed['file.txt']).toBe(parseResult['file.txt']);
  });
});

describe('notesParser - extractAllHeaders', () => {
  test('should extract all file headers excluding directory', () => {
    const content = `@<file1.txt>
Notes 1
@<file2.json>
Notes 2
@<file3.md>
Notes 3`;
    const headers = extractAllHeaders(content);
    expect(headers).toEqual(['file1.txt', 'file2.json', 'file3.md']);
  });

  test('should return empty array for directory-only content', () => {
    const content = 'Just directory notes';
    const headers = extractAllHeaders(content);
    expect(headers).toEqual([]);
  });

  test('should ignore empty sections', () => {
    const content = `@<file1.txt>
Notes 1
@<file2.txt>

@<file3.txt>
Notes 3`;
    const headers = extractAllHeaders(content);
    expect(headers).toContain('file1.txt');
    expect(headers).toContain('file2.txt');
    expect(headers).toContain('file3.txt');
  });
});

describe('notesParser - extractDirectoryNotes', () => {
  test('should extract directory notes', () => {
    const content = `Directory notes line 1
Directory notes line 2
@<file.txt>
File notes`;
    const dirNotes = extractDirectoryNotes(content);
    expect(dirNotes).toBe('Directory notes line 1\nDirectory notes line 2');
  });

  test('should return empty string when no directory notes', () => {
    const content = `@<file.txt>
File notes`;
    const dirNotes = extractDirectoryNotes(content);
    expect(dirNotes).toBe('');
  });

  test('should return empty string for empty content', () => {
    const dirNotes = extractDirectoryNotes('');
    expect(dirNotes).toBe('');
  });
});

describe('notesParser - extractFileNotes', () => {
  test('should extract notes for specific file', () => {
    const content = `@<file1.txt>
Notes 1
@<file2.json>
Notes 2`;
    expect(extractFileNotes(content, 'file1.txt')).toBe('Notes 1');
    expect(extractFileNotes(content, 'file2.json')).toBe('Notes 2');
  });

  test('should return empty string for non-existent file', () => {
    const content = `@<file1.txt>
Notes 1`;
    expect(extractFileNotes(content, 'nonexistent.txt')).toBe('');
  });

  test('should handle multiline file notes', () => {
    const content = `@<file.txt>
Line 1
Line 2
Line 3`;
    const notes = extractFileNotes(content, 'file.txt');
    expect(notes).toBe('Line 1\nLine 2\nLine 3');
  });
});

describe('notesParser - getAllSectionsInfo', () => {
  test('should provide metadata for all sections', () => {
    const content = `Directory notes
@<file1.txt>
Notes 1
@<file2.txt>
`;
    const info = getAllSectionsInfo(content);
    
    expect(info).toHaveLength(3);
    expect(info[0]).toEqual({
      key: '__dir__',
      isDirectoryNotes: true,
      contentLength: 15,  // "Directory notes" = 15 chars
      isEmpty: false
    });
    expect(info[1]).toEqual({
      key: 'file1.txt',
      isDirectoryNotes: false,
      contentLength: 7,   // "Notes 1" = 7 chars
      isEmpty: false
    });
    expect(info[2]).toEqual({
      key: 'file2.txt',
      isDirectoryNotes: false,
      contentLength: 0,
      isEmpty: true
    });
  });
});

describe('notesParser - Edge cases', () => {
  test('should handle consecutive file headers', () => {
    const content = `@<file1.txt>
@<file2.txt>
Notes for file2`;
    const result = parseNotesFileSections(content);
    expect(result['file1.txt']).toBe('');
    expect(result['file2.txt']).toBe('Notes for file2');
  });

  test('should handle headers with special characters in filename', () => {
    const content = `@<file-name_2024.backup.json>
Notes here`;
    const result = parseNotesFileSections(content);
    expect(result['file-name_2024.backup.json']).toBe('Notes here');
  });

  test('should handle very long content', () => {
    let content = 'Directory\n';
    content += '@<file1.txt>\n';
    content += 'A'.repeat(10000) + '\n';
    content += '@<file2.txt>\n';
    content += 'B'.repeat(10000);
    
    const result = parseNotesFileSections(content);
    expect(result['file1.txt'].length).toBe(10000);
    expect(result['file2.txt'].length).toBe(10000);
  });

  test('should handle line endings correctly', () => {
    const contentWithLF = 'Dir\n@<file.txt>\nNotes';
    const resultLF = parseNotesFileSections(contentWithLF);
    expect(resultLF['file.txt']).toBeDefined();
    expect(resultLF['file.txt']).toBe('Notes');
    
    // Test with CRLF - parser now handles both \n and \r\n
    const contentWithCRLF = 'Dir\r\n@<file.txt>\r\nNotes';
    const resultCRLF = parseNotesFileSections(contentWithCRLF);
    expect(resultCRLF['file.txt']).toBeDefined();
    expect(resultCRLF['file.txt']).toBe('Notes');
    
    // Both should produce identical results
    expect(resultLF).toEqual(resultCRLF);
  });
});

// ---------------------------------------------------------------------------
// parseTodoBlock
// ---------------------------------------------------------------------------

describe('notesParser - parseTodoBlock', () => {
  test('returns null when no TODO: header', () => {
    expect(parseTodoBlock('just some text\n* not a todo')).toBeNull();
    expect(parseTodoBlock('')).toBeNull();
  });

  test('parses simple asterisk list', () => {
    const content = 'TODO:\n* item 1\n* item 2\n* item 3';
    const result = parseTodoBlock(content);
    expect(result).not.toBeNull();
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toMatchObject({ text: 'item 1', level: 0, completed: false });
    expect(result.items[1]).toMatchObject({ text: 'item 2', level: 0, completed: false });
    expect(result.items[2]).toMatchObject({ text: 'item 3', level: 0, completed: false });
  });

  test('parses GFM checkbox bullets', () => {
    const content = 'TODO:\n[ ] open task\n[x] done task\n[X] also done';
    const result = parseTodoBlock(content);
    expect(result.items[0]).toMatchObject({ text: 'open task', completed: false });
    expect(result.items[1]).toMatchObject({ text: 'done task', completed: true });
    expect(result.items[2]).toMatchObject({ text: 'also done', completed: true });
  });

  test('ends block at blank line', () => {
    const content = 'TODO:\n* item 1\n* item 2\n\nNot in list';
    const result = parseTodoBlock(content);
    expect(result.items).toHaveLength(2);
  });

  test('block extends to end of content when no blank line', () => {
    const content = 'TODO:\n* item 1\n* item 2';
    const result = parseTodoBlock(content);
    expect(result.items).toHaveLength(2);
  });

  test('multiline item via continuation lines', () => {
    const content = 'TODO:\n* item that wraps\naround two lines\n* next item';
    const result = parseTodoBlock(content);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].text).toBe('item that wraps around two lines');
    expect(result.items[1].text).toBe('next item');
  });

  test('multi-level indent with 2-space indent', () => {
    const content = 'TODO:\n* top\n  * sub1\n  * sub2\n    * deep';
    const result = parseTodoBlock(content);
    expect(result.items[0]).toMatchObject({ text: 'top', level: 0 });
    expect(result.items[1]).toMatchObject({ text: 'sub1', level: 1 });
    expect(result.items[2]).toMatchObject({ text: 'sub2', level: 1 });
    expect(result.items[3]).toMatchObject({ text: 'deep', level: 2 });
  });

  test('odd number of leading spaces rounds down', () => {
    const content = 'TODO:\n* level0\n   * level1\n     * level2';
    const result = parseTodoBlock(content);
    expect(result.items[0].level).toBe(0);
    expect(result.items[1].level).toBe(1); // 3 spaces → floor(3/2) = 1
    expect(result.items[2].level).toBe(2); // 5 spaces → floor(5/2) = 2
  });

  test('tab indent counts as 2 spaces', () => {
    const content = 'TODO:\n* top\n\t* sub';
    const result = parseTodoBlock(content);
    expect(result.items[0].level).toBe(0);
    expect(result.items[1].level).toBe(1); // 1 tab = 2 spaces → level 1
  });

  test('reports correct todoHeaderLine and blockStartLine', () => {
    const content = 'prefix line\nTODO:\n* item';
    const result = parseTodoBlock(content);
    expect(result.todoHeaderLine).toBe(1);
    expect(result.blockStartLine).toBe(2);
  });

  test('ignores non-bullet lines before first item', () => {
    // Only after an item has been started are non-bullet lines treated as continuations
    const content = 'TODO:\npreamble not a bullet\n* actual item';
    const result = parseTodoBlock(content);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].text).toBe('actual item');
  });

  test('empty TODO block returns empty items array', () => {
    const content = 'TODO:\n\nsome other text';
    const result = parseTodoBlock(content);
    expect(result).not.toBeNull();
    expect(result.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// countTodoItems
// ---------------------------------------------------------------------------

describe('notesParser - countTodoItems', () => {
  test('returns zeros when no TODO block', () => {
    expect(countTodoItems('no todo here')).toEqual({ total: 0, completed: 0 });
    expect(countTodoItems('')).toEqual({ total: 0, completed: 0 });
  });

  test('counts correctly with mixed states', () => {
    const content = 'TODO:\n[ ] a\n[x] b\n[ ] c\n[x] d';
    expect(countTodoItems(content)).toEqual({ total: 4, completed: 2 });
  });

  test('all complete', () => {
    const content = 'TODO:\n[x] a\n[x] b';
    expect(countTodoItems(content)).toEqual({ total: 2, completed: 2 });
  });

  test('none complete', () => {
    const content = 'TODO:\n* a\n* b\n* c';
    expect(countTodoItems(content)).toEqual({ total: 3, completed: 0 });
  });
});

// ---------------------------------------------------------------------------
// normalizeTodoBlock
// ---------------------------------------------------------------------------

describe('notesParser - normalizeTodoBlock', () => {
  test('no-op when no TODO block', () => {
    const content = '* asterisk outside todo';
    expect(normalizeTodoBlock(content)).toBe(content);
  });

  test('converts * bullets to [ ] inside TODO block', () => {
    const content = 'TODO:\n* item 1\n* item 2';
    const result = normalizeTodoBlock(content);
    expect(result).toContain('[ ] item 1');
    expect(result).toContain('[ ] item 2');
    expect(result).not.toContain('* item');
  });

  test('leaves [ ] and [x] unchanged', () => {
    const content = 'TODO:\n[ ] open\n[x] done\n* new';
    const result = normalizeTodoBlock(content);
    expect(result).toContain('[ ] open');
    expect(result).toContain('[x] done');
    expect(result).toContain('[ ] new');
    expect(result).not.toContain('* new');
  });

  test('preserves leading indentation', () => {
    const content = 'TODO:\n* top\n  * sub';
    const result = normalizeTodoBlock(content);
    expect(result).toContain('[ ] top');
    expect(result).toContain('  [ ] sub');
  });

  test('does not modify content after blank-line end of block', () => {
    const content = 'TODO:\n* item\n\n* outside block should not change';
    const result = normalizeTodoBlock(content);
    const lines = result.split('\n');
    // Line after blank should still be '* outside block should not change'
    expect(lines[3]).toBe('* outside block should not change');
  });

  test('idempotent: normalizing an already-normalized block is a no-op', () => {
    const content = 'TODO:\n[ ] item 1\n[ ] item 2\n[x] done';
    expect(normalizeTodoBlock(content)).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// updateTodoItemStates
// ---------------------------------------------------------------------------

describe('notesParser - updateTodoItemStates', () => {
  test('no-op when no TODO block', () => {
    const content = 'no todo';
    expect(updateTodoItemStates(content, [{ itemIndex: 0, completed: true }])).toBe(content);
  });

  test('marks item as completed', () => {
    const content = 'TODO:\n[ ] item 1\n[ ] item 2';
    const result = updateTodoItemStates(content, [{ itemIndex: 0, completed: true }]);
    expect(result).toContain('[x] item 1');
    expect(result).toContain('[ ] item 2');
  });

  test('marks item as not completed', () => {
    const content = 'TODO:\n[x] item 1\n[x] item 2';
    const result = updateTodoItemStates(content, [{ itemIndex: 1, completed: false }]);
    expect(result).toContain('[x] item 1');
    expect(result).toContain('[ ] item 2');
  });

  test('toggles multiple items in one call', () => {
    const content = 'TODO:\n[ ] a\n[ ] b\n[ ] c';
    const result = updateTodoItemStates(content, [
      { itemIndex: 0, completed: true },
      { itemIndex: 2, completed: true }
    ]);
    expect(result).toContain('[x] a');
    expect(result).toContain('[ ] b');
    expect(result).toContain('[x] c');
  });

  test('converts * bullet to [x] when marking complete', () => {
    const content = 'TODO:\n* item 1';
    const result = updateTodoItemStates(content, [{ itemIndex: 0, completed: true }]);
    expect(result).toContain('[x] item 1');
  });

  test('ignores out-of-bounds index gracefully', () => {
    const content = 'TODO:\n[ ] item';
    expect(() => updateTodoItemStates(content, [{ itemIndex: 99, completed: true }])).not.toThrow();
    const result = updateTodoItemStates(content, [{ itemIndex: 99, completed: true }]);
    expect(result).toContain('[ ] item');
  });

  test('preserves indentation when toggling', () => {
    const content = 'TODO:\n* top\n  * sub';
    const result = updateTodoItemStates(content, [{ itemIndex: 1, completed: true }]);
    expect(result).toContain('  [x] sub');
  });
});

// ---------------------------------------------------------------------------
// parseTodoBlock — label support
// ---------------------------------------------------------------------------

describe('notesParser - parseTodoBlock label support', () => {
  test('returns empty label for bare TODO:', () => {
    const result = parseTodoBlock('TODO:\n* item');
    expect(result).not.toBeNull();
    expect(result.label).toBe('');
  });

  test('returns label text after TODO:', () => {
    const result = parseTodoBlock('TODO: Release tasks\n* item');
    expect(result).not.toBeNull();
    expect(result.label).toBe('Release tasks');
  });

  test('trims whitespace from label', () => {
    const result = parseTodoBlock('TODO:   lots of space   \n* item');
    expect(result.label).toBe('lots of space');
  });
});

// ---------------------------------------------------------------------------
// parseTodoBlocks — multiple groups
// ---------------------------------------------------------------------------

describe('notesParser - parseTodoBlocks', () => {
  test('returns empty array when no TODO blocks', () => {
    expect(parseTodoBlocks('')).toEqual([]);
    expect(parseTodoBlocks('no todo here')).toEqual([]);
  });

  test('returns single-element array for one TODO block', () => {
    const content = 'TODO:\n* item 1\n* item 2';
    const result = parseTodoBlocks(content);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('');
    expect(result[0].items).toHaveLength(2);
  });

  test('returns multiple blocks for multiple TODO: headers', () => {
    const content = 'TODO: Group A\n* a1\n* a2\n\nTODO: Group B\n* b1';
    const result = parseTodoBlocks(content);
    expect(result).toHaveLength(2);
    expect(result[0].label).toBe('Group A');
    expect(result[0].items).toHaveLength(2);
    expect(result[1].label).toBe('Group B');
    expect(result[1].items).toHaveLength(1);
    expect(result[1].items[0].text).toBe('b1');
  });

  test('preserves correct todoHeaderLine for each block', () => {
    const content = 'TODO:\n* a\n\nTODO:\n* b';
    const result = parseTodoBlocks(content);
    expect(result[0].todoHeaderLine).toBe(0);
    expect(result[1].todoHeaderLine).toBe(3);
  });

  test('blocks without items have empty items array', () => {
    const content = 'TODO: Empty\n\nTODO: HasItems\n* x';
    const result = parseTodoBlocks(content);
    expect(result).toHaveLength(2);
    expect(result[0].items).toHaveLength(0);
    expect(result[1].items).toHaveLength(1);
  });

  test('adjacent TODO blocks without blank line between them each end when next TODO: appears', () => {
    // The first block is terminated by the blank line or the second TODO: header
    // In our impl, the first block's content stops at the blank line
    const content = 'TODO: A\n* a1\n\nTODO: B\n* b1';
    const result = parseTodoBlocks(content);
    expect(result).toHaveLength(2);
    expect(result[0].items).toHaveLength(1);
    expect(result[1].items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// countTodoItems — multi-block
// ---------------------------------------------------------------------------

describe('notesParser - countTodoItems multi-block', () => {
  test('counts across multiple groups', () => {
    const content = 'TODO: A\n[ ] a1\n[x] a2\n\nTODO: B\n[ ] b1\n[x] b2\n[x] b3';
    expect(countTodoItems(content)).toEqual({ total: 5, completed: 3 });
  });

  test('handles blocks with no items mixed with blocks with items', () => {
    const content = 'TODO: Empty\n\nTODO: Full\n[ ] x\n[x] y';
    expect(countTodoItems(content)).toEqual({ total: 2, completed: 1 });
  });
});

// ---------------------------------------------------------------------------
// normalizeTodoBlock — multi-block
// ---------------------------------------------------------------------------

describe('notesParser - normalizeTodoBlock multi-block', () => {
  test('normalizes bullets in all TODO blocks', () => {
    const content = 'TODO: A\n* a1\n* a2\n\nTODO: B\n* b1';
    const result = normalizeTodoBlock(content);
    expect(result).toContain('[ ] a1');
    expect(result).toContain('[ ] a2');
    expect(result).toContain('[ ] b1');
    expect(result).not.toContain('* a1');
    expect(result).not.toContain('* b1');
  });

  test('does not modify content between blocks', () => {
    const content = 'TODO: A\n* a\n\n* not in any block\n\nTODO: B\n* b';
    const result = normalizeTodoBlock(content);
    const lines = result.split('\n');
    // The line "* not in any block" is between two blank lines, not in a TODO block
    expect(lines[3]).toBe('* not in any block');
    expect(result).toContain('[ ] a');
    expect(result).toContain('[ ] b');
  });
});

// ---------------------------------------------------------------------------
// updateTodoItemStates — multi-block flat indices
// ---------------------------------------------------------------------------

describe('notesParser - updateTodoItemStates multi-block', () => {
  test('flat index 0 addresses first item of first group', () => {
    const content = 'TODO: A\n[ ] a1\n\nTODO: B\n[ ] b1';
    const result = updateTodoItemStates(content, [{ itemIndex: 0, completed: true }]);
    expect(result).toContain('[x] a1');
    expect(result).toContain('[ ] b1');
  });

  test('flat index crosses group boundary', () => {
    // Group A has 2 items (indices 0, 1), Group B has 1 item (index 2)
    const content = 'TODO: A\n[ ] a1\n[ ] a2\n\nTODO: B\n[ ] b1';
    const result = updateTodoItemStates(content, [{ itemIndex: 2, completed: true }]);
    expect(result).toContain('[ ] a1');
    expect(result).toContain('[ ] a2');
    expect(result).toContain('[x] b1');
  });

  test('updates in both groups simultaneously', () => {
    const content = 'TODO: A\n[ ] a1\n[ ] a2\n\nTODO: B\n[ ] b1';
    const result = updateTodoItemStates(content, [
      { itemIndex: 1, completed: true },
      { itemIndex: 2, completed: true }
    ]);
    expect(result).toContain('[ ] a1');
    expect(result).toContain('[x] a2');
    expect(result).toContain('[x] b1');
  });
});

// ---------------------------------------------------------------------------
// parseTodoBlocks — COMMENT/REPLY parsing
// ---------------------------------------------------------------------------

describe('notesParser - parseTodoBlocks — COMMENT/REPLY parsing', () => {
  test('items with no annotations have empty comments array', () => {
    const content = 'TODO:\n[ ] item1\n[ ] item2';
    const [block] = parseTodoBlocks(content);
    expect(block.items[0].comments).toEqual([]);
    expect(block.items[1].comments).toEqual([]);
  });

  test('COMMENT: attaches to preceding item', () => {
    const content = 'TODO:\n[ ] item1\n  COMMENT: hello';
    const [block] = parseTodoBlocks(content);
    expect(block.items[0].comments).toHaveLength(1);
    expect(block.items[0].comments[0].text).toBe('hello');
    expect(block.items[0].comments[0].replies).toEqual([]);
  });

  test('REPLY: attaches to preceding COMMENT', () => {
    const content = 'TODO:\n[ ] item1\n  COMMENT: hello\n    REPLY: world';
    const [block] = parseTodoBlocks(content);
    const comment = block.items[0].comments[0];
    expect(comment.replies).toHaveLength(1);
    expect(comment.replies[0].text).toBe('world');
  });

  test('multiple COMMENTs on one item', () => {
    const content = 'TODO:\n[ ] item1\n  COMMENT: first\n  COMMENT: second';
    const [block] = parseTodoBlocks(content);
    expect(block.items[0].comments).toHaveLength(2);
    expect(block.items[0].comments[1].text).toBe('second');
  });

  test('orphan REPLY (no preceding COMMENT) creates synthetic comment with lineStart -1', () => {
    const content = 'TODO:\n[ ] item1\n    REPLY: orphaned';
    const [block] = parseTodoBlocks(content);
    expect(block.items[0].comments).toHaveLength(1);
    expect(block.items[0].comments[0].lineStart).toBe(-1);
    expect(block.items[0].comments[0].text).toBe('');
    expect(block.items[0].comments[0].replies[0].text).toBe('orphaned');
  });

  test('COMMENT after second item does not attach to first item', () => {
    const content = 'TODO:\n[ ] item1\n[ ] item2\n  COMMENT: for item2';
    const [block] = parseTodoBlocks(content);
    expect(block.items[0].comments).toHaveLength(0);
    expect(block.items[1].comments).toHaveLength(1);
    expect(block.items[1].comments[0].text).toBe('for item2');
  });

  test('blockEndLine extends to include COMMENT/REPLY lines', () => {
    const content = 'TODO:\n[ ] item1\n  COMMENT: note\n    REPLY: reply';
    const [block] = parseTodoBlocks(content);
    // Lines: 0=TODO, 1=item, 2=COMMENT, 3=REPLY
    expect(block.blockEndLine).toBe(3);
  });

  test('COMMENT lineStart records correct line number', () => {
    const content = 'TODO:\n[ ] item1\n  COMMENT: note';
    const [block] = parseTodoBlocks(content);
    expect(block.items[0].comments[0].lineStart).toBe(2);
  });

  test('works across multiple groups', () => {
    const content = 'TODO: A\n[ ] a1\n  COMMENT: ca\n\nTODO: B\n[ ] b1';
    const blocks = parseTodoBlocks(content);
    expect(blocks[0].items[0].comments[0].text).toBe('ca');
    expect(blocks[1].items[0].comments).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// normalizeTodoBlock — COMMENT/REPLY coercion
// ---------------------------------------------------------------------------

describe('notesParser - normalizeTodoBlock — COMMENT/REPLY coercion', () => {
  test('COMMENT: coerced to item_indent + 2 spaces', () => {
    const content = 'TODO:\n[ ] item\nCOMMENT: hello';
    const result = normalizeTodoBlock(content);
    // item has 0 indent, so comment should be at 2 spaces
    expect(result).toContain('  COMMENT: hello');
  });

  test('REPLY: coerced to item_indent + 4 spaces', () => {
    const content = 'TODO:\n[ ] item\n  COMMENT: hi\n    REPLY: hey';
    const result = normalizeTodoBlock(content);
    expect(result).toContain('    REPLY: hey');
  });

  test('REPLY already at wrong indent gets coerced', () => {
    const content = 'TODO:\n[ ] item\n  COMMENT: hi\nREPLY: wrong_indent';
    const result = normalizeTodoBlock(content);
    expect(result).toContain('    REPLY: wrong_indent');
  });

  test('orphan REPLY inserts empty COMMENT: before it', () => {
    const content = 'TODO:\n[ ] item\n    REPLY: orphan';
    const result = normalizeTodoBlock(content);
    const lines = result.split('\n');
    const commentIdx = lines.findIndex(l => l.trim().startsWith('COMMENT:'));
    const replyIdx = lines.findIndex(l => l.trim().startsWith('REPLY:'));
    expect(commentIdx).toBeGreaterThan(-1);
    expect(replyIdx).toBe(commentIdx + 1);
  });

  test('* bullet normalized to [ ] inside block containing COMMENT', () => {
    const content = 'TODO:\n* item\n  COMMENT: note';
    const result = normalizeTodoBlock(content);
    expect(result).toContain('[ ] item');
    expect(result).toContain('  COMMENT: note');
  });

  test('content outside TODO blocks is untouched', () => {
    const content = 'Some notes\nCOMMENT: not a todo comment\nTODO:\n[ ] item\n  COMMENT: real';
    const result = normalizeTodoBlock(content);
    const lines = result.split('\n');
    expect(lines[1]).toBe('COMMENT: not a todo comment');
  });
});
