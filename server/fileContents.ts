/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn } from 'node:child_process'
import { lstat, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { DiffArgs, FileContentsResponse } from '../shared/types.ts'

/**
 * Run a command and return stdout, or null if it exits nonzero. A nonzero exit
 * is the normal signal that a path does not exist at a given revision (an added
 * or deleted file), so it's not treated as an error.
 */
function tryRun(cmd: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd })
    const stdout: Buffer[] = []
    proc.stdout.on('data', (d) => stdout.push(d))
    proc.stderr.on('data', () => {})
    proc.on('error', reject)
    proc.on('close', (code) =>
      resolve(code === 0 ? Buffer.concat(stdout).toString() : null),
    )
  })
}

// Jujutsu exports the merged parent tree as the left side for external tools.
const READ_JJ_DIFF_BASE = `
  const fs = require('node:fs')
  const { join } = require('node:path')
  const file = join(process.argv[1], Buffer.from(process.argv[2], 'base64').toString())
  let contents = null
  try {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) contents = fs.readlinkSync(file)
    if (stat.isFile()) contents = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  process.stdout.write(JSON.stringify(contents))
`

/** Fetch a file's contents on the left side of the diff. */
async function fetchOld(
  src: DiffArgs,
  path: string,
  oldPath: string,
  cwd: string,
): Promise<string | null> {
  if (!src.endpoints) return null
  const { left, right } = src.endpoints
  if (src.vcs === 'git') return tryRun('git', ['show', `${left}:${oldPath}`], cwd)
  const contents = await tryRun('jj', ['file', 'show', '-r', left, '--', oldPath], cwd)
  if (
    contents !== null ||
    right === 'workingCopy' ||
    src.args[0] !== '-r' ||
    left !== `${right.rev}-`
  )
    return contents

  const parents = await tryRun(
    'jj',
    ['log', '--no-graph', '--limit=2', '-r', left, '-T', '"x"'],
    cwd,
  )
  if (parents !== 'xx') return null
  const tool = 'skepsis-file-contents'
  const prefix = `merge-tools.${tool}.`
  const args = ['-e', READ_JJ_DIFF_BASE, '$left', Buffer.from(oldPath).toString('base64')]
  const merged = await tryRun(
    'jj',
    [
      'diff',
      '-r',
      right.rev,
      '--tool',
      tool,
      '--config',
      prefix + 'program=' + JSON.stringify(process.execPath),
      '--config',
      prefix + 'diff-invocation-mode="dir"',
      '--config',
      prefix + 'diff-args=' + JSON.stringify(args),
      '--',
      ...[...new Set([path, oldPath])].map((name) => 'file:' + JSON.stringify(name)),
    ],
    cwd,
  )
  return merged?.length ? (JSON.parse(merged) as string | null) : null
}

/** Fetch a file's contents at the diff's right (new) endpoint. */
async function fetchNew(src: DiffArgs, path: string, cwd: string): Promise<string | null> {
  if (!src.endpoints) return null
  const { right } = src.endpoints
  if (right === 'workingCopy') {
    const abs = join(cwd, path)
    const stat = await lstat(abs).catch(() => null)
    if (stat?.isSymbolicLink()) {
      return readlink(abs).catch(() => null)
    }
    return readFile(abs, 'utf-8').catch(() => null)
  }
  return src.vcs === 'jj'
    ? tryRun('jj', ['file', 'show', '-r', right.rev, '--', path], cwd)
    : tryRun('git', ['show', `${right.rev}:${path}`], cwd)
}

/**
 * Full file contents at both diff endpoints, used by the client to build a
 * non-partial diff that supports hunk expansion. `oldPath` differs from `path`
 * for renamed files (the old-side path).
 */
export async function getFileContents(
  src: DiffArgs,
  cwd: string,
  path: string,
  oldPath?: string,
): Promise<FileContentsResponse> {
  const [oldContents, newContents] = await Promise.all([
    fetchOld(src, path, oldPath ?? path, cwd),
    fetchNew(src, path, cwd),
  ])
  return { oldContents, newContents }
}
