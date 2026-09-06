// Automated product-screenshot capture for the README.
//
// Drives the live (or local) app with Playwright: logs in (creating the account
// if needed), seeds a demo show with performers + a run-of-show when the account
// is empty, then captures the showcased screens at phone width into
// docs/screenshots/.
//
// Usage:
//   npm i -D playwright && npx playwright install chromium
//   DEMO_USER=demo DEMO_PASS=demo1234 APP_URL=https://icanrunashow.com \
//     node scripts/capture-screenshots.mjs
//
// Env:
//   APP_URL    target app (default https://icanrunashow.com)
//   DEMO_USER  account username (default "demo")
//   DEMO_PASS  account password (default "demo1234")
//   OUT_DIR    output folder (default docs/screenshots)
//   HEADLESS   "false" to watch it run (default true)
//   PW_CHROMIUM_PATH  a Chromium already on disk, for sandboxes that cannot
//              download Playwright's pinned build
//   MOCK_API   "1" to run against a local build with an in-memory backend —
//              no account, no database, no credentials. This is the mode the
//              repository's own screenshots are captured in, and the one to
//              use when regenerating them from a fresh clone:
//                npm run build && npx vite preview --port 4173 &
//                MOCK_API=1 APP_URL=http://localhost:4173 npm run screenshots
//
// Note: uses a throwaway demo account. Never point DEMO_USER/DEMO_PASS at a real
// account — the seed step assumes it can populate an empty workspace.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
// gifenc ships CommonJS, so its exports arrive on the default import.
import gifenc from 'gifenc';
import { tmpdir } from 'node:os';
const { GIFEncoder, quantize, applyPalette } = gifenc;
import { join } from 'node:path';
// The same in-memory backend the end-to-end suite runs against, so the
// screenshots and the tests exercise one implementation rather than two.
import { emptyState, installFakeApi } from '../e2e/support/fake-api.mjs';

const APP_URL = process.env.APP_URL || 'https://icanrunashow.com';
const USER = process.env.DEMO_USER || 'demo';
const PASS = process.env.DEMO_PASS || 'demo1234';
const OUT_DIR = process.env.OUT_DIR || 'docs/screenshots';
const HEADLESS = process.env.HEADLESS !== 'false';
const MOCK_API = process.env.MOCK_API === '1';
// One backend shared by every context the run opens (producer and signer).
const MOCK_STATE = emptyState();
// Matches playwright.config.ts: use a Chromium already on disk when one is
// named, and --no-sandbox because container images commonly run as root.
const LAUNCH = {
  headless: HEADLESS,
  args: ['--no-sandbox'],
  ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
};

const log = (...a) => console.log('•', ...a);

async function shot(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(500); // let any transition settle
  const path = `${OUT_DIR}/${name}.png`;
  await page.screenshot({ path });
  log(`captured ${path}`);
}

/** Run the first-run onboarding wizard if it's showing. */
async function onboardIfPresent(page) {
  const getStarted = page.getByRole('button', { name: 'Get started' });
  if (!(await getStarted.count())) return;
  log('completing onboarding');
  await getStarted.click();
  await page.getByRole('button', { name: /^Comedy$/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByPlaceholder(/Late Night Laughs/).fill('Late Night Laughs');
  await page.getByRole('button', { name: 'Finish' }).click();
}

/** Sign in; create the account first if the credentials don't exist yet. Either
 *  path may land on the onboarding wizard, which we then complete. */
async function signInOrUp(page) {
  await page.goto(APP_URL, { waitUntil: 'networkidle' });

  const inApp = page.locator('.bottom-nav__item', { hasText: 'Shows' }).first();
  const onboarding = page.getByRole('button', { name: 'Get started' });

  if (await inApp.count()) return; // restored session

  await page.getByPlaceholder('Enter username').fill(USER);
  await page.getByPlaceholder('Enter your password').fill(PASS);
  await page.getByRole('button', { name: /^Sign In$/ }).click();

  // Wait for whichever screen sign-in lands on. A race between three
  // `waitFor`s settles as soon as any one of them does, which was reporting
  // "account not found" while onboarding was still a second away from
  // rendering; a single wait for either outcome cannot get that wrong.
  await page
    .waitForSelector('.bottom-nav__item, .login__error, button:text-matches("^Get started$")', {
      timeout: 20000,
    })
    .catch(() => {});

  if (!(await inApp.count()) && !(await onboarding.count())) {
    log('account not found — creating it');
    await page.getByRole('button', { name: /New here\? Create Account/ }).click();
    await page.getByPlaceholder('Enter username').fill(USER);
    await page.getByPlaceholder('Enter your password').fill(PASS);
    await page.getByRole('button', { name: /^Create Account$/ }).click();
    await onboarding.waitFor({ timeout: 10000 }).catch(() => {});
  }

  await onboardIfPresent(page);
  await inApp.waitFor({ timeout: 12000 });
  log('signed in');
}

async function openNewShowForm(page) {
  await page.getByRole('button', { name: '+ New Show' }).first().click();
  await page.locator('.show-form').waitFor();
}

async function expandSection(page, title) {
  const section = page.locator('.accordion-section', { hasText: title }).first();
  // Only click to expand if its content isn't already shown.
  if (!(await section.locator('.accordion-section__content').count())) {
    await section.locator('.accordion-section__header').first().click();
  }
  return section;
}

/** Create one populated demo show so the screenshots look real. */
async function seedShow(page) {
  log('seeding a demo show');
  await openNewShowForm(page);
  await page.getByPlaceholder('Show name').fill('Friday Night Comedy');
  await page.locator('.show-form__input[type="date"]').fill('2026-07-17');
  await page.getByPlaceholder('e.g. 8:00 PM').fill('8:00 PM');
  await page.getByPlaceholder('Venue name').fill('The Basement');
  await page.getByPlaceholder(/City, address/).fill('Brooklyn, NY');
  await page.locator('.show-form').getByRole('button', { name: 'Save' }).click();

  // We land on the new show's detail page. Add a few performers.
  await page.locator('.show-detail').waitFor();
  const performers = ['Corey Cooley', 'Maya Reyes', 'Dev Okafor', 'Sam Tran'];
  await expandSection(page, 'Performers');
  for (const name of performers) {
    await page.getByPlaceholder('Performer name').fill(name);
    // The social field moved behind a disclosure when the add form was cut
    // down to a name and a button — fill it only when it is on screen.
    const social = page.getByPlaceholder('@instagram');
    if (await social.count()) {
      await social.fill('@' + name.toLowerCase().replace(/\s+/g, ''));
    }
    // `.lineup-add__submit` since the lineup form was rebuilt as a name and a
    // button on one row; `.section-add-row` is the older shape other sections
    // still use.
    const add = page.locator('.lineup-add__submit, .section-add-row button:has-text("Add")');
    await add.first().click();
    await page.waitForTimeout(150);
  }

  // Build a short run-of-show.
  await expandSection(page, 'Schedule');
  const buildBtn = page.getByRole('button', { name: 'Build Your Own' });
  if (await buildBtn.count()) await buildBtn.click();
  const cues = [
    ['8:00 PM', 'Doors + house music'],
    ['8:15 PM', 'Host intro'],
    ['8:20 PM', 'Corey Cooley'],
    ['8:35 PM', 'Maya Reyes'],
    ['8:50 PM', 'Dev Okafor'],
    ['9:05 PM', 'Headliner: Sam Tran'],
  ];
  for (const [time, desc] of cues) {
    await page.getByPlaceholder('8:00 PM').fill(time);
    await page.getByPlaceholder('Add a cue...').fill(desc);
    await page.getByRole('button', { name: 'Add cue' }).click();
    await page.waitForTimeout(150);
  }

  await page.evaluate(() => window.scrollTo(0, 0));
}

async function captureRunShow(page) {
  await page.locator('.show-detail__run-show').click();
  await page.locator('.run-show').waitFor();
  const start = page.getByRole('button', { name: /^Start$/ });
  if (await start.count()) await start.click();
  await page.waitForTimeout(1200); // let the timer tick
  await shot(page, 'run-show');
  await page.keyboard.press('Escape');
  await page.locator('.show-detail').waitFor();
}


/** A small but valid one-page PDF, so the contract screens have a real file. */
async function writeDemoContract() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    '<< /Length 46 >>\nstream\nBT /F1 16 Tf 72 700 Td (Performer Agreement) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const path = join(tmpdir(), 'Performer Agreement.pdf');
  await writeFile(path, out, 'latin1');
  return path;
}

/** The More hub: the between-shows pages, one tap off the bar. */
async function captureMore(page) {
  await page.locator('.bottom-nav__item', { hasText: 'More' }).click();
  await page.locator('.more-list').waitFor();
  await shot(page, 'more');
}

/**
 * Contracts, and the signing page a performer sees.
 *
 * Sends the same agreement to two people and signs as one of them, so the
 * status list shows both states rather than an empty or uniformly-green list.
 */
async function captureContracts(page, context) {
  log('seeding contracts');
  await page.locator('.bottom-nav__item', { hasText: 'More' }).click();
  await page.locator('.more-item', { hasText: 'Contracts' }).click();
  await page.locator('.contracts__file').setInputFiles(await writeDemoContract());
  await page.locator('.contracts__item').first().waitFor();
  await page.locator('.contracts__item').first().click();

  const links = [];
  for (const name of ['Maya Reyes', 'Dev Okafor']) {
    await page.locator('.contracts__send-btn').click();
    await page.locator('.contracts__manual input').fill(name);
    await page.locator('.contracts__manual').getByRole('button', { name: 'Send' }).click();
    await page.waitForTimeout(900);
    links.push(await page.evaluate(() => navigator.clipboard.readText()));
  }

  // Sign as the first of them, in a context with no session — which is all a
  // signer ever has.
  const signerContext = await context.browser().newContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 2,
  });
  if (MOCK_API) await installFakeApi(signerContext, MOCK_STATE);
  const signer = await signerContext.newPage();
  await signer.goto(links[0]);
  await signer.locator('.signing__field input').waitFor();
  await signer.locator('.signing__field input').fill('Maya Reyes');
  await signer.locator('.signing__agree input').check();
  await signer.locator('.signing__cta').click();
  const done = signer.locator('.signing__panel--done');
  await done.waitFor();
  // The panel rather than the page: headless Chromium does not reliably paint
  // a PDF inside an <object>, and a blank document pane above the receipt
  // would say something untrue about the app.
  await signer.waitForTimeout(400);
  await done.screenshot({ path: `${OUT_DIR}/signing-receipt.png` });
  log(`captured ${OUT_DIR}/signing-receipt.png`);
  await signerContext.close();

  // Back on the producer's side, one signed and one still waiting.
  await page.reload();
  await page.locator('.bottom-nav__item', { hasText: 'More' }).click();
  await page.locator('.more-item', { hasText: 'Contracts' }).click();
  await page.locator('.contracts__item').first().click();
  await page.locator('.contracts__row').first().waitFor();
  await shot(page, 'contracts');
}

/** Settings: the stage remote paired, and the storage sweep. */
async function captureSettings(page) {
  await page.locator('.bottom-nav__item', { hasText: 'Settings' }).click();
  await page.locator('.settings__card').first().waitFor();
  const pair = page.getByRole('button', { name: /Pair a remote/ });
  if (await pair.count()) {
    await pair.click();
    await page.keyboard.press('Enter'); // stand in for a clicker's button
    await page.waitForTimeout(300);
  }
  await page.locator('.settings__remote-state').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT_DIR}/stage-remote.png` });
  log(`captured ${OUT_DIR}/stage-remote.png`);
}


/** The run-of-show builder, the Rolodex, a performer profile, and Settings. */
async function captureShowScreens(page) {
  // Run-of-show, on the show page.
  await expandSection(page, 'Schedule');
  await page.waitForTimeout(400);
  await shot(page, 'schedule');

  // A performer profile, opened from the lineup.
  await expandSection(page, 'Performers');
  // The row is a container; opening the profile is its own button.
  const performer = page
    .locator('.section-list-item, .lineup-row')
    .filter({ hasText: 'Maya Reyes' })
    .getByRole('button', { name: /View Profile/ })
    .first();
  if (await performer.count()) {
    await performer.click();
    await page.waitForTimeout(600);
    await shot(page, 'performer-profile');
    // Back out of the profile, and wait for the show page before moving on —
    // the profile covers the show's own back button while it is open.
    await page.getByRole('button', { name: '← Back' }).first().click();
    await page.locator('.show-detail__stats, .accordion-section').first().waitFor();
    await page.waitForTimeout(300);
  }
}

async function captureRolodexAndSettings(page) {
  await page.locator('.bottom-nav__item', { hasText: 'Rolodex' }).click();
  await page.waitForTimeout(600);
  await shot(page, 'rolodex');

  await page.locator('.bottom-nav__item', { hasText: 'Settings' }).click();
  await page.locator('.settings__card').first().waitFor();
  await page.waitForTimeout(400);
  await shot(page, 'settings');
}




/**
 * The README's hero: Run Show actually running.
 *
 * A still cannot show the thing that matters about live mode — the clock
 * moving and the running order advancing under it — so this drives the real
 * screen and records what it does.
 *
 * Frames come from ordinary screenshots rather than Playwright's video
 * recorder, because the recorder produces WebM and the ffmpeg it ships is
 * built only for that: no gif encoder, and no palette filters. Encoding here
 * instead means the script needs nothing installed beyond its own
 * dependencies. The browser does the PNG decoding, which saves a decoder
 * dependency for the sake of one image.
 */
async function captureRunShowGif(page) {
  const WIDTH = 300;
  const DELAY_MS = 200;

  await page.locator('.show-detail__run-show').click();
  await page.locator('.run-show').waitFor();
  const start = page.getByRole('button', { name: /^Start$/ });
  if (await start.count()) await start.click();

  // Hold on the running clock, then advance twice — the two things live mode
  // is for. A press and the frame after it land in the same beat, so the
  // change reads as a response rather than a jump.
  const beats = [
    ...Array(10).fill(null),
    'ArrowRight', ...Array(9).fill(null),
    'ArrowRight', ...Array(9).fill(null),
  ];
  const frames = [];
  for (const key of beats) {
    if (key) await page.keyboard.press(key);
    frames.push(await page.screenshot());
    await page.waitForTimeout(DELAY_MS - 20); // screenshots cost ~20ms
  }

  // Decode in the browser: a canvas turns each PNG into the RGBA the encoder
  // wants, and scales it down on the way.
  const helper = await page.context().newPage();
  await helper.setContent('<canvas id="c"></canvas>');
  const encoder = GIFEncoder();
  let palette = null;
  for (const png of frames) {
    const frame = await helper.evaluate(
      async ({ b64, width }) => {
        const img = new Image();
        await new Promise((r) => { img.onload = r; img.src = 'data:image/png;base64,' + b64; });
        const height = Math.round(img.height * (width / img.width));
        const canvas = document.getElementById('c');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);
        const pixels = ctx.getImageData(0, 0, width, height).data;
        // Chunked: one apply() over a few hundred thousand arguments blows the
        // call stack.
        let binary = '';
        for (let i = 0; i < pixels.length; i += 0x8000) {
          binary += String.fromCharCode.apply(null, pixels.subarray(i, i + 0x8000));
        }
        return { data: btoa(binary), width, height };
      },
      { b64: png.toString('base64'), width: WIDTH },
    );
    const rgba = new Uint8Array(Buffer.from(frame.data, 'base64'));
    // One palette for the whole clip: the screen is mostly a fixed dark
    // interface, and a palette per frame both inflates the file and makes the
    // background shimmer between frames.
    palette ??= quantize(rgba, 128, { format: 'rgb565' });
    encoder.writeFrame(applyPalette(rgba, palette, 'rgb565'), frame.width, frame.height, {
      palette,
      delay: DELAY_MS,
    });
  }
  encoder.finish();
  await helper.close();
  await writeFile(`${OUT_DIR}/run-show.gif`, Buffer.from(encoder.bytes()));
  log(`captured ${OUT_DIR}/run-show.gif (${frames.length} frames)`);

  await page.keyboard.press('Escape');
  await page.locator('.show-detail').waitFor();
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch(LAUNCH);
  const context = await browser.newContext({
    viewport: { width: 430, height: 932 }, // a roomy phone
    deviceScaleFactor: 2, // crisp @2x output
    permissions: ['clipboard-read', 'clipboard-write'], // signing links are copied
  });
  if (MOCK_API) {
    log('running against the in-memory backend (MOCK_API=1)');
    await installFakeApi(context, MOCK_STATE);
  }
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  try {
    await signInOrUp(page);

    // Seed only if the workspace is empty.
    const hasShow = await page.locator('.show-card').count();
    if (!hasShow) {
      await seedShow(page);
    } else {
      log('account already has shows — capturing as-is');
      await page.locator('.show-card').first().click();
      await page.locator('.show-detail').waitFor();
    }

    // 1) Show detail (we're already on it after seeding/opening).
    await shot(page, 'show-detail');

    // 2) Run Show live mode.
    await captureRunShow(page);

    // 3) Shows dashboard.
    await page.locator('.show-detail__back-btn').first().click();
    await page.locator('.shows-list').waitFor();
    await shot(page, 'shows');

    // 4) The rest of the show screens, then the between-shows pages.
    await page.locator('.show-card').first().click();
    await page.locator('.show-detail').waitFor();
    await captureShowScreens(page);
    await page.locator('.show-detail__back-btn').first().click();
    await page.locator('.shows-list').waitFor();
    await captureRolodexAndSettings(page);
    await captureMore(page);
    await captureContracts(page, context);
    await captureSettings(page);

    // Last: it needs the show page, and leaves Run Show on the way out.
    await page.locator('.bottom-nav__item', { hasText: 'Shows' }).click();
    await page.locator('.shows-list').waitFor();
    await page.locator('.show-card').first().click();
    await page.locator('.show-detail').waitFor();
    await captureRunShowGif(page);

    log('done');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('screenshot capture failed:', err);
  process.exit(1);
});
