/**
 * Temporary verification driver — board view rendering, edit mode, placement,
 * collision clamping, persistence and the cross-panel edit lock.
 */
const path = require('path');
const puppeteer = require(path.join(__dirname, 'node_modules', 'puppeteer'));

const TEST_DIR = 'C:\\workspace\\atlas-board-test';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
	const browser = await puppeteer.connect({
		browserURL: 'http://127.0.0.1:9222', defaultViewport: null, protocolTimeout: 30000,
	});
	const page = (await browser.pages()).find(p => p.url().includes('index.html'));
	page.on('pageerror', e => console.log('[PAGEERROR]', e.message));
	page.on('console', m => {
		const t = m.text();
		if (m.type() === 'error' && !t.includes('Content Security Policy')) console.log('[ERR]', t.slice(0, 300));
	});

	const navigate = async (panelId, dir) => {
		for (let attempt = 0; attempt < 3; attempt++) {
			// Click the path display to reveal the input, then drive it with real key
			// events — a synthesised KeyboardEvent does not reach jQuery's handler.
			await page.click(`#panel-${panelId} .panel-path`).catch(() => {});
			await sleep(200);
			const input = await page.$(`#panel-${panelId} .panel-path-input`);
			await input.click({ clickCount: 3 }).catch(() => {});
			await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
			await page.keyboard.type(dir);
			await sleep(300);
			await page.keyboard.press('Enter');
			await sleep(2500);
			const now = await page.evaluate(p =>
				document.querySelector(`#panel-${p} .panel-header`)?.textContent?.trim(), panelId);
			if (now && now.includes(dir)) return;
			console.log(`  navigate retry (panel ${panelId} header "${now}")`);
		}
		throw new Error(`panel ${panelId} would not navigate to ${dir}`);
	};
	const openMenu = async (panelId) => {
		for (let i = 0; i < 8; i++) {
			if (await page.evaluate(() => !!document.querySelector('.view-menu'))) return;
			await page.evaluate(p => document.querySelector(`#panel-${p} .panel-tb-view-btn`).click(), panelId);
			await sleep(400);
		}
	};
	const pickView = async (panelId, viewId) => {
		await openMenu(panelId);
		await page.evaluate(v => document.querySelector(`[data-view-menu-action="set-view"][data-view-id="${v}"]`).click(), viewId);
		await sleep(2200);
	};
	const boardSnap = (panelId) => page.evaluate(p => {
		const $b = document.querySelector(`#panel-${p} .panel-board`);
		if (!$b) return null;
		return {
			active: $b.classList.contains('active'),
			editMode: $b.querySelector('.board-canvas')?.classList.contains('board-edit-mode')
				|| $b.classList.contains('board-edit-mode'),
			cards: [...$b.querySelectorAll('.board-card')].map(c => ({
				name: c.dataset.filename,
				left: c.style.left, top: c.style.top, w: c.style.width, h: c.style.height,
			})),
			trayItems: [...$b.querySelectorAll('.board-tray-item')].map(i => i.dataset.filename),
			trayEmpty: !!$b.querySelector('.board-tray-empty'),
			editBtn: $b.querySelector('.board-edit-btn')?.textContent.trim(),
			editBtnDisabled: !!$b.querySelector('.board-edit-btn')?.disabled,
			footerNote: $b.querySelector('.board-footer-note')?.textContent.trim() || null,
		};
	}, panelId);

	await navigate(1, TEST_DIR);
	console.log('path after navigate:', await page.evaluate(() => ({
		display: document.querySelector('#panel-1 .panel-path')?.textContent?.trim(),
		input: document.querySelector('#panel-1 .panel-path-input')?.value,
		header: document.querySelector('#panel-1 .panel-header')?.textContent?.trim().slice(0, 120),
	})));
	console.log('board dir snapshot:', JSON.stringify((await boardSnap(1))?.trayItems?.slice(0, 8)));
	await pickView(1, 'board');
	console.log('board initial:', JSON.stringify(await boardSnap(1), null, 1));

	// Enter edit mode
	await page.evaluate(() => document.querySelector('#panel-1 .board-edit-btn').click());
	await sleep(500);
	console.log('after edit toggle:', JSON.stringify(await boardSnap(1), null, 1));

	browser.disconnect();
})().catch(e => { console.error('FAILED:', e.stack); process.exit(1); });
