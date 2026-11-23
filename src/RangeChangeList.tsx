/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 * Copyright Oxide Computer Company
 */

import { useQuery } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { REVIEW_REVISION_PARAMS } from '../shared/types.ts'
import type { ChangeReviewProgress, RangeReviewProgress } from '../shared/types.ts'
import { navigateReview } from './RevisionPicker.tsx'

const [changeParam] = REVIEW_REVISION_PARAMS

export function RangeChangeList({
  available = false,
  fetchProgress,
}: {
  available?: boolean
  fetchProgress: (
    selection: URLSearchParams,
    signal: AbortSignal,
  ) => Promise<RangeReviewProgress>
}) {
  const history = window.history.state as {
    rangeSearch?: string
    rangeLabels?: unknown
    revisionLabels?: unknown
  } | null
  const rangeSearch =
    history?.rangeSearch ?? (available ? window.location.search : undefined)
  const active = new URLSearchParams(window.location.search).get(changeParam)
  const [open, setOpen] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const progress = useQuery({
    queryKey: ['range-changes', rangeSearch],
    queryFn: ({ signal }) => fetchProgress(new URLSearchParams(rangeSearch), signal),
    enabled: open && rangeSearch !== undefined,
    retry: false,
  })
  if (rangeSearch === undefined) return null
  const changes = [...(progress.data?.fromOnly ?? []), ...(progress.data?.toOnly ?? [])]
  const complete = changes.filter((change) => change.viewed === change.files).length
  const rangeLabels =
    history?.rangeSearch === undefined ? history?.revisionLabels : history.rangeLabels
  function openChange(change: ChangeReviewProgress) {
    const url = new URL(window.location.href)
    for (const key of REVIEW_REVISION_PARAMS) url.searchParams.delete(key)
    const revision = change.workingCopy ? '@' : change.commit
    url.searchParams.set(changeParam, revision)
    dialog.current?.close()
    navigateReview(url, {
      rangeSearch,
      rangeLabels,
      revisionLabels: {
        [revision]: { name: change.change.slice(0, 8), description: change.description },
      },
    })
  }
  function returnToComparison() {
    const url = new URL(window.location.href)
    url.search = rangeSearch ?? ''
    dialog.current?.close()
    navigateReview(url, { revisionLabels: rangeLabels })
  }
  function renderChanges(rows: ChangeReviewProgress[], heading?: string) {
    if (!rows.length) return null
    return (
      <section className="range-change-group">
        {heading && <h3>{heading}</h3>}
        <ol>
          {rows.map((change) => (
            <li key={change.commit}>
              <button
                type="button"
                className="range-change-row"
                aria-current={
                  active === (change.workingCopy ? '@' : change.commit) ? 'true' : undefined
                }
                onClick={() => openChange(change)}
              >
                <code>{change.workingCopy ? '@' : change.change.slice(0, 8)}</code>
                <span className="range-change-title">
                  {change.description ||
                    (change.workingCopy ? 'Working copy' : '(no description)')}
                </span>
                {change.files === 0 ? (
                  <span className="range-file-count">No files</span>
                ) : (
                  <span className="range-file-count">
                    {change.viewed}/{change.files} files
                  </span>
                )}
                {change.viewed === change.files && (
                  <span className="range-change-viewed">✓ Viewed</span>
                )}
              </button>
            </li>
          ))}
        </ol>
      </section>
    )
  }
  return (
    <>
      <button
        type="button"
        className="difftastic-button range-changes-trigger"
        aria-haspopup="dialog"
        aria-label="Changes"
        onClick={() => {
          setOpen(true)
          dialog.current?.showModal()
        }}
      >
        Changes{' '}
        {changes.length > 0 && (
          <span aria-hidden="true">
            {complete}/{changes.length}
          </span>
        )}
      </button>
      <dialog
        className="revision-picker range-changes"
        aria-labelledby="range-changes-heading"
        ref={dialog}
        onClose={() => setOpen(false)}
      >
        <header className="revision-heading">
          <h2 id="range-changes-heading">Changes in range</h2>
          <div className="revision-heading-actions">
            {history?.rangeSearch !== undefined && (
              <button type="button" onClick={returnToComparison}>
                Back to comparison
              </button>
            )}
            <button
              type="button"
              className="revision-quiet revision-icon"
              aria-label="Close changes"
              onClick={() => dialog.current?.close()}
            >
              ×
            </button>
          </div>
        </header>
        <div className="range-change-body">
          {progress.isPending && <p role="status">Loading changes…</p>}
          {progress.isError && <p role="alert">{progress.error.message}</p>}
          {progress.data && (
            <>
              <p role="status">
                {complete} of {changes.length} changes viewed
              </p>
              {changes.length === 0 && <p>No changes are unique to either revision.</p>}
              {renderChanges(progress.data.fromOnly, 'Only in From')}
              {renderChanges(
                progress.data.toOnly,
                progress.data.fromOnly.length ? 'Only in To' : undefined,
              )}
            </>
          )}
        </div>
      </dialog>
    </>
  )
}
