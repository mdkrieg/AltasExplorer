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
  getDOM,
  inspectElement,
  executeJS,
  getConsoleLogs,
  monitorConsole,
  findElements,
  disconnect,
};

// Run interactive mode if executed directly
if (require.main === module) {
  connect().then(connected => {
    if (connected) {
      interactive().catch(console.error);
    } else {
      process.exit(1);
    }
  });
}
