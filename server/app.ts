/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { serveStatic } from '@hono/node-server/serve-static'
import { zValidator } from '@hono/zod-validator'
import { basename, join } from 'node:path'
import type { DiffArgs } from '../shared/types.ts'
import { changeFileHashes, getDiff, patchHash } from './diff.ts'
import { displayCommand } from './displayCommand.ts'
import { getFileContents } from './fileContents.ts'
import { difftasticPresentation, renderDifftastic } from './difftastic.ts'
import { getGeneratedFiles } from './generated.ts'
import { loadViewed, markViewed, unmarkViewed, unmarkViewedAll } from './viewed.ts'
import { insertComment, removeComment } from './comment.ts'
import { getCommentSyntaxes } from './commentSyntax.ts'
import { loadTheme, saveTheme, themeBootScript } from './settings.ts'
import { newToken, sendGate, tokenMatches } from './gate.ts'
import { buildPayload } from './send.ts'
import type { SendPayload, SendResult } from './send.ts'
import {
  changeReviewId,
  currentComparison,
  DEFAULT_GRAPH_REVSET,
  revisionGraph,
  rangeReviewProgress,
  reviewRange,
  selectReview,
} from './revisions.ts'
import {
  viewedRequestSchema,
  viewedDeleteSchema,
  viewedDeleteAllSchema,
  commentRequestSchema,
  commentDeleteSchema,
  sendRequestSchema,
  difftasticQuerySchema,
  fileContentsQuerySchema,
  themeRequestSchema,
  DEFAULT_TAB_SIZE,
  TOKEN_HEADER,
} from '../shared/types.ts'
import type {
  DiffHashResponse,
  DiffResponse,
  FileContentsResponse,
  OkResponse,
  ErrorResponse,
  ThemeResponse,
} from '../shared/types.ts'

export interface BuildOptions {
  diffSource: DiffArgs
  /** Absolute. Where jj/git run, and what comment and file paths are relative to */
  cwd: string
  /** Serve /api/diff-hash for the page's change polling. Default true. */
  poll?: boolean
  /** Delivers a comment the page sends. Unset, /api/send doesn't exist and
   *  the page has no Send button. */
  send?: ((payload: SendPayload) => Promise<SendResult>) | null
  /** Default true: API requests need the per-run token, and /api/send needs
   *  a loopback Host and a matching Origin. False when a host application
   *  checks requests before they get here */
  guard?: boolean
  /** Tab width in columns (default: DEFAULT_TAB_SIZE) */
  tabSize?: number
  /** Initial Jujutsu graph filter. */
  graphRevset?: string
}

/** A fetch handler for the page and its API, rooted at `/` */
export interface App {
  fetch(request: Request): Response | Promise<Response>
  /** The value API requests must send in the token header, or null when
   *  `guard` is false */
  token: string | null
}

/** The page and its API for one diff. Runs the diff once and rejects if it
 *  fails. */
export async function buildApp(opts: BuildOptions): Promise<App> {
  return buildReviewApp(opts, opts.guard === false ? null : newToken(), true)
}

async function buildReviewApp(
  opts: BuildOptions,
  token: string | null,
  routeSelections: boolean,
): Promise<App> {
  const { diffSource, cwd, poll = true, send, guard = true } = opts
  const { tabSize = DEFAULT_TAB_SIZE } = opts
  let difftasticSettings: ReturnType<typeof difftasticPresentation> | undefined
  // The paths in the latest diff, including the old names of renames. A
  // request's path is joined onto the repo directory, so the routes that read
  // or write files only take one of these: `../` could otherwise reach
  // anything the process can.
  let diffFiles = new Set<string>()
  const runDiff = async () => {
    const diff = await getDiff(diffSource, cwd)
    const renamedFrom = [...diff.patch.matchAll(/^rename from (.+)$/gm)].map((m) => m[1]!)
    diffFiles = new Set([...Object.keys(diff.fileHashes), ...renamedFrom])
    return diff
  }
  /** Throws unless `file` is in the diff, running it again first if the last
   *  one didn't have it */
  const requireInDiff = async (file: string) => {
    if (diffFiles.has(file)) return
    await runDiff()
    if (!diffFiles.has(file))
      throw new HTTPException(400, { message: `Not a file in this diff: ${file}` })
  }

  // Validate the command at server startup. A selection made in the browser
  // is validated by its first diff request.
  if (routeSelections) await runDiff()

  const app = new Hono()

  // Every API call must carry the token (see tokenMatches). The theme boot
  // script is the exception: a <script src> can't send a header, and all it
  // gives away is the theme.
  app.use('/api/*', async (c, next) => {
    if (
      token === null ||
      c.req.path === '/api/theme.js' ||
      tokenMatches(c.req.header(TOKEN_HEADER), token)
    )
      return next()
    return c.json(
      {
        error:
          'This page has no valid token. Open the URL skepsis printed when it started.',
      } satisfies ErrorResponse,
      401,
    )
  })

  if (routeSelections && diffSource.vcs === 'jj') {
    const selections = new Map<string, Promise<App>>()
    app.get('/api/revisions', async (c) => {
      const revset =
        c.req.query('revset')?.trim() || opts.graphRevset || DEFAULT_GRAPH_REVSET
      return c.json(await revisionGraph(cwd, revset))
    })
    app.use('/api/*', async (c, next) => {
      const selected = selectReview(new URL(c.req.url).searchParams, diffSource, cwd)
      if (!selected) return next()
      let review = selections.get(selected.key)
      if (!review) {
        if (selections.size >= 12) selections.delete(selections.keys().next().value!)
        review = buildReviewApp({ ...opts, diffSource: selected.diffSource }, token, false)
        selections.set(selected.key, review)
      }
      try {
        return (await review).fetch(c.req.raw)
      } catch (cause) {
        if (selections.get(selected.key) === review) selections.delete(selected.key)
        throw new HTTPException(400, {
          message:
            cause instanceof Error ? cause.message : 'Could not load this comparison.',
          cause,
        })
      }
    })
  }

  // An interdiff that ends at the working copy still can't take comments: a
  // changed description shows as a file named JJ-COMMIT-DESCRIPTION, which a
  // comment would create on disk.
  const commentsEnabled = diffSource.toWorkingCopy && !diffSource.interdiff

  app.get('/api/diff', async (c) => {
    const diff = await runDiff().catch((cause: unknown) => {
      if (routeSelections) throw cause
      throw new HTTPException(400, {
        message: cause instanceof Error ? cause.message : 'Could not load this comparison.',
        cause,
      })
    })
    const changeId = routeSelections ? undefined : await changeReviewId(cwd, diffSource)
    const { patch, fileHashes } = diff
    const reviewHashes = changeId ? changeFileHashes(patch, changeId) : undefined
    const files = Object.keys(fileHashes)
    const [viewed, generated, commentSyntaxes] = await Promise.all([
      loadViewed(cwd, reviewHashes ?? fileHashes),
      getGeneratedFiles(cwd, files),
      commentsEnabled ? getCommentSyntaxes(cwd, files) : {},
    ])
    return c.json({
      patch,
      revset: displayCommand(diffSource),
      comparison: currentComparison(diffSource),
      changeListAvailable: !!reviewRange(diffSource),
      repo: basename(cwd),
      vcs: diffSource.vcs,
      interdiff: !!diffSource.interdiff,
      commentsEnabled,
      expandable: diffSource.endpoints !== null,
      fileHashes,
      reviewHashes,
      patchHash: patchHash(patch),
      poll,
      send: !!send,
      tabSize,
      viewed,
      commentSyntaxes,
      generated,
    } satisfies DiffResponse)
  })

  app.get('/api/range-changes', async (c) =>
    c.json(await rangeReviewProgress(cwd, diffSource)),
  )

  // Polled every few seconds while the page is visible. Requests that arrive
  // while a diff is running share its result rather than starting another, so
  // several tabs, or a diff slower than the interval, never pile up. /api/diff
  // doesn't share: it follows the page's own edits (a comment), and a poll
  // that started before the edit would hand back the old patch. For the same
  // reason, an edit stops later polls from sharing a diff already running.
  let hashInFlight: Promise<string> | null = null
  app.get('/api/diff-hash', async (c) => {
    if (!poll)
      return c.json({ error: 'polling is off (--no-poll)' } satisfies ErrorResponse, 404)
    if (!hashInFlight) {
      const run = runDiff()
        .then(({ patch }) => patchHash(patch))
        .finally(() => {
          if (hashInFlight === run) hashInFlight = null
        })
      hashInFlight = run
    }
    return c.json({ hash: await hashInFlight } satisfies DiffHashResponse)
  })

  app.get('/api/file-contents', zValidator('query', fileContentsQuerySchema), async (c) => {
    const { path, oldPath } = c.req.valid('query')
    await requireInDiff(path)
    if (oldPath) await requireInDiff(oldPath)
    const contents = await getFileContents(diffSource, cwd, path, oldPath)
    return c.json(contents satisfies FileContentsResponse)
  })

  app.get('/api/difftastic', zValidator('query', difftasticQuerySchema), async (c) => {
    const { path, oldPath, full } = c.req.valid('query')
    if (!diffSource.endpoints) {
      throw new HTTPException(422, { message: 'Difftastic needs two file revisions.' })
    }
    await requireInDiff(path)
    if (oldPath) await requireInDiff(oldPath)
    const contents = await getFileContents(diffSource, cwd, path, oldPath)
    if (contents.oldContents === null && contents.newContents === null) {
      throw new HTTPException(422, {
        message: 'Could not read either version of the file.',
      })
    }
    if (contents.oldContents?.includes('\0') || contents.newContents?.includes('\0')) {
      throw new HTTPException(422, { message: 'Difftastic previews require text files.' })
    }
    try {
      const presentation = await (difftasticSettings ??= difftasticPresentation(
        cwd,
        diffSource.vcs === 'jj',
      ))
      return c.json(
        await renderDifftastic(
          path,
          contents,
          c.req.raw.signal,
          full === '1',
          presentation,
        ),
      )
    } catch (cause) {
      if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
        throw new HTTPException(503, {
          message: 'Difftastic (difft) was not found on the server PATH.',
          cause,
        })
      }
      throw new HTTPException(502, {
        message: 'Difftastic could not complete this comparison.',
        cause,
      })
    }
  })

  app.post('/api/viewed', zValidator('json', viewedRequestSchema), async (c) => {
    const { file, hash } = c.req.valid('json')
    await markViewed(cwd, file, hash)
    return c.json({ ok: true } satisfies OkResponse)
  })

  app.delete('/api/viewed', zValidator('json', viewedDeleteSchema), async (c) => {
    const { file, hash } = c.req.valid('json')
    await unmarkViewed(cwd, file, hash)
    return c.json({ ok: true } satisfies OkResponse)
  })

  app.delete('/api/viewed-all', zValidator('json', viewedDeleteAllSchema), async (c) => {
    const { files } = c.req.valid('json')
    await unmarkViewedAll(cwd, files)
    return c.json({ ok: true } satisfies OkResponse)
  })

  app.post('/api/comment', zValidator('json', commentRequestSchema), async (c) => {
    if (!commentsEnabled)
      throw new HTTPException(403, { message: 'Comments require the working copy.' })
    const { file, afterLine, lineText, text, lineCount, quote, contentHash } =
      c.req.valid('json')
    await requireInDiff(file)
    await insertComment(cwd, file, afterLine, lineText, text, lineCount, quote, contentHash)
    hashInFlight = null
    return c.json({ ok: true } satisfies OkResponse)
  })

  // Calls `send`, which for the CLI runs a command, so only the page may call
  // it (see gate.ts). Sends run one at a time in arrival order, so two quick
  // ones can't reach the far end swapped.
  let sendQueue: Promise<SendResult> = Promise.resolve({ ok: true, output: '' })
  if (send) {
    app.post(
      '/api/send',
      async (c, next) => {
        const headers = {
          host: c.req.header('host'),
          origin: c.req.header('origin'),
        }
        if (guard && !sendGate(headers))
          return c.json({ error: 'forbidden' } satisfies ErrorResponse, 403)
        await next()
      },
      zValidator('json', sendRequestSchema),
      async (c) => {
        // The blob comes from the page with the lines and excerpt, so all
        // three describe the version on screen even if the file has changed
        // since. Nothing here awaits, so sends join the queue as they arrive.
        const payload = buildPayload(diffSource, cwd, c.req.valid('json'))
        const run = () => send(payload)
        const result = sendQueue.then(run, run)
        sendQueue = result
        const r = await result
        if (!r.ok) return c.json({ error: r.error } satisfies ErrorResponse, 502)
        return c.json({ ok: true } satisfies OkResponse)
      },
    )
  }

  app.delete('/api/comment', zValidator('json', commentDeleteSchema), async (c) => {
    if (!commentsEnabled)
      throw new HTTPException(403, { message: 'Comments require the working copy.' })
    const { file, line } = c.req.valid('json')
    await requireInDiff(file)
    await removeComment(cwd, file, line)
    hashInFlight = null
    return c.json({ ok: true } satisfies OkResponse)
  })

  app.get('/api/theme', async (c) => {
    return c.json({ theme: await loadTheme() } satisfies ThemeResponse)
  })

  // Loaded by a render-blocking <script> in index.html (see themeBootScript).
  // no-store: a cached copy would re-apply an old preference before React
  // corrects it, flashing the wrong theme — the exact problem this solves.
  app.get('/api/theme.js', async (c) => {
    c.header('Cache-Control', 'no-store')
    c.header('Content-Type', 'text/javascript')
    return c.body(themeBootScript(await loadTheme()))
  })

  app.post('/api/theme', zValidator('json', themeRequestSchema), async (c) => {
    await saveTheme(c.req.valid('json').theme)
    return c.json({ ok: true } satisfies OkResponse)
  })

  // Keep this path valid from source (`server/`) and from the published
  // bundles (`dist/cli.js`, `dist/lib.js`): all are one directory below the
  // package root.
  const distDir = join(import.meta.dirname, '..', 'dist', 'web')

  // No fallback to index.html for other paths: the page's URLs are relative,
  // so it would load nothing from below the root.
  app.use('*', serveStatic({ root: distDir }))

  app.onError((err, c) => {
    const status = err instanceof HTTPException ? err.status : 500
    return c.json({ error: err.message } satisfies ErrorResponse, status)
  })

  return { fetch: app.fetch, token }
}
