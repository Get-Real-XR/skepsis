/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { HTTPException } from 'hono/http-exception'
import { REVIEW_REVISION_PARAMS } from '../shared/types.ts'
import type {
  DiffArgs,
  RangeReviewProgress,
  RevisionComparison,
  RevisionGraph,
} from '../shared/types.ts'
import { changeFileHashes, normalizeJjRenames } from './diff.ts'
import { buildDiffSource } from './diffSource.ts'
import { countViewed } from './viewed.ts'

const run = promisify(execFile)
const GRAPH_LIMIT = 160
const GRAPH_TEMPLATE =
  '"[" ++ json(commit_id) ++ "," ++ json(change_id) ++ ","' +
  ' ++ json(parents.map(|p| p.commit_id())) ++ "," ++ json(description.first_line())' +
  ' ++ "," ++ json(bookmarks.map(|b| b.name())) ++ "," ++ json(current_working_copy) ++ "]\\n"'

export const DEFAULT_GRAPH_REVSET = 'ancestors(@, 40) | present(trunk())'

function selectableRevision(rev: string | null | undefined) {
  return rev === '@' || /^[a-f0-9]{40}$/.test(rev ?? '')
}

export function currentComparison(source: DiffArgs): RevisionComparison | undefined {
  const { endpoints } = source
  if (
    source.vcs === 'jj' &&
    source.args[0] !== '-r' &&
    endpoints &&
    endpoints.right !== 'workingCopy'
  ) {
    return { from: endpoints.left, to: endpoints.right.rev }
  }
}

export function reviewRange(source: DiffArgs): RevisionComparison | undefined {
  if (source.interdiff || source.vcs !== 'jj') return undefined
  if (source.args[0] !== '-r') return currentComparison(source)
  const { endpoints } = source
  if (source.args[1]?.includes('..') && endpoints && endpoints.right !== 'workingCopy') {
    return { from: endpoints.left, to: endpoints.right.rev }
  }
}

export async function changeReviewId(
  cwd: string,
  source: DiffArgs,
): Promise<string | undefined> {
  if (
    source.vcs !== 'jj' ||
    source.args[0] !== '-r' ||
    !source.args[1] ||
    reviewRange(source)
  )
    return undefined
  const { stdout } = await run(
    'jj',
    [
      '--ignore-working-copy',
      'log',
      '--color=never',
      '--no-graph',
      '--limit=2',
      `--revisions=${source.args[1]}`,
      '--template',
      'change_id ++ "\\n"',
    ],
    { cwd, timeout: 3000, maxBuffer: 16384 },
  ).catch(() => ({ stdout: '' }))
  const id = stdout.trimEnd()
  return /^[k-z]+$/.test(id) ? id : undefined
}

export async function rangeReviewProgress(
  cwd: string,
  source: DiffArgs,
): Promise<RangeReviewProgress> {
  const range = reviewRange(source)
  if (!range)
    throw new HTTPException(422, { message: 'Select a revision range to see its changes.' })
  const from = `(${range.from})`
  const to = `(${range.to})`
  const forward = `${from}..${to}`
  const revset = `${forward} | ${to}..${from}`
  const fileset = source.files.length
    ? JSON.stringify(source.files.map((file) => `(${file})`).join(' | '))
    : ''
  const template =
    '"[" ++ json(commit_id) ++ "," ++ json(change_id) ++ ","' +
    ' ++ json(description.first_line()) ++ "," ++ json(current_working_copy) ++ ","' +
    ` ++ json(self.contained_in(${JSON.stringify(forward)})) ++ ","` +
    ` ++ json(stringify(self.diff(${fileset}).git())) ++ "]\\n"`
  try {
    const { stdout } = await run(
      'jj',
      [
        '--config',
        'diff.git.show-path-prefix=true',
        'log',
        '--color=never',
        '--no-graph',
        `--revisions=${revset}`,
        '--template',
        template,
      ],
      { cwd, timeout: 12000, maxBuffer: 32 * 1024 * 1024 },
    )
    const rows = stdout.trimEnd().split('\n').filter(Boolean)
    const changes = rows.map((row) => {
      const [commit, change, description, workingCopy, inTo, patch] = JSON.parse(row) as [
        string,
        string,
        string,
        boolean,
        boolean,
        string,
      ]
      const files = changeFileHashes(normalizeJjRenames(patch), change)
      return { commit, change, description, workingCopy, inTo, files }
    })
    const counts = await countViewed(
      cwd,
      changes.map((change) => change.files),
    )
    const fromOnly: RangeReviewProgress['fromOnly'] = []
    const toOnly: RangeReviewProgress['toOnly'] = []
    for (const [index, { inTo, files, ...change }] of changes.entries()) {
      const side = inTo ? toOnly : fromOnly
      side.push({ ...change, files: Object.keys(files).length, viewed: counts[index]! })
    }
    return { fromOnly, toOnly: toOnly.toReversed() }
  } catch (cause) {
    const details = (cause as { stderr?: string }).stderr?.trim()
    throw new HTTPException(400, {
      message: details || 'Could not list the changes in this range. Try a smaller range.',
      cause,
    })
  }
}

export async function revisionGraph(cwd: string, revset: string): Promise<RevisionGraph> {
  if (revset.length > 2048) throw new HTTPException(400, { message: 'Revset is too long.' })
  try {
    const { stdout } = await run(
      'jj',
      [
        'log',
        '--color=never',
        '--no-graph',
        `--limit=${GRAPH_LIMIT + 1}`,
        `--revisions=${revset}`,
        '--template',
        GRAPH_TEMPLATE,
      ],
      { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 },
    )
    const rows = stdout.trimEnd().split('\n').filter(Boolean)
    const nodes = rows.slice(0, GRAPH_LIMIT).map((row) => {
      const [commit, change, parents, description, bookmarks, workingCopy] = JSON.parse(
        row,
      ) as [string, string, string[], string, string[], boolean]
      return { commit, change, parents, description, bookmarks, workingCopy }
    })
    return { revset, nodes, truncated: rows.length > GRAPH_LIMIT }
  } catch (cause) {
    const details = (cause as { stderr?: string }).stderr?.trim()
    throw new HTTPException(400, {
      message: details || 'Could not load the revision graph.',
      cause,
    })
  }
}

export function selectReview(params: URLSearchParams, source: DiffArgs, cwd: string) {
  const [change, from, to] = REVIEW_REVISION_PARAMS.map((key) => params.get(key))
  if (change == null && from == null && to == null) return null
  const initial = currentComparison(source)
  const validEndpoint = (revision: string | null | undefined) =>
    revision != null &&
    (selectableRevision(revision) || revision === initial?.from || revision === initial?.to)
  if (
    source.vcs !== 'jj' ||
    (change != null
      ? !selectableRevision(change) || from != null || to != null
      : !validEndpoint(from) || !validEndpoint(to))
  ) {
    throw new HTTPException(400, {
      message: 'Select a change or both endpoints from the graph.',
    })
  }
  return {
    key: JSON.stringify([change, from, to]),
    diffSource: buildDiffSource({
      cwd,
      vcs: 'jj',
      files: source.files,
      revisions: change ?? undefined,
      from: from ?? undefined,
      to: to ?? undefined,
    }),
  }
}
