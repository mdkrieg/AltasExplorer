const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const needle = '<div class="item-properties-container"';
let idx = 0;
let count = 0;
while (true) {
    const p = html.indexOf(needle, idx);
    if (p < 0) break;
    const pre = html.lastIndexOf('\n', p);
    const indent = p - pre - 1;
    const ctx = html.substring(p - 60, p).replace(/\n/g, '↵');
    console.log(`#${++count}: offset=${p}, indent=${indent} chars`);
    console.log(`  ctx: ${ctx}`);
    idx = p + 1;
}
console.log(`Total: ${count} occurrences`);
