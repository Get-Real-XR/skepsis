/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type { DifftasticResponse } from '../shared/types.ts'
import { COMMITTED, expect, test, WORKING } from './fixtures.ts'

test('comments and resolves in the Difftastic pane', async ({ page, repo }) => {
  await page.route('**/api/difftastic?*', async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path')!
    const source = await repo.read(path)
    const lines: DifftasticResponse['lines'] = source
      .trimEnd()
      .split('\n')
      .map((text, i) => {
        const start = text.indexOf('22')
        return {
          kind: start === -1 ? 'context' : 'addition',
          side: 'additions',
          number: i + 1,
          text,
          changes: start === -1 ? [] : [{ start, end: start + 2 }],
        }
      })
    await route.fulfill({
      json: {
        language: 'TypeScript',
        lines,
        sections: [
          { layout: 'new', rows: lines.map((_, index) => ({ old: null, new: index })) },
        ],
        tabWidth: 4,
        unchanged: false,
        hasHiddenLines: false,
        newContentHash: createHash('sha256').update(source).digest('hex'),
      } satisfies DifftasticResponse,
    })
  })

  const toggle = page.getByRole('button', { name: 'Difftastic' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  const diff = page.getByRole('region', { name: 'Difftastic changes' })
  const file = diff.locator('[data-difftastic-file="a.ts"]')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.file-tree')).toBeVisible()

  const row = file.locator('[data-side="additions"][data-line-number="2"]')
  const changedToken = row.locator('mark')
  await expect(changedToken).toHaveText('22')
  const contextBackground = await file
    .locator('[data-line-number="1"]')
    .evaluate((element) => getComputedStyle(element).backgroundColor)
  await expect(row).toHaveCSS('background-color', contextBackground)
  const contextColor = await row
    .locator('code')
    .evaluate((element) => getComputedStyle(element).color)
  await expect(changedToken).not.toHaveCSS('color', contextColor)
  await expect(changedToken).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(changedToken).toHaveCSS('font-weight', '700')

  await file.getByRole('button', { name: 'Comment on new line 2' }).click()
  await file.getByRole('textbox').fill('Why twenty-two?')
  await file.getByRole('button', { name: 'Comment', exact: true }).click()
  const resolve = file.getByRole('button', { name: 'Resolve comment' })
  await expect(resolve).toBeVisible()
  expect(await repo.read('a.ts')).toContain(
    'const two = 22\n// <review>\n// Why twenty-two?',
  )
  await resolve.click()
  await expect(resolve).toHaveCount(0)
  expect(await repo.read('a.ts')).toBe(WORKING['a.ts'])

  await changedToken.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await changedToken.dispatchEvent('mouseup', { button: 0 })
  await file.getByRole('textbox').fill('Check this value.')
  await file.getByRole('button', { name: 'Comment', exact: true }).click()
  await expect(resolve).toBeVisible()
  expect(await repo.read('a.ts')).toContain('// <review on="22">\n// Check this value.')
  await resolve.click()
  await expect(resolve).toHaveCount(0)

  await file.getByRole('button', { name: 'Viewed' }).click()
  await expect(file.locator('.difftastic-lines')).toHaveCount(0)
  await toggle.click()
  await expect(diff).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Viewed' }).first()).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
})

const difftAvailable = spawnSync('difft', ['--version'], { stdio: 'ignore' }).status === 0

test.describe('native Difftastic', () => {
  const old =
    Array.from({ length: 20 }, (_, i) => `const value${i} = ${i}`).join('\n') + '\n'
  test.use({
    repoFiles: {
      committed: { ...COMMITTED, 'long.ts': old },
      working: {
        ...WORKING,
        'long.ts': old.replace('value2 = 2', 'value2 = 22') + 'const last = 100\n',
      },
    },
  })
  test('uses one and two columns in the same diff', async ({ page }) => {
    test.skip(!difftAvailable, 'requires difft on PATH')
    await page.getByRole('button', { name: 'Difftastic' }).click()
    const file = page.locator('[data-difftastic-file="long.ts"]')
    await file.locator('.difftastic-file-body').scrollIntoViewIfNeeded()
    const split = file.locator('[data-layout="split"]')
    const addition = file.locator('[data-layout="new"]')
    await expect(split.locator('[data-side="deletions"] mark')).toHaveText('2')
    await expect(split.locator('[data-side="additions"] mark')).toHaveText('22')
    await expect(addition.locator('[data-side="deletions"]')).toHaveCount(0)
    await expect(addition.locator('[data-line-number="21"] code')).toHaveText(
      'const last = 100',
    )

    await split.getByRole('button', { name: 'Comment on new line 3' }).click()
    await file.getByRole('textbox').fill('Check this value.')
    await file.getByRole('button', { name: 'Comment', exact: true }).click()
    await expect(file.getByRole('button', { name: 'Resolve comment' })).toBeVisible()
  })
})
