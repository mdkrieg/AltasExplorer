/**
 * Fix item-properties state references inside attachPanelEventListeners.
 * Changes all item-props-related panelState[panelId] refs to use panelState[0].
 */
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../public/js/modules/panels.js');
let js = fs.readFileSync(filePath, 'utf8');

// Find attachPanelEventListeners start and end
const fnStart = js.indexOf('export function attachPanelEventListeners(panelId)');
if (fnStart === -1) { console.error('Could not find attachPanelEventListeners'); process.exit(1); }

// Find the item-properties section within it.
// The item-properties handlers start after the icon click section and end before
// attachDragDropForPanel (or the end of the function).
// Strategy: find "btn-open-history-modal" handler (last item-props handler) and work backwards.

// The section we need to modify: from first item-props event handler to btn-open-history-modal handler.
// The item-props section starts at ".item-props-icon" click handler.
// Easier: just do targeted replacements in the full function body.

// We'll replace all relevant patterns but only when they appear alongside item-properties selectors.
// Actually safest: do global replacements for very specific item-props patterns.

const replacements = [
    // Section collapse state
    [/(?<=item-props-section-header[\s\S]{0,200}?)panelState\[panelId\]\.sectionCollapseState/g, 'panelState[0].sectionCollapseState'],
    // Labels UI state
    [/ensureLabelsUiState\(panelId\)/g, 'ensureLabelsUiState(0)'],
    // rerenderLabelsSection calls
    [/rerenderLabelsSection\(panelId(,|\))/g, 'rerenderLabelsSection(0$1'],
    // currentItemStats (in item-props context)
    [/panelState\[panelId\]\.currentItemStats/g, 'panelState[0].currentItemStats'],
    // Tag actions
    [/runPrimaryTagAction\(panelId\)/g, 'runPrimaryTagAction(0)'],
    [/activateTagSuggestion\(panelId,/g, 'activateTagSuggestion(0,'],
    [/removeTagFromCurrentItem\(panelId,/g, 'removeTagFromCurrentItem(0,'],
    // Attrs edit mode
    [/panelState\[panelId\]\.attrEditMode/g, 'panelState[0].attrEditMode'],
    // Notes state
    [/panelState\[panelId\]\.notesEditMode/g, 'panelState[0].notesEditMode'],
    [/panelState\[panelId\]\.notesMonacoEditor/g, 'panelState[0].notesMonacoEditor'],
    [/panelState\[panelId\]\.notesFilePath/g, 'panelState[0].notesFilePath'],
    [/panelState\[panelId\]\.notesSectionKey/g, 'panelState[0].notesSectionKey'],
    // Item inode/dirId
    [/panelState\[panelId\]\.itemInode/g, 'panelState[0].itemInode'],
    [/panelState\[panelId\]\.itemDirId/g, 'panelState[0].itemDirId'],
    // updateItemPropertiesPage calls
    [/updateItemPropertiesPage\(panelId\)/g, 'updateItemPropertiesPage(0)'],
];

// Extract just the attachPanelEventListeners function body to do targeted replacements
// Find end of function by counting braces
let braceDepth = 0;
let inFn = false;
let fnEnd = -1;
for (let i = fnStart; i < js.length; i++) {
    if (js[i] === '{') {
        braceDepth++;
        inFn = true;
    } else if (js[i] === '}') {
        braceDepth--;
        if (inFn && braceDepth === 0) {
            fnEnd = i + 1;
            break;
        }
    }
}

if (fnEnd === -1) { console.error('Could not find end of attachPanelEventListeners'); process.exit(1); }

console.log(`attachPanelEventListeners: lines ${js.substring(0, fnStart).split('\n').length} to ${js.substring(0, fnEnd).split('\n').length}`);

const fnBody = js.substring(fnStart, fnEnd);
let newFnBody = fnBody;

for (const [pattern, replacement] of replacements) {
    const before = newFnBody;
    newFnBody = newFnBody.replace(pattern, replacement);
    if (newFnBody !== before) {
        console.log(`Applied: ${pattern.toString().substring(0, 60)} → ${replacement}`);
    }
}

// Rebuild
js = js.substring(0, fnStart) + newFnBody + js.substring(fnEnd);

// Also fix the "addTagToCurrentItem" call within this function
// (it uses panelId as first arg from within attachPanelEventListeners)
// These appear in handlers but aren't pure panelState[] refs:
// Check if there are any remaining panelState[panelId] inside item-props handlers
const remaining = newFnBody.match(/panelState\[panelId\]\.(attrEditMode|notesEditMode|notesMonacoEditor|notesFilePath|notesSectionKey|currentItemStats|itemInode|itemDirId|sectionCollapseState)/g);
if (remaining && remaining.length > 0) {
    console.warn('WARNING: Remaining panelState[panelId] item-props refs:', remaining);
}

fs.writeFileSync(filePath, js, 'utf8');
console.log('Done.');
