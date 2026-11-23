/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 * Copyright Oxide Computer Company
 */

import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { exec, startCli } from '../server/testUtil.ts'
import { browserTest as test, expect, makeRepo } from './fixtures.ts'

test('filters the revision graph and navigates between change and comparison reviews', async ({
  page,
}) => {
  const { dir, home, env } = await makeRepo({
    committed: { 'example.ts': 'const value = 1\n' },
    working: {},
  })
  const config = join(home, 'jj-config.toml')
  await writeFile(config, '[user]\nname = "Test"\nemail = "test@example.com"\n')
  const jjEnv = { ...env, JJ_CONFIG: config }
  const jj = (...args: string[]) => exec('jj', args, { cwd: dir, env: jjEnv })
  let server: Awaited<ReturnType<typeof startCli>> | undefined
  try {
    await jj('git', 'init', '--colocate')
    await writeFile(join(dir, 'example.ts'), 'const value = 2\n')
    await jj('commit', '-m', 'Change the value')
    await writeFile(join(dir, 'example.ts'), 'const value = 3\n')
    server = await startCli(
      dir,
      ['-f', 'main', '-t', '@', '--revset', 'ancestors(@, 3)'],
      jjEnv,
    )
    await page.goto(server.url)
    await page.evaluate(() => {
      document.documentElement.dataset['sameDocument'] = 'yes'
    })
    const trigger = page.getByRole('button', { name: 'Revisions', exact: true })
    const comparison = page.getByRole('group', { name: 'Current comparison' })
    await expect(comparison).toContainText(/main\s*→\s*@/)
    const graph = page.getByRole('dialog', { name: 'Revisions' })
    await comparison.getByRole('button', { name: 'Change To: @' }).click()
    await expect(graph.getByRole('button', { name: 'Choose To: @' })).toBeFocused()
    await page.keyboard.press('Escape')
    await comparison.getByRole('button', { name: 'Change From: main' }).click()
    await expect(graph.locator('.revision-row')).toHaveCount(3)
    await expect(
      graph.getByRole('button', { name: /^Compare from .*to working copy/ }).first(),
    ).toBeVisible()
    await graph.getByRole('button', { name: 'Custom range' }).click()
    await expect(graph.getByRole('button', { name: 'Choose From: main' })).toBeFocused()
    await expect(graph.getByRole('button', { name: 'Choose To: @' })).toBeVisible()
    await expect(graph.getByRole('button', { name: 'Compare revisions' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(graph.getByRole('button', { name: /^View change / })).toHaveCount(0)
    await graph.getByRole('button', { name: 'Swap From and To' }).click()
    await graph.getByRole('button', { name: 'Show diff', exact: true }).click()
    await expect(page).toHaveURL(/viewFrom=%40&viewTo=main/)
    await expect(comparison).toContainText(/@\s*→\s*main/)
    await page.getByRole('button', { name: 'Changes', exact: true }).click()
    const reverse = page.getByRole('dialog', { name: 'Changes in range' })
    await expect(reverse.getByRole('heading', { name: 'Only in From' })).toBeVisible()
    await reverse.getByRole('button', { name: 'Close changes' }).click()
    await trigger.click()
    await graph.getByLabel('Revset').fill('@-')
    await graph.getByRole('button', { name: 'Apply' }).click()
    await expect(graph.locator('.revision-row')).toHaveCount(1)
    await graph.getByRole('button', { name: 'Single change' }).click()
    await expect(graph.getByRole('group', { name: 'Comparison endpoints' })).toHaveCount(0)
    await expect(graph.getByRole('button', { name: /^Set (From|To) to / })).toHaveCount(0)
    await graph.getByRole('button', { name: 'View change Change the value' }).click()
    await expect(page).toHaveURL(/viewChange=/)
    expect(new URL(page.url()).searchParams.has('viewFrom')).toBe(false)
    expect(new URL(page.url()).searchParams.has('viewTo')).toBe(false)
    await trigger.click()
    await expect(graph.getByLabel('Revset')).toHaveValue('@-')
    await expect(graph.getByRole('button', { name: 'Single change' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await graph.getByRole('button', { name: 'Compare revisions' }).click()
    await graph.getByRole('button', { name: 'Custom range' }).click()
    await graph.getByRole('button', { name: 'Set From to Change the value' }).click()
    await expect(
      graph.getByRole('button', { name: 'Show diff', exact: true }),
    ).toBeDisabled()
    await graph.getByLabel('Revset').fill('ancestors(@, 3)')
    await graph.getByRole('button', { name: 'Apply' }).click()
    await graph.getByRole('button', { name: /^Choose To:/ }).click()
    await graph.getByRole('button', { name: 'Set To to Working copy', exact: true }).click()
    await graph.getByRole('button', { name: 'Show diff', exact: true }).click()
    await expect(page).toHaveURL(/viewTo=%40/)
    expect(new URL(page.url()).searchParams.has('viewChange')).toBe(false)
    await expect(page.locator('.file-header').first()).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-same-document', 'yes')
    await page.setViewportSize({ width: 390, height: 730 })
    await trigger.click()
    await graph.getByRole('button', { name: 'Custom range' }).click()
    const layout = await graph.evaluate((element) => ({
      width: element.clientWidth,
      content: element.scrollWidth,
    }))
    expect(layout.content).toBeLessThanOrEqual(layout.width)
    await expect(
      graph.getByRole('button', { name: 'Show diff', exact: true }),
    ).toBeVisible()
    await page.goBack()
    await expect(page).toHaveURL(/viewChange=/)
    await expect(page.locator('.file-header').first()).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-same-document', 'yes')
  } finally {
    server?.proc.kill()
    await rm(dir, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('pick a base directly and track viewed files separately in each change', async ({
  page,
}) => {
  const { dir, home, env } = await makeRepo({
    committed: { 'a.ts': 'const a = 1\n', 'b.ts': 'const b = 1\n' },
    working: {},
  })
  const config = join(home, 'jj-config.toml')
  await writeFile(config, '[user]\nname = "Test"\nemail = "test@example.com"\n')
  const jjEnv = { ...env, JJ_CONFIG: config }
  const jj = (...args: string[]) => exec('jj', args, { cwd: dir, env: jjEnv })
  let server: Awaited<ReturnType<typeof startCli>> | undefined
  try {
    await jj('git', 'init', '--colocate')
    await writeFile(join(dir, 'a.ts'), 'const a = 2\n')
    await jj('commit', '-m', 'First change')
    await writeFile(join(dir, 'a.ts'), 'const a = 3\n')
    await writeFile(join(dir, 'b.ts'), 'const b = 3\n')
    await jj('describe', '-m', 'Second change')
    server = await startCli(dir, ['-r', '@', '--revset', 'ancestors(@, 3)'], jjEnv)
    await page.goto(server.url)
    await page.getByRole('button', { name: 'Revisions', exact: true }).click()
    const graph = page.getByRole('dialog', { name: 'Revisions' })
    await graph.getByRole('button', { name: 'Compare revisions' }).click()
    await graph.getByRole('button', { name: 'Compare from init to working copy' }).click()
    await expect(page).toHaveURL(/viewFrom=.+&viewTo=%40/)
    const comparisonUrl = page.url()
    const viewed = page.locator('.viewed-button')
    await viewed.first().click()
    await expect(viewed.first()).toHaveClass(/checked/)

    const changes = page.getByRole('button', { name: 'Changes', exact: true })
    const list = page.getByRole('dialog', { name: 'Changes in range' })
    const first = list.getByRole('button', { name: /First change/ })
    const second = list.getByRole('button', { name: /Second change/ })
    await changes.click()
    await expect(list.getByRole('status')).toHaveText('0 of 2 changes viewed')
    await expect(first).toContainText('0/1 files')
    await expect(second).toContainText('0/2 files')
    await first.click()
    await expect(page).toHaveURL(/viewChange=/)
    await expect(viewed).toHaveCount(1)
    await viewed.click()
    await changes.click()
    await expect(first).toContainText('✓ Viewed')
    await expect(second).toContainText('0/2 files')
    await second.click()
    await expect(page).toHaveURL(/viewChange=%40/)
    await expect(viewed).toHaveCount(2)
    await viewed.first().click()
    await changes.click()
    await expect(second).toContainText('1/2 files')
    await list.getByRole('button', { name: 'Close changes' }).click()
    await viewed.nth(1).click()
    await changes.click()
    await expect(list.getByRole('status')).toHaveText('2 of 2 changes viewed')
    await expect(second).toContainText('✓ Viewed')
    await list.getByRole('button', { name: 'Close changes' }).click()
    await viewed.nth(1).click()
    await changes.click()
    await expect(list.getByRole('status')).toHaveText('1 of 2 changes viewed')
    await list.getByRole('button', { name: 'Back to comparison' }).click()
    await expect(page).toHaveURL(comparisonUrl)
    await expect(viewed.first()).toHaveClass(/checked/)
  } finally {
    server?.proc.kill()
    await rm(dir, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})
