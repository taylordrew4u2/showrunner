import { expect, test } from '@playwright/test';
import { emptyState, installFakeApi } from './support/fake-api.mjs';
import { gotoTab, signUpAndOnboard } from './support/app';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A small but genuinely valid one-page PDF to stand in for an agreement. */
function writeTestPdf(): string {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    '<< /Length 44 >>\nstream\nBT /F1 16 Tf 72 700 Td (Performer Agreement) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const path = join(mkdtempSync(join(tmpdir(), 'showrunner-e2e-')), 'agreement.pdf');
  writeFileSync(path, out, 'latin1');
  return path;
}

test.describe('contracts', () => {
  test('a signer with no account can open a link and sign, once', async ({ page, context, browser }) => {
    const state = emptyState();
    await installFakeApi(context, state);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const apiCalls: string[] = [];
    context.on('request', (r) => {
      if (r.url().includes('/api/')) apiCalls.push(`${r.url()} ${r.postData() ?? ''}`);
    });

    await signUpAndOnboard(page);

    // Someone to send it to.
    await gotoTab(page, 'Rolodex');
    await page.locator('.rolodex__input').first().fill('Nadia Okonjo');
    await page.locator('button').filter({ hasText: /^Add$/ }).first().click();

    await gotoTab(page, 'More');
    await page.locator('.more-item').filter({ hasText: 'Contracts' }).click();
    await page.locator('.contracts__file').setInputFiles(writeTestPdf());
    await expect(page.locator('.contracts__item-name')).toHaveText('agreement');

    await page.locator('.contracts__item').first().click();
    await page.locator('.contracts__send-btn').click();
    await page.locator('.contracts__candidate').first().click();
    await expect(page.locator('.contracts__row')).toContainText('Nadia Okonjo');

    const link = await page.evaluate(() => navigator.clipboard.readText());
    const key = link.split('#k=')[1];
    expect(key, 'the link must carry a key').toBeTruthy();

    // The security claim, asserted rather than described: the key that
    // decrypts the document is in the fragment, which browsers never send.
    expect(link.split('#')[0]).not.toContain(key);
    expect(apiCalls.filter((c) => c.includes(key))).toEqual([]);
    expect(JSON.stringify(state.sign) + JSON.stringify(state.doc)).not.toContain('Nadia');

    // The signer: a different browser context, no session, no account.
    const signerContext = await browser.newContext();
    await installFakeApi(signerContext, state);
    const signer = await signerContext.newPage();
    await signer.goto(link);
    await expect(signer.locator('.signing__title')).toBeVisible();

    await signer.locator('.signing__field--name input').fill('Nadia Okonjo');
    // The contract asks for a few details as well as a signature; Email is the
    // one it insists on.
    await signer.getByLabel('Email').fill('nadia@example.com');
    await signer.locator('.signing__agree input').check();
    await signer.locator('.signing__cta').click();
    await expect(signer.locator('.signing__panel--done')).toContainText('Signed');

    // Reopening cannot re-sign: the row is spent.
    const replay = await signerContext.newPage();
    await replay.goto(link);
    await expect(replay.locator('.signing__panel--done')).toContainText('Signed');
    await expect(replay.locator('.signing__cta')).not.toHaveText(/Agree and sign/);

    // And the producer sees it, without being told.
    await page.reload();
    await gotoTab(page, 'More');
    await page.locator('.more-item').filter({ hasText: 'Contracts' }).click();
    await expect(page.locator('.contracts__item-meta')).toContainText('1 of 1 signed');

    await signerContext.close();
  });
});
