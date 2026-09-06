import { expect, test } from '@playwright/test';
import { emptyState, installFakeApi } from './support/fake-api.mjs';
import { createShow, signUpAndOnboard } from './support/app';

/**
 * Booking a weekly room.
 *
 * A producer's most repetitive job is building the same night over and over,
 * so this walks the whole of it: a show with a lineup, repeated four times,
 * and the copies carrying the bill on the right dates.
 */
test.describe('repeating a show', () => {
  test('books a run of the same show, lineup and all', async ({ page, context }) => {
    await installFakeApi(context, emptyState());
    await signUpAndOnboard(page);

    // A show on a known Tuesday, with someone on the bill.
    await createShow(page, 'Tuesday Night Laughs', '2026-04-07');

    // Performers is open on a new show already — clicking it here would close it.
    await page.getByPlaceholder('Performer name').fill('Ada Cole');
    await page.locator('button').filter({ hasText: /^Add$/ }).first().click();
    await expect(page.locator('.section-list-item__name').filter({ hasText: 'Ada Cole' })).toBeVisible();

    // Repeat it weekly, four more times.
    await page.locator('button[aria-label="More"], .more-menu__trigger').first().click();
    await page.getByText('Repeat this show…').click();
    await expect(page.locator('.repeat-show__rule')).toHaveText('Every week on Tuesday');

    // The dates are shown before anything is booked — this is the last point
    // at which a wrong one costs nothing.
    await expect(page.locator('.repeat-show__dates li')).toHaveCount(4);
    // The runner's locale decides the order of the parts, so assert on what
    // the date means rather than how it is punctuated: the Tuesday a week on.
    await expect(page.locator('.repeat-show__dates li').first()).toContainText(/Tue/);
    await expect(page.locator('.repeat-show__dates li').first()).toContainText(/14/);
    await expect(page.locator('.repeat-show__dates li').last()).toContainText(/May|5/);

    await page.locator('.repeat-show__actions .btn--primary').click();

    // Five nights now: the original and four repeats, each with the bill.
    await expect(page.locator('.show-card')).toHaveCount(5);
    await page.locator('.show-card').filter({ hasText: 'Tuesday Night Laughs' }).first().click();
    await expect(
      page.locator('.section-list-item__name').filter({ hasText: 'Ada Cole' }),
    ).toBeVisible();
  });
});
