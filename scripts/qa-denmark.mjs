/**
 * qa-denmark.mjs — headless proof for the Denmark pack layer.
 *
 * Checks what unit tests cannot: that every registry dataset answers through
 * the live proxy, that the layer draws them over Denmark, that its row
 * exposes one chip per dataset, and that clicking a drawn feature opens the
 * info card. Optionally writes a screenshot.
 *
 * Run:  node scripts/qa-denmark.mjs --url http://localhost:4173 [--shot out.png]
 *       [--datasets id,id] [--lat 56.1 --lon 10.9 --alt 450000]
 */

import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const APP_URL = getOpt('--url', 'http://localhost:4173');
const SHOT = getOpt('--shot', '');
const ONLY = getOpt('--datasets', '');
const VIEW = {
  lat: Number(getOpt('--lat', '56.1')),
  lon: Number(getOpt('--lon', '10.9')),
  alt: Number(getOpt('--alt', '520000')),
  pitch: Number(getOpt('--pitch', '-90')),
};

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Close the first-run "Choose your first view" dialog if it is open. */
const dismissFirstRun = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('button, [role=button]')]
      .find((b) => /explore manually/i.test(b.textContent || ''))
      ?.click(),
  );

async function main() {
  let exitCode = 0;
  const consoleErrors = [];
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
    defaultViewport: { width: 1600, height: 1000 },
  });

  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 200)));
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
    });

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(
      () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
      { timeout: 90000 },
    );
    await sleep(1500);
    // The first-run "Choose your first view" dialog would cover the globe.
    await page.keyboard.press('Escape');

    const catalog = await page.evaluate(async () =>
      (await (await fetch('/api/dk/datasets')).json()).datasets.map(
        (d) => d.id,
      ),
    );
    const wanted = ONLY ? ONLY.split(',') : catalog;
    record(
      'proxy publishes the dataset catalog',
      catalog.length >= 10,
      `${catalog.length} datasets`,
    );

    const stats = await page.evaluate(async (ids) => {
      const dm = window.__godsEyeView.dataManager;
      try {
        localStorage.setItem('gev:denmark:datasets:v1', JSON.stringify(ids));
      } catch {
        /* storage unavailable */
      }
      await dm.setEnabled('denmark', true);
      const mod = dm.layers.get('denmark')?.module;
      if (!mod) return { missing: true };
      const controls = () => mod.getRowControls();
      // Datasets the stored selection did not name are switched on via chips.
      for (const chip of controls().chips) {
        const id = chip.id.replace(/^dk-/, '');
        if (ids.includes(id) !== chip.active) chip.onClick();
      }
      let s = null;
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        s = mod.getStats();
        const busy = controls().chips.some((c) => c.label.endsWith('…'));
        if (!busy && s.count > 0) break;
      }
      return {
        stats: s,
        chips: controls().chips.map((c) => ({
          id: c.id,
          label: c.label,
          active: c.active,
        })),
        info: controls().info,
      };
    }, wanted);

    const ok = !stats?.missing && stats.stats?.count > 0 && !stats.stats?.error;
    record(
      'layer draws Danish features',
      ok,
      `count=${stats?.stats?.count} ${stats?.info || ''}`,
    );
    if (!ok) exitCode = 1;
    const failed = (stats?.chips || []).filter(
      (c) => c.active && /!$/.test(c.label),
    );
    record(
      'every switched-on dataset loaded',
      failed.length === 0,
      failed.length
        ? failed.map((c) => c.label).join('; ')
        : `${stats?.chips?.filter((c) => c.active).length} on`,
    );
    if (failed.length) exitCode = 1;
    record(
      'row has one chip per registry dataset',
      stats?.chips?.length === catalog.length,
      `${stats?.chips?.length} chips`,
    );

    await page.evaluate(({ lat, lon, alt, pitch }) => {
      const { viewer } = window.__godsEyeView;
      const d2r = Math.PI / 180;
      try {
        viewer.camera.cancelFlight();
      } catch {
        /* no flight */
      }
      viewer.camera.setView({
        destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: lon * d2r,
          latitude: lat * d2r,
          height: alt,
        }),
        orientation: { heading: 0, pitch: pitch * d2r, roll: 0 },
      });
    }, VIEW);
    await sleep(8000);

    // Click the first drawn point and expect the info card.
    const clicked = await page.evaluate(() => {
      const { viewer } = window.__godsEyeView;
      const Cesium = window.Cesium || window.__godsEyeView.Cesium;
      for (let i = 0; i < viewer.scene.primitives.length; i++) {
        const p = viewer.scene.primitives.get(i);
        if (!p?.show || typeof p.length !== 'number' || !p.length) continue;
        for (let j = 0; j < Math.min(p.length, 400); j++) {
          const point = p.get(j);
          if (typeof point?.id !== 'string' || !point.id.startsWith('dk:'))
            continue;
          const xy = viewer.scene.cartesianToCanvasCoordinates
            ? viewer.scene.cartesianToCanvasCoordinates(point.position)
            : Cesium?.SceneTransforms?.worldToWindowCoordinates(
                viewer.scene,
                point.position,
              );
          if (xy && xy.x > 50 && xy.y > 50 && xy.x < 1550 && xy.y < 950)
            return { x: xy.x, y: xy.y, id: point.id };
        }
      }
      return null;
    });
    // The first-run dialog opens late and would swallow the click.
    await dismissFirstRun(page);
    if (clicked) {
      await page.mouse.click(clicked.x, clicked.y);
      await sleep(800);
      const card = await page.evaluate(
        () => document.querySelector('.dk-card')?.innerText || '',
      );
      const why = card
        ? ''
        : await page.evaluate(({ x, y }) => {
            const picked = window.__godsEyeView.viewer.scene.pick({ x, y });
            const id = picked?.id;
            const top = document.elementFromPoint(x, y);
            return `picked=${typeof id === 'object' ? `entity:${id?.id}` : String(id)} top=${top?.tagName}`;
          }, clicked);
      record(
        'clicking a feature opens its card',
        Boolean(card),
        card
          ? card.split('\n').slice(0, 3).join(' | ')
          : `target=${clicked.id} at ${Math.round(clicked.x)},${Math.round(clicked.y)} ${why}`,
      );
    } else {
      record(
        'clicking a feature opens its card',
        false,
        'no on-screen point found to click',
      );
    }

    if (SHOT) {
      await dismissFirstRun(page);
      await sleep(2000);
      await page.screenshot({ path: SHOT });
      console.log(`  screenshot → ${SHOT}`);
    }
    const ours = consoleErrors.filter((e) => /denmark|dk[:/-]/i.test(e));
    record(
      'no Denmark console errors',
      ours.length === 0,
      ours.slice(0, 3).join(' || '),
    );
    if (ours.length) exitCode = 1;
  } finally {
    await browser.close();
  }
  const failedCount = results.filter((r) => !r.ok).length;
  console.log(
    `\n${results.length - failedCount}/${results.length} checks passed`,
  );
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
