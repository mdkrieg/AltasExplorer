#!/usr/bin/env node
/**
 * Claude Code Electron Debugger
 * Connect to a running Electron app and introspect/debug the frontend
 *
 * Usage:
 *   1. Start your Electron app with: electron . --remote-debugging-port=9222
 *   2. Run this script: node debug-electron.js
 *   3. Use the exported functions to inspect and debug the frontend
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

let browser = null;
let page = null;

/**
 * Connect to the running Electron app
 */
async function connect() {
  try {
    // Find the Electron process and extract the WebSocket URL from port 9222
    browser = await puppeteer.connect({
      browserWSEndpoint: 'http://localhost:9222',
      defaultViewport: null,
    });

    // Get the first page (renderer process)
    const pages = await browser.pages();
    page = pages[0];

    if (!page) {
      throw new Error('No renderer pages found. Is Electron running with --remote-debugging-port=9222?');
    }

    console.log('✓ Connected to Electron app');
    return true;
  } catch (error) {
    console.error('✗ Failed to connect:', error.message);
    console.error('\nMake sure to start Electron with: electron . --remote-debugging-port=9222');
    return false;
  }
}

/**
 * Take a screenshot of the current UI
 */
async function screenshot(filename = 'screenshot.png') {
  if (!page) throw new Error('Not connected. Call connect() first.');

  const filepath = path.join(process.cwd(), filename);
  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`✓ Screenshot saved to ${filepath}`);
  return filepath;
}

/**
 * Get the DOM as a string
 */
async function getDOM(selector = 'body') {
  if (!page) throw new Error('Not connected. Call connect() first.');

  const html = await page.$eval(selector, el => el.outerHTML);
  return html;
}

/**
 * Inspect a specific element
 */
async function inspectElement(selector) {
  if (!page) throw new Error('Not connected. Call connect() first.');

  const info = await page.$eval(selector, el => ({
    tag: el.tagName,
    id: el.id,
    classes: Array.from(el.classList),
    innerHTML: el.innerHTML.substring(0, 200),
    computedStyle: {
      position: window.getComputedStyle(el).position,
      top: window.getComputedStyle(el).top,
      left: window.getComputedStyle(el).left,
      right: window.getComputedStyle(el).right,
      width: window.getComputedStyle(el).width,
      height: window.getComputedStyle(el).height,
      display: window.getComputedStyle(el).display,
      zIndex: window.getComputedStyle(el).zIndex,
    }
  }));

  console.log(`Element: ${selector}`);
  console.table(info);
  return info;
}

/**
 * Execute JavaScript in the renderer
 */
async function executeJS(code) {
  if (!page) throw new Error('Not connected. Call connect() first.');

  const result = await page.evaluate((jsCode) => {
    return eval(jsCode);
  }, code);

  console.log('JS Result:', result);
  return result;
}

/**
 * Get console logs
 */
async function getConsoleLogs() {
  if (!page) throw new Error('Not connected. Call connect() first.');

  const logs = [];

  page.on('console', msg => {
    logs.push({
      type: msg.type(),
      text: msg.text(),
      location: msg.location(),
    });
    console.log(`[${msg.type().toUpperCase()}] ${msg.text()}`);
  });

  return logs;
}

/**
 * Monitor console in real-time
 */
async function monitorConsole() {
  if (!page) throw new Error('Not connected. Call connect() first.');

  console.log('Monitoring console (Ctrl+C to stop)...\n');

  page.on('console', msg => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] [${msg.type().toUpperCase()}] ${msg.text()}`);
  });

  page.on('pageerror', err => {
    console.log(`[ERROR] ${err.message}`);
  });

  // Keep the process alive
  await new Promise(() => {});
}

/**
 * Find and log all elements matching a selector with their computed styles
 */
async function findElements(selector) {
  if (!page) throw new Error('Not connected. Call connect() first.');

  const elements = await page.$$eval(selector, els =>
    els.map(el => ({
      text: el.textContent.substring(0, 50),
      id: el.id,
      classes: Array.from(el.classList),
      position: {
        top: window.getComputedStyle(el).top,
        left: window.getComputedStyle(el).left,
        right: window.getComputedStyle(el).right,
      }
    }))
  );

  console.log(`Found ${elements.length} elements matching "${selector}":`);
  console.table(elements);
  return elements;
}

/**
 * Get console errors (non-blocking snapshot)
 * Listens for errors for a brief window, plus checks for existing page errors
 */
async function getErrors(durationMs = 500) {
  if (!page) throw new Error('Not connected. Call connect() first.');

  const errors = [];

  // Check for errors that occurred on page load
  const pageErrors = await page.evaluate(() => {
    // Grab any errors stored by the app
    const stored = window.__consoleErrors || [];
    return stored.map(e => typeof e === 'string' ? e : e.message || String(e));
  });
  errors.push(...pageErrors.map(e => ({ type: 'page', message: e })));

  // Listen briefly for new console errors
  const handler = msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      errors.push({ type: msg.type(), message: msg.text() });
    }
  };
  const errorHandler = err => {
    errors.push({ type: 'uncaught', message: err.message });
  };

  page.on('console', handler);
  page.on('pageerror', errorHandler);

  await new Promise(resolve => setTimeout(resolve, durationMs));

  page.off('console', handler);
  page.off('pageerror', errorHandler);

  if (errors.length === 0) {
    console.log('No errors detected.');
  } else {
    console.log(`Found ${errors.length} error(s):`);
    errors.forEach(e => console.log(`  [${e.type.toUpperCase()}] ${e.message}`));
  }
  return errors;
}

/**
 * Take a screenshot of a specific element
 */
async function screenshotElement(selector, filename = 'element.png') {
  if (!page) throw new Error('Not connected. Call connect() first.');

  const element = await page.$(selector);
  if (!element) {
    console.error(`Element not found: ${selector}`);
    return null;
  }

  const filepath = path.join(process.cwd(), filename);
  await element.screenshot({ path: filepath });
  console.log(`✓ Element screenshot saved to ${filepath}`);
  return filepath;
}

/**
 * Click an element
 */
async function click(selector) {
  if (!page) throw new Error('Not connected. Call connect() first.');
  await page.click(selector);
  console.log(`✓ Clicked: ${selector}`);
}

/**
 * Type text into an element
 */
async function type(selector, text) {
  if (!page) throw new Error('Not connected. Call connect() first.');
  await page.type(selector, text);
  console.log(`✓ Typed into: ${selector}`);
}

/**
 * Wait for a selector to appear, with timeout
 */
async function waitFor(selector, timeoutMs = 5000) {
  if (!page) throw new Error('Not connected. Call connect() first.');
  await page.waitForSelector(selector, { timeout: timeoutMs });
  console.log(`✓ Found: ${selector}`);
}

/**
 * Reload the page (useful after code changes)
 */
async function reload() {
  if (!page) throw new Error('Not connected. Call connect() first.');
  await page.reload({ waitUntil: 'domcontentloaded' });
  console.log('✓ Page reloaded');
}

/**
 * Disconnect from the browser
 */
async function disconnect() {
  if (browser) {
    await browser.disconnect();
    console.log('✓ Disconnected');
  }
}

/**
 * Interactive CLI mode
 */
async function interactive() {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (q) => new Promise(resolve => rl.question(q, resolve));

  console.log('\n=== Electron Debugger ===\n');
  console.log('Commands:');
  console.log('  screenshot [filename] - Take a screenshot');
  console.log('  dom [selector] - Get DOM HTML');
  console.log('  inspect <selector> - Inspect element styles');
  console.log('  find <selector> - Find all matching elements');
  console.log('  js <code> - Execute JavaScript');
  console.log('  logs - Monitor console logs');
  console.log('  quit - Exit\n');

  let running = true;
  while (running) {
    const input = await question('> ');
    const [command, ...args] = input.split(' ');

    try {
      switch (command) {
        case 'screenshot':
          await screenshot(args[0] || 'screenshot.png');
          break;
        case 'dom':
          const html = await getDOM(args[0] || 'body');
          console.log(html.substring(0, 500) + '...');
          break;
        case 'inspect':
          if (!args[0]) {
            console.log('Usage: inspect <selector>');
            break;
          }
          await inspectElement(args[0]);
          break;
        case 'find':
          if (!args[0]) {
            console.log('Usage: find <selector>');
            break;
          }
          await findElements(args[0]);
          break;
        case 'js':
          const code = args.join(' ');
          if (!code) {
            console.log('Usage: js <code>');
            break;
          }
          await executeJS(code);
          break;
        case 'logs':
          await monitorConsole();
          break;
        case 'quit':
          running = false;
          break;
        default:
          console.log('Unknown command. Type a command or "quit" to exit.');
      }
    } catch (error) {
      console.error('Error:', error.message);
    }
  }

  await disconnect();
  rl.close();
  process.exit(0);
}

// Export functions for use as a module
module.exports = {
  connect,
  screenshot,
  screenshotElement,
  getDOM,
  inspectElement,
  executeJS,
  getConsoleLogs,
  getErrors,
  monitorConsole,
  findElements,
  click,
  type,
  waitFor,
  reload,
  disconnect,
};

// CLI + interactive mode when executed directly
if (require.main === module) {
  const args = process.argv.slice(2);

  // No args → interactive mode (original behavior)
  if (args.length === 0) {
    connect().then(connected => {
      if (connected) {
        interactive().catch(console.error);
      } else {
        process.exit(1);
      }
    });
  } else {
    // CLI mode: node debug-electron.js <command> [args...]
    const command = args[0];
    const rest = args.slice(1);

    const run = async () => {
      const connected = await connect();
      if (!connected) process.exit(1);

      try {
        switch (command) {
          case 'screenshot': {
            await screenshot(rest[0] || 'screenshot.png');
            break;
          }
          case 'screenshot-el': {
            if (!rest[0]) { console.error('Usage: screenshot-el <selector> [filename]'); process.exit(1); }
            await screenshotElement(rest[0], rest[1] || 'element.png');
            break;
          }
          case 'dom': {
            const html = await getDOM(rest[0] || 'body');
            console.log(html);
            break;
          }
          case 'inspect': {
            if (!rest[0]) { console.error('Usage: inspect <selector>'); process.exit(1); }
            const info = await inspectElement(rest[0]);
            console.log(JSON.stringify(info, null, 2));
            break;
          }
          case 'find': {
            if (!rest[0]) { console.error('Usage: find <selector>'); process.exit(1); }
            const els = await findElements(rest[0]);
            console.log(JSON.stringify(els, null, 2));
            break;
          }
          case 'eval': {
            const code = rest.join(' ');
            if (!code) { console.error('Usage: eval <js code>'); process.exit(1); }
            const result = await executeJS(code);
            if (typeof result === 'object') {
              console.log(JSON.stringify(result, null, 2));
            }
            break;
          }
          case 'errors': {
            await getErrors(parseInt(rest[0]) || 500);
            break;
          }
          case 'click': {
            if (!rest[0]) { console.error('Usage: click <selector>'); process.exit(1); }
            await click(rest[0]);
            break;
          }
          case 'type': {
            if (!rest[0] || !rest[1]) { console.error('Usage: type <selector> <text>'); process.exit(1); }
            await type(rest[0], rest.slice(1).join(' '));
            break;
          }
          case 'wait': {
            if (!rest[0]) { console.error('Usage: wait <selector> [timeout_ms]'); process.exit(1); }
            await waitFor(rest[0], parseInt(rest[1]) || 5000);
            break;
          }
          case 'reload': {
            await reload();
            break;
          }
          case 'help': {
            console.log(`
Usage: node debug-electron.js <command> [args...]

Commands:
  screenshot [filename]               Full page screenshot (default: screenshot.png)
  screenshot-el <selector> [filename] Screenshot a specific element
  dom [selector]                      Get DOM HTML (default: body)
  inspect <selector>                  Get element info + computed styles
  find <selector>                     Find all matching elements
  eval <js code>                      Execute JS in the renderer
  errors [duration_ms]                Check for console errors (default: 500ms listen)
  click <selector>                    Click an element
  type <selector> <text>              Type text into an element
  wait <selector> [timeout_ms]        Wait for element to appear
  reload                              Reload the page
  help                                Show this help

No arguments launches interactive mode.
`);
            break;
          }
          default: {
            console.error(`Unknown command: ${command}. Run with "help" for usage.`);
            process.exit(1);
          }
        }
      } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
      } finally {
        await disconnect();
      }
    };

    run();
  }
}
