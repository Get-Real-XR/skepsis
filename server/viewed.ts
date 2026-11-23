/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

/**
 * Viewed state: tracks which files the user has marked as viewed.
 *
 * Content-addressed: when a file is marked viewed, we store the git blob
 * object ID of the new file version (from the patch's index line). This is
 * a hash of the full file content, not the diff. To check if a file is
 * still viewed, we compare its current blob ID against stored ones. If the
 * file changes (rebase, amend, new commit), the ID won't match and the
 * file automatically appears unreviewed — no invalidation logic.
 *
 * A file can have multiple stored hashes, so marking a file viewed in one
 * revset doesn't interfere with a different revset that touches the same
 * file with different content. Both are remembered independently.
 *
 * Storage is a flat TSV file per repo at:
 *   ~/.local/share/skepsis/<cwd-hash>.viewed
 *
 * Each line is: file\thash\ttimestamp
 *
 * Entries older than 30 days are pruned on load.
 */

import { join } from 'path'
import { createHash, randomUUID } from 'crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import type { ViewedMap } from '../shared/types.ts'

const BASE_DIR = join(process.env['HOME'] ?? '~', '.local', 'share', 'skepsis')
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const pendingWrites = new Map<string, Promise<void>>()

interface Entry {
  hash: string
  timestamp: number
}

function viewedPath(cwd: string): string {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12)
  return join(BASE_DIR, `${hash}.viewed`)
}

// Format: file\thash\ttimestamp
async function loadAll(cwd: string): Promise<Map<string, Entry[]>> {
  const map = new Map<string, Entry[]>()
  const cutoff = Date.now() - MAX_AGE_MS
  try {
    const raw = await readFile(viewedPath(cwd), 'utf-8')
    for (const line of raw.split('\n')) {
      if (!line) continue
      const parts = line.split('\t')
      if (parts.length < 2) continue
      const file = parts[0]!
      const hash = parts[1]!
      const timestamp = parts[2] ? Number(parts[2]) : 0
      if (timestamp < cutoff) continue
      if (!map.has(file)) map.set(file, [])
      map.get(file)!.push({ hash, timestamp })
    }
  } catch {
    // file doesn't exist yet
  }
  return map
}

async function saveAll(cwd: string, map: Map<string, Entry[]>): Promise<void> {
  await mkdir(BASE_DIR, { recursive: true })
  const lines: string[] = []
  for (const [file, entries] of map) {
    for (const { hash, timestamp } of entries) {
      lines.push(`${file}\t${hash}\t${timestamp}`)
    }
  }
  const path = viewedPath(cwd)
  const temp = path + '.' + randomUUID()
  try {
    await writeFile(temp, lines.join('\n') + '\n')
    await rename(temp, path)
  } finally {
    await unlink(temp).catch(() => {})
  }
}

/**
 * Load viewed state as a ViewedMap for the current diff.
 * A file is "viewed" if its current content hash is in the stored set.
 * Returns { [file]: hash } for files whose hash matches.
 */
export async function loadViewed(
  cwd: string,
  fileHashes: Record<string, string>,
): Promise<ViewedMap> {
  await pendingWrites.get(cwd)?.catch(() => {})
  const all = await loadAll(cwd)
  return matchViewed(all, fileHashes)
}

function matchViewed(all: Map<string, Entry[]>, fileHashes: ViewedMap): ViewedMap {
  const viewed: ViewedMap = {}
  for (const [file, hash] of Object.entries(fileHashes)) {
    if (all.get(file)?.some((e) => e.hash === hash)) {
      viewed[file] = hash
    }
  }
  return viewed
}

export async function countViewed(
  cwd: string,
  filesByChange: ViewedMap[],
): Promise<number[]> {
  await pendingWrites.get(cwd)?.catch(() => {})
  const all = await loadAll(cwd)
  return filesByChange.map((files) => Object.keys(matchViewed(all, files)).length)
}

function updateViewed(
  cwd: string,
  update: (all: Map<string, Entry[]>) => void,
): Promise<void> {
  const previous = pendingWrites.get(cwd) ?? Promise.resolve()
  const write = previous
    .catch(() => {})
    .then(async () => {
      const all = await loadAll(cwd)
      update(all)
      await saveAll(cwd, all)
    })
  pendingWrites.set(cwd, write)
  return write.finally(() => {
    if (pendingWrites.get(cwd) === write) pendingWrites.delete(cwd)
  })
}

export function markViewed(cwd: string, file: string, hash: string): Promise<void> {
  return updateViewed(cwd, (all) => {
    const entries = all.get(file) ?? []
    const existing = entries.find((e) => e.hash === hash)
    if (existing) {
      existing.timestamp = Date.now()
    } else {
      entries.push({ hash, timestamp: Date.now() })
      all.set(file, entries)
    }
  })
}

export async function unmarkViewed(cwd: string, file: string, hash: string): Promise<void> {
  await unmarkViewedAll(cwd, [{ file, hash }])
}

/** Unmark several files in one read-modify-write pass so concurrent
 *  per-file deletes can't clobber each other's saves. */
export function unmarkViewedAll(
  cwd: string,
  files: { file: string; hash: string }[],
): Promise<void> {
  return updateViewed(cwd, (all) => {
    for (const { file, hash } of files) {
      const entries = all.get(file)
      if (!entries) continue
      const filtered = entries.filter((e) => e.hash !== hash)
      if (filtered.length === 0) all.delete(file)
      else all.set(file, filtered)
    }
  })
}
