# Electron Frontend Debugging Guide

This project includes automated Electron frontend debugging via Chrome DevTools Protocol (CDP). This allows Claude Code to inspect and interact with the running Electron app without manual screenshots.

## Quick Start

### Terminal 1: Start Electron with Remote Debugging
```bash
npm run debug:port
```

This launches the Electron app with `--remote-debugging-port=9222`, making the renderer process accessible via CDP.

### Terminal 2: Run Debug CLI
```bash
npm run debug:cli
```

This opens an interactive CLI where you can:
- Take screenshots of the UI
- Inspect DOM elements and their computed styles
- Execute JavaScript in the renderer
- Monitor console logs in real-time
- Find elements by selector

## Interactive Commands

Once in the debug CLI:

```
screenshot [filename]     - Take a screenshot (default: screenshot.png)
dom [selector]           - Get HTML of element (default: body)
inspect <selector>       - Show computed styles of element
find <selector>          - Find all elements matching selector
js <code>               - Execute JavaScript code
logs                    - Monitor console logs (Ctrl+C to stop)
quit                    - Exit the debugger
```

### Examples

```
# Take a screenshot
> screenshot debug.png

# Inspect the category form
> inspect #form-cat-bgColor

# Find all w2field-helper elements
> find .w2ui-field-helper

# Execute JavaScript to test something
> js document.querySelectorAll('.w2ui-error').length

# Monitor console in real-time
> logs
```

## Programmatic Usage

You can also import and use the debug functions directly in Node scripts:

```javascript
const debug = require('./debug-electron');

(async () => {
  if (await debug.connect()) {
    // Take a screenshot
    await debug.screenshot('test.png');
    
    // Inspect an element
    await debug.inspectElement('.w2ui-field-helper');
    
    // Execute JavaScript
    const count = await debug.executeJS('document.querySelectorAll(".w2ui-error").length');
    console.log(`Found ${count} error elements`);
    
    await debug.disconnect();
  }
})();
```

## Why This Matters

Instead of:
1. Making a code change
2. Asking you for a screenshot to verify
3. Guessing at what might be wrong

Claude Code can now:
1. Make a code change
2. Inspect the live UI automatically
3. See exact positioning, styles, and state
4. Iterate faster without manual back-and-forth

## Troubleshooting

**"No renderer pages found"** 
- Make sure Electron is running with `npm run debug:port`
- The port must be 9222 (or change the debug-electron.js file)

**Connection refused**
- Wait 2-3 seconds for Electron to fully load before running the debug CLI

**Can't execute JS code**
- Make sure the Electron window is focused
- Check the console logs with the `logs` command to see if there are errors
