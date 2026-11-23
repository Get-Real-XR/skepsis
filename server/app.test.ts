/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type {
  DiffArgs,
  DiffResponse,
  DifftasticResponse,
  FileContentsResponse,
  RevisionGraph,
} from '../shared/types.ts'
import type { App } from './app.ts'
import { buildDiffSource } from './diffSource.ts'
import { isolateVcsConfig, run } from './testUtil.ts'

// See main.test.ts: HOME must be isolated before app.ts loads.
const home = await isolateVcsConfig()
const { buildApp } = await import('./app.ts')

let tmp: string

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'skepsis-app-test-'))
})

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

/** A git repo with f.txt changed from `before` to `after` in the working tree */
async function repo(
  name: string,
  before: string,
  after: string,
  file = 'f.txt',
): Promise<string> {
  const dir = join(tmp, name)
  await run('git', ['init', '-q', dir], tmp)
  await writeFile(join(dir, file), before)
  await run('git', ['add', '.'], dir)
  await run('git', ['commit', '-qm', 'init'], dir)
  await writeFile(join(dir, file), after)
  return dir
}

const diffSource: DiffArgs = {
  vcs: 'git',
  args: ['HEAD'],
  toWorkingCopy: true,
  files: [],
  endpoints: { left: 'HEAD', right: 'workingCopy' },
}

/** A request as a host passes it on, with no token and its prefix removed */
async function json(app: App, path: string): Promise<unknown> {
  return (await app.fetch(new Request(`https://example.ts.net${path}`))).json()
}

it('serves several diffs in one process, each from its own directory, guard off', async () => {
  const dirs = [await repo('a', 'a1\n', 'a2\n'), await repo('b', 'b1\n', 'b2\n')]
  const apps = await Promise.all(
    dirs.map((cwd) => buildApp({ cwd, diffSource, guard: false })),
  )
  const diffs = (await Promise.all(
    apps.map((app) => json(app, '/api/diff')),
  )) as DiffResponse[]
  expect(apps.map((app) => app.token)).toEqual([null, null])
  expect(diffs.map((d) => d.repo)).toEqual(['a', 'b'])
  expect(diffs[0]!.patch).toContain('-a1\n+a2')
  expect(diffs[1]!.patch).toContain('-b1\n+b2')
  const contents = (await Promise.all(
    apps.map((app) => json(app, '/api/file-contents?path=f.txt')),
  )) as FileContentsResponse[]
  expect(contents).toEqual([
    { oldContents: 'a1\n', newContents: 'a2\n' },
    { oldContents: 'b1\n', newContents: 'b2\n' },
  ])
})

it('restricts Difftastic previews to files in the review', async () => {
  const cwd = await repo('difftastic-scope', 'before\n', 'after\n')
  await writeFile(join(cwd, 'outside.txt'), 'outside the patch\n')
  const app = await buildApp({ cwd, diffSource, guard: false })
  const response = await app.fetch(
    new Request('https://example.ts.net/api/difftastic?path=outside.txt'),
  )
  expect(response.status).toBe(400)
})

it('filters a Jujutsu merge graph and keeps each review at its own revisions', async () => {
  const cwd = join(tmp, 'revisions')
  await run('jj', ['git', 'init', cwd], tmp)
  const jj = (...args: string[]) => run('jj', args, cwd)
  const commit = async () =>
    (await jj('log', '-r', '@', '--no-graph', '-T', 'commit_id')).stdout
  await writeFile(join(cwd, 'f.txt'), 'base\n')
  await jj('commit', '-m', 'base')
  const base = (await jj('log', '-r', '@-', '--no-graph', '-T', 'commit_id')).stdout
  await writeFile(join(cwd, 'f.txt'), 'left\n')
  await jj('describe', '-m', 'left')
  const left = await commit()
  await jj('new', base)
  await writeFile(join(cwd, 'other.txt'), 'right\n')
  await jj('describe', '-m', 'right')
  const right = await commit()
  await jj('new', left, right, '-m', 'merge')
  await writeFile(join(cwd, 'f.txt'), 'working\n')

  const source = buildDiffSource({ cwd, vcs: 'jj', from: base, to: '@' })
  const app = await buildApp({
    cwd,
    diffSource: source,
    graphRevset: 'ancestors(@, 2)',
    guard: false,
  })
  const graph = (await json(app, '/api/revisions')) as RevisionGraph
  expect(graph.nodes).toHaveLength(3)
  expect(graph.nodes[0]).toMatchObject({
    description: 'merge',
    parents: [left, right],
    workingCopy: true,
  })
  const filtered = (await json(app, '/api/revisions?revset=%40-')) as RevisionGraph
  expect(filtered.nodes.map((node) => node.commit)).toEqual(
    expect.arrayContaining([left, right]),
  )

  const historical = `viewChange=${left}`
  const selected = (await json(app, '/api/diff?' + historical)) as DiffResponse
  expect(selected.patch).toContain('-base\n+left')
  expect(selected.commentsEnabled).toBe(false)
  const request = new Request('https://example.ts.net/api/comment?' + historical, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: 'f.txt', afterLine: 1, lineText: 'left', text: 'Review' }),
  })
  expect((await app.fetch(request)).status).toBe(403)
  const working = (await json(app, `/api/diff?viewFrom=${base}&viewTo=%40`)) as DiffResponse
  expect(working.patch).toContain('-base\n+working')
  expect(working.commentsEnabled).toBe(true)
  const file = (await json(
    app,
    '/api/file-contents?path=f.txt&' + historical,
  )) as FileContentsResponse
  expect(file.newContents).toBe('left\n')
  const mergeFile = (await json(
    app,
    '/api/file-contents?path=f.txt&viewChange=%40',
  )) as FileContentsResponse
  expect(mergeFile).toEqual({ oldContents: 'left\n', newContents: 'working\n' })
})

const difftAvailable = spawnSync('difft', ['--version'], { stdio: 'ignore' }).status === 0

it.skipIf(!difftAvailable)('uses syntax to identify whitespace-only changes', async () => {
  const cwd = await repo(
    'difftastic-syntax',
    'fn show() {}\n',
    'fn show() { }\n',
    'example.rs',
  )
  const app = await buildApp({ cwd, diffSource, guard: false })
  const response = await app.fetch(
    new Request('https://example.ts.net/api/difftastic?path=example.rs'),
  )
  expect(response.status).toBe(200)
  const result = (await response.json()) as DifftasticResponse
  expect(result).toMatchObject({
    language: 'Rust',
    unchanged: true,
    hasHiddenLines: true,
    lines: [],
  })
  const expanded = (await json(
    app,
    '/api/difftastic?path=example.rs&full=1',
  )) as DifftasticResponse
  expect(expanded.lines).toEqual([
    { kind: 'context', side: 'additions', number: 1, text: 'fn show() { }', changes: [] },
  ])
})

it.skipIf(!difftAvailable)(
  'keeps identical aligned lines in a multiline YAML token neutral',
  async () => {
    const before = 'run: |\n  export A=1\n  cargo test\n  exit 0\n'
    const cwd = await repo(
      'difftastic-yaml',
      before,
      before.replace('A=1', 'A=2'),
      'example.yaml',
    )
    const app = await buildApp({ cwd, diffSource, guard: false })
    const diff = (await json(
      app,
      '/api/difftastic?path=example.yaml',
    )) as DifftasticResponse
    expect(diff.sections[0]?.layout).toBe('split')
    const identical = diff.lines.filter((line) => line.text === '  cargo test')
    expect(identical).toHaveLength(2)
    expect(
      identical.every((line) => line.kind === 'context' && line.changes.length === 0),
    ).toBe(true)
    expect(diff.lines.find((line) => line.text === '  export A=2')).toMatchObject({
      kind: 'addition',
      changes: expect.arrayContaining([expect.objectContaining({ start: 11, end: 12 })]),
    })
  },
)

it.skipIf(!difftAvailable)(
  'anchors structural comments to exact source lines and rejects stale text',
  async () => {
    const before = 'fn show() { emit("🦀", 1); }\n'
    const after = 'fn show() { emit("🦀", 3); }\n'
    const cwd = await repo('difftastic-anchor', before, after, 'example.rs')
    const app = await buildApp({ cwd, diffSource, guard: false })
    const diff = (await json(app, '/api/difftastic?path=example.rs')) as DifftasticResponse
    const line = diff.lines.find((row) => row.kind === 'addition')!
    expect(line.number).toBe(1)
    expect(line.text).toBe(after.trimEnd())
    expect(line.changes.map(({ start, end }) => line.text.slice(start, end))).toEqual(['3'])
    expect(diff.sections).toEqual([{ layout: 'split', rows: [{ old: 0, new: 1 }] }])
    const comment = () =>
      app.fetch(
        new Request('https://example.ts.net/api/comment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file: 'example.rs',
            afterLine: line.number,
            lineText: line.text,
            contentHash: diff.newContentHash,
            text: 'Why three?',
          }),
        }),
      )

    const file = join(cwd, 'example.rs')
    const interveningEdit = after + '\n// unrelated edit\n'
    await writeFile(file, interveningEdit)
    const rejected = await comment()
    expect(rejected.status).toBe(500)
    expect(await rejected.json()).toEqual({
      error: 'The file changed on disk. Refresh and anchor the comment again.',
    })
    expect(await readFile(file, 'utf8')).toBe(interveningEdit)

    await writeFile(file, after)
    expect((await comment()).status).toBe(200)
    expect(await readFile(file, 'utf8')).toBe(
      after + '// <review>\n// Why three?\n// </review>\n',
    )
  },
)

it.skipIf(!difftAvailable)(
  'marks every code token in wholly added or removed content',
  async () => {
    const text = 'fn new_handler() {}'
    const path = 'handler.rs'
    const added = await repo('difftastic-whole-addition', '', text + '\n', path)
    const removed = await repo('difftastic-whole-deletion', text + '\n', '', path)
    const [addedApp, removedApp] = await Promise.all(
      [added, removed].map((cwd) => buildApp({ cwd, diffSource, guard: false })),
    )
    const query = '/api/difftastic?path=' + path
    const left = (await json(addedApp!, query)) as DifftasticResponse
    const right = (await json(removedApp!, query)) as DifftasticResponse
    const changes = [{ start: 0, end: text.length }]
    expect(left.sections).toEqual([{ layout: 'new', rows: [{ old: null, new: 0 }] }])
    expect(right.sections).toEqual([{ layout: 'old', rows: [{ old: 0, new: null }] }])
    expect(left.lines).toEqual([
      { kind: 'addition', side: 'additions', number: 1, text, changes },
    ])
    expect(right.lines).toEqual([
      { kind: 'deletion', side: 'deletions', number: 1, text, changes },
    ])
  },
)
