/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type {
  DifftasticLine,
  DifftasticResponse,
  FileContentsResponse,
} from '../shared/types.ts'

const run = promisify(execFile)
type Display = 'inline' | 'side-by-side' | 'side-by-side-show-both'
type Presentation = { display: Display; context: number; tabWidth: number }

function argument(args: string[], name: string, short?: string) {
  const index = args.findLastIndex(
    (arg) => arg === name || arg === short || arg.startsWith(name + '='),
  )
  return index < 0 ? undefined : (args[index]?.split('=').at(1) ?? args[index + 1])
}

function sizeOption(raw: string | undefined, fallback: number) {
  return raw && /^\d+$/.test(raw) && Number(raw) <= 0xffffffff ? Number(raw) : fallback
}

export async function difftasticPresentation(
  cwd: string,
  jj: boolean,
): Promise<Presentation> {
  let args: string[] = []
  if (jj) {
    try {
      const options = { cwd, timeout: 2000, maxBuffer: 16 * 1024 }
      const { stdout } = await run('jj', ['config', 'get', 'ui.diff-formatter'], options)
      const formatter = stdout.trim()
      if (formatter.startsWith('[')) {
        const [program, ...flags] = z.array(z.string()).parse(JSON.parse(formatter))
        if (program && basename(program) === 'difft') args = flags
      } else if (/^(difft|difftastic)$/.test(formatter)) {
        const { stdout: flags } = await run(
          'jj',
          ['config', 'get', `merge-tools.${formatter}.diff-args`],
          options,
        )
        args = z.array(z.string()).parse(JSON.parse(flags))
      }
    } catch {
      // The structural preview can also run without a Jujutsu formatter.
    }
  }
  const mode = argument(args, '--display') ?? process.env['DFT_DISPLAY']
  return {
    display: mode === 'inline' || mode === 'side-by-side-show-both' ? mode : 'side-by-side',
    context: sizeOption(argument(args, '--context', '-c') ?? process.env['DFT_CONTEXT'], 3),
    tabWidth: sizeOption(argument(args, '--tab-width') ?? process.env['DFT_TAB_WIDTH'], 4),
  }
}

const lineIndex = z.number().int().nonnegative()
const change = z.object({ start: lineIndex, end: lineIndex, content: z.string() })
const lineSide = z.object({ line_number: lineIndex, changes: z.array(change) })
const schema = z.object({
  language: z.string(),
  status: z.enum(['changed', 'unchanged', 'created', 'deleted']),
  aligned_lines: z.array(z.tuple([lineIndex.nullable(), lineIndex.nullable()])).optional(),
  chunks: z
    .array(z.array(z.object({ lhs: lineSide.optional(), rhs: lineSide.optional() })))
    .optional(),
})
type TokenChange = z.infer<typeof change>

function sourceLines(contents: string | null): string[] {
  if (!contents) return []
  const lines = contents.split('\n')
  if (contents.endsWith('\n')) lines.pop()
  return lines.map((line) => line.replace(/\r$/, ''))
}

function fullLineChange(text: string): DifftasticLine['changes'] {
  return text ? [{ start: 0, end: text.length }] : []
}

/** Difftastic reports UTF-8 byte offsets. Convert once per line, checking the
 * token against the original text before highlighting it. */
function changeOffsets(text: string, changes: TokenChange[]): DifftasticLine['changes'] {
  if (!changes.length) return []
  const bytes = Buffer.from(text)
  const offsets: DifftasticLine['changes'] = []
  let byteOffset = 0
  let stringOffset = 0
  for (const { start, end, content } of changes.toSorted((a, b) => a.start - b.start)) {
    if (
      start < byteOffset ||
      end <= start ||
      end > bytes.length ||
      bytes.subarray(start, end).toString() !== content
    )
      continue
    const begin = stringOffset + bytes.subarray(byteOffset, start).toString().length
    stringOffset = begin + content.length
    byteOffset = end
    offsets.push({ start: begin, end: stringOffset })
  }
  return offsets
}

function toResponse(
  result: z.infer<typeof schema>,
  { oldContents, newContents }: FileContentsResponse,
  full: boolean,
  presentation: Presentation,
): DifftasticResponse {
  const oldLines = sourceLines(oldContents)
  const newLines = sourceLines(newContents)
  const lhs = new Map<number, TokenChange[]>()
  const rhs = new Map<number, TokenChange[]>()
  for (const chunk of result.chunks ?? []) {
    for (const line of chunk) {
      if (line.lhs?.changes.length) lhs.set(line.lhs.line_number, line.lhs.changes)
      if (line.rhs?.changes.length) rhs.set(line.rhs.line_number, line.rhs.changes)
    }
  }

  const unchanged = result.status === 'unchanged'
  const aligned =
    result.aligned_lines ??
    (unchanged
      ? newLines.map<readonly [number | null, number]>((_, i) => [
          oldLines[i] === undefined ? null : i,
          i,
        ])
      : result.status === 'deleted'
        ? oldLines.map<readonly [number, null]>((_, i) => [i, null])
        : newLines.map<readonly [null, number]>((_, i) => [null, i]))
  const pairs = aligned.map(([left, right]) => {
    // Alignment can include a synthetic empty line after the final newline.
    const oldIndex = left !== null && oldLines[left] !== undefined ? left : null
    const newIndex = right !== null && newLines[right] !== undefined ? right : null
    const oldChanged = oldIndex !== null && (lhs.has(oldIndex) || newIndex === null)
    const newChanged =
      !unchanged && newIndex !== null && (rhs.has(newIndex) || oldIndex === null)
    return { oldIndex, newIndex, oldChanged, newChanged }
  })

  const sectionRanges: { start: number; end: number }[] = []
  const oldPositions = new Map<number, number>()
  const newPositions = new Map<number, number>()
  for (const [i, { oldIndex, newIndex }] of pairs.entries()) {
    if (oldIndex !== null) oldPositions.set(oldIndex, i)
    if (newIndex !== null) newPositions.set(newIndex, i)
  }
  if (result.status === 'created' || result.status === 'deleted') {
    sectionRanges.push({ start: 0, end: pairs.length })
  } else {
    for (const chunk of result.chunks ?? []) {
      let first = pairs.length
      let last = -1
      for (const line of chunk) {
        const i = line.lhs
          ? oldPositions.get(line.lhs.line_number)
          : newPositions.get(line.rhs?.line_number ?? -1)
        if (i === undefined) continue
        first = Math.min(first, i)
        last = Math.max(last, i)
      }
      if (last >= first) {
        sectionRanges.push({
          start: Math.max(0, first - presentation.context),
          end: Math.min(pairs.length, last + presentation.context + 1),
        })
      }
    }
  }

  const lines: DifftasticLine[] = []
  const sections: DifftasticResponse['sections'] = []
  const appendSection = (start: number, end: number) => {
    if (start >= end) return
    const section = pairs.slice(start, end)
    const hasOld = section.some((pair) => pair.oldChanged)
    const hasNew = section.some((pair) => pair.newChanged)
    let layout: DifftasticResponse['sections'][number]['layout']
    if (presentation.display === 'inline') layout = 'inline'
    else if (presentation.display === 'side-by-side-show-both' || (hasOld && hasNew))
      layout = 'split'
    else layout = hasOld ? 'old' : 'new'
    const rows = section.flatMap(({ oldIndex, newIndex, oldChanged, newChanged }) => {
      if (oldIndex === null && newIndex === null) return []
      // A multiline syntax token can mark identical aligned lines as novel.
      // Keep the alignment and layout, and render those lines as context.
      const sameText =
        oldIndex !== null && newIndex !== null && oldLines[oldIndex] === newLines[newIndex]
      const append = (index: number, side: DifftasticLine['side'], changed: boolean) => {
        const old = side === 'deletions'
        const text = (old ? oldLines : newLines)[index]!
        const whole = result.status === (old ? 'deleted' : 'created')
        const tokens = (old ? lhs : rhs).get(index) ?? []
        return (
          lines.push({
            kind: changed && !sameText ? (old ? 'deletion' : 'addition') : 'context',
            side,
            number: index + 1,
            text,
            changes: sameText
              ? []
              : whole
                ? fullLineChange(text)
                : changeOffsets(text, tokens),
          }) - 1
        )
      }
      return [
        {
          old:
            oldIndex !== null &&
            (layout === 'split' ||
              layout === 'old' ||
              (layout === 'inline' && ((oldChanged && !sameText) || newIndex === null)))
              ? append(oldIndex, 'deletions', oldChanged)
              : null,
          new:
            newIndex !== null && layout !== 'old'
              ? append(newIndex, 'additions', newChanged)
              : null,
        },
      ]
    })
    if (rows.length) sections.push({ layout, rows })
  }
  let end = 0
  let hasHiddenLines = false
  for (const range of sectionRanges) {
    if (full) appendSection(end, range.start)
    else if (end < range.start) hasHiddenLines = true
    appendSection(Math.max(end, range.start), range.end)
    end = Math.max(end, range.end)
  }
  if (full) appendSection(end, pairs.length)
  else if (
    pairs.slice(end).some((pair) => pair.oldIndex !== null || pair.newIndex !== null)
  )
    hasHiddenLines = true
  return {
    language: result.language,
    lines,
    sections,
    tabWidth: presentation.tabWidth,
    hasHiddenLines,
    unchanged,
    newContentHash:
      newContents === null ? null : createHash('sha256').update(newContents).digest('hex'),
  }
}

export async function renderDifftastic(
  path: string,
  contents: FileContentsResponse,
  signal: AbortSignal,
  full: boolean,
  presentation: Presentation,
): Promise<DifftasticResponse> {
  const scratch = await mkdtemp(join(tmpdir(), 'skepsis-difftastic-'))
  try {
    const name = basename(path)
    const paths = [join('old', name), join('new', name)]
    await Promise.all(['old', 'new'].map((side) => mkdir(join(scratch, side))))
    await Promise.all([
      writeFile(join(scratch, paths[0]!), contents.oldContents ?? ''),
      writeFile(join(scratch, paths[1]!), contents.newContents ?? ''),
    ])
    const { stdout } = await run(
      'difft',
      [
        '--display',
        'json',
        '--color',
        'never',
        '--context',
        String(presentation.context),
        '--',
        ...paths,
      ],
      {
        cwd: scratch,
        env: {
          ...process.env,
          DFT_UNSTABLE: 'yes',
          DFT_EXIT_CODE: 'false',
          DFT_SKIP_UNCHANGED: 'false',
        },
        timeout: 15_000,
        maxBuffer: 8 * 1024 * 1024,
        signal,
      },
    )
    return toResponse(schema.parse(JSON.parse(stdout)), contents, full, presentation)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
