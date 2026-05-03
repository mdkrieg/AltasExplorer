/**
 * One-time HTML transformation for the ip-widget refactor:
 * 1. Remove item-properties-container blocks from panels 1-4 landing pages
 * 2. Replace #item-props-modal / #panel-0 wrapper with #ip-widget-store / #ip-widget
 */
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../public/index.html');
let html = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for consistent matching
html = html.replace(/\r\n/g, '\n');

// ─── Step 1: Remove item-properties-container from panel landing pages ──────
// These blocks have 14-space indent (vs 6-space in #panel-0 inside the modal)
// Pattern: \n + 14 spaces + <div class="item-properties-container" ... 
//          up to (and including) \n + 14 spaces + </div>
// We know there is exactly one 14-space </div> inside each block (the container's closing)

function removeIpContainerBlocks(input) {
    const openTag = '\n              <div class="item-properties-container"';
    const closeTag = '\n              </div>';
    let result = input;
    let safetyLimit = 10;
    
    while (safetyLimit-- > 0) {
        const startIdx = result.indexOf(openTag);
        if (startIdx === -1) break;
        
        // Find the first closeTag that appears after the last nested content
        // We know the nesting: all nested </div> are at 16+ spaces, so the
        // first 14-space </div> after our openTag is the correct closing.
        let searchFrom = startIdx + openTag.length;
        const endIdx = result.indexOf(closeTag, searchFrom);
        if (endIdx === -1) {
            console.error('Could not find closing </div> for item-properties-container');
            break;
        }
        
        // Remove from startIdx to endIdx + closeTag.length
        result = result.substring(0, startIdx) + result.substring(endIdx + closeTag.length);
        console.log(`Removed item-properties-container block at offset ${startIdx}`);
    }
    
    return result;
}

html = removeIpContainerBlocks(html);

// ─── Step 2: Replace #item-props-modal header section with #ip-widget-store ─
// Replace from "<!-- Item Properties Modal -->" up to (but not including)
// the <div class="item-properties-container" that starts the preserved content.
// The preserved #panel-0 content (item-properties-container + children) stays.
// We also replace the outer closing divs.

const OLD_MODAL_OUTER_OPEN = `  <!-- Item Properties Modal -->
  <div id="item-props-modal"
    style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1100; align-items: center; justify-content: center;">
    <div id="panel-0"
      style="background: white; border-radius: 8px; width: 440px; max-width: calc(100vw - 40px); max-height: 85vh; display: flex; flex-direction: column; box-shadow: 0 4px 20px rgba(0,0,0,0.2);">
      <div
        style="display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid #ddd; flex-shrink: 0; flex-wrap: wrap;">
        <span style="font-weight: bold; font-size: 13px; flex: 1; min-width: 0; white-space: nowrap;">Item
          Properties</span>
        <div id="item-props-modal-panel-btns" style="display: flex; gap: 6px; flex-wrap: wrap;"></div>
        <button id="btn-item-props-modal-close"
          style="padding: 4px 10px; background: #f0f0f0; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; font-size: 12px; flex-shrink: 0;">Close</button>
      </div>
      <div class="item-properties-container"
        style="flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; min-height: 0;">`;

const NEW_WIDGET_OUTER_OPEN = `  <!-- Item Properties Widget storage (hidden; shown via w2popup or panel embed) -->
  <div id="ip-widget-store" style="display: none;">
    <div id="ip-widget"
      style="background: white; display: flex; flex-direction: column; overflow: hidden; width: 100%; height: 100%;">
      <div id="ip-widget-header"
        style="display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid #ddd; flex-shrink: 0; flex-wrap: wrap;">
        <span id="ip-path-display"
          style="flex: 1; font-weight: bold; font-size: 12px; cursor: pointer; user-select: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #333;" title=""></span>
        <input id="ip-path-input" type="text"
          style="display: none; flex: 1; font-weight: bold; font-size: 12px; padding: 4px; border: 1px solid #ccc; border-radius: 4px; font-family: inherit;">
        <div id="ip-panel-section" style="display: flex; align-items: center; gap: 4px;">
          <span style="color: #999; font-size: 10px; margin-right: 2px;">Open in:</span>
          <span id="ip-panel-btns" style="display: flex; gap: 4px;"></span>
        </div>
        <button id="btn-ip-close"
          style="padding: 4px 10px; background: #f0f0f0; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; font-size: 12px; flex-shrink: 0;">&#x2715;</button>
      </div>
      <div id="panel-0"
        style="flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; min-height: 0;">`;

// Also need to remove the old item-properties-container wrapper div inside panel-0
// The content between OLD_MODAL_OUTER_OPEN and OLD_MODAL_OUTER_CLOSE is:
//   <div class="item-properties-placeholder">...</div>
//   <div class="item-properties-content">...</div>
// These are the children of item-properties-container.
// We want them to become direct children of #panel-0 (removing the item-properties-container wrapper).

if (!html.includes(OLD_MODAL_OUTER_OPEN)) {
    console.error('Could not find old modal outer opening HTML!');
    console.log('Looking for:', OLD_MODAL_OUTER_OPEN.substring(0, 100));
    process.exit(1);
}

html = html.replace(OLD_MODAL_OUTER_OPEN, NEW_WIDGET_OUTER_OPEN);
console.log('Replaced #item-props-modal opening with #ip-widget-store');

// Now replace the closing: old has "      </div>\n    </div>\n  </div>"
// The old closing sequence after item-properties-container content:
//   "      </div>   <- closes item-properties-container (6 spaces)
//    "    </div>    <- closes panel-0 (4 spaces)
//    "  </div>      <- closes item-props-modal (2 spaces)
// New closing sequence:
//   "      </div>   <- closes panel-0 (same as old item-properties-container close)
//    "    </div>    <- closes ip-widget (same as old panel-0 close)
//    "  </div>      <- closes ip-widget-store (same as old item-props-modal close)
// 
// These are identical! So no closing change needed.
// But we DO need to remove the old item-properties-container wrapper div
// inside #panel-0. The old structure had:
//   ...NEW_WIDGET_OUTER_OPEN + <div class="item-properties-placeholder"> etc.
// 
// Wait - by replacing OLD_MODAL_OUTER_OPEN with NEW_WIDGET_OUTER_OPEN,
// we've already replaced up to and including the opening of item-properties-container.
// The content (placeholder + content divs) follows immediately.
// Then comes "      </div>" (6 spaces) closing item-properties-container.
// We need to remove that closing </div> (since #panel-0 is now the direct parent).

// Find and remove the extra closing </div> that closed item-properties-container
// It appears right after the item-properties-content closing div.
// Context: "        </div>\n      </div>\n    </div>\n  </div>"
// After our replacement, we want: "        </div>\n    </div>\n  </div>"
// i.e., remove "      </div>\n" (the item-properties-container close)

const OLD_MODAL_EXTRA_CLOSE = `        </div>
      </div>
    </div>
  </div>

  <!-- Terminal Drawer -->`;

const NEW_MODAL_EXTRA_CLOSE = `        </div>
    </div>
  </div>

  <!-- Terminal Drawer -->`;

if (!html.includes(OLD_MODAL_EXTRA_CLOSE)) {
    console.error('Could not find old modal extra closing HTML!');
    // Show what's around the terminal drawer
    const tdIdx = html.indexOf('<!-- Terminal Drawer -->');
    if (tdIdx > 0) {
        console.log('Context before Terminal Drawer:');
        console.log(JSON.stringify(html.substring(tdIdx - 200, tdIdx)));
    }
    process.exit(1);
}

html = html.replace(OLD_MODAL_EXTRA_CLOSE, NEW_MODAL_EXTRA_CLOSE);
console.log('Fixed closing div sequence');

// Write the result
fs.writeFileSync(filePath, html, 'utf8');
console.log('Done! HTML file updated successfully.');

// Verify: count item-properties-container occurrences
const count = (html.match(/<div class="item-properties-container"/g) || []).length;
console.log(`item-properties-container count after transform: ${count} (expected 0)`);
const panelZero = html.includes('id="panel-0"');
const ipWidget = html.includes('id="ip-widget"');
const ipWidgetStore = html.includes('id="ip-widget-store"');
console.log(`#panel-0 present: ${panelZero}, #ip-widget present: ${ipWidget}, #ip-widget-store present: ${ipWidgetStore}`);
