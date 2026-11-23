/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { useQuery } from '@tanstack/react-query'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { REVIEW_REVISION_PARAMS } from '../shared/types.ts'
import type { RevisionComparison, RevisionGraph, RevisionNode } from '../shared/types.ts'

const [changeParam, fromParam, toParam] = REVIEW_REVISION_PARAMS
const rowHeight = 40
const laneWidth = 16
const reviewChange = 'skepsis:review-change'
type Endpoint = 'From' | 'To'
type RevisionLabel = { name: string; description?: string }
type ReviewMode = 'change' | 'comparison'
type ReviewSelection = { change: string } | RevisionComparison | null

export function reviewLocationKey() {
  const params = new URLSearchParams(window.location.search)
  return JSON.stringify(REVIEW_REVISION_PARAMS.map((key) => params.get(key)))
}

export function subscribeToReviewLocation(update: () => void) {
  window.addEventListener('popstate', update)
  window.addEventListener(reviewChange, update)
  return () => {
    window.removeEventListener('popstate', update)
    window.removeEventListener(reviewChange, update)
  }
}

export function navigateReview(url: URL, state: object) {
  if (url.href === window.location.href) return
  window.history.pushState(state, '', url)
  window.dispatchEvent(new Event(reviewChange))
}

function layout(nodes: RevisionNode[]) {
  const shown = new Set(nodes.map((node) => node.commit))
  const lanes: (string | undefined)[] = []
  let width = 1
  const rows = nodes.map((node) => {
    let column = lanes.indexOf(node.commit)
    const incoming = column >= 0
    if (!incoming) column = lanes.indexOf(undefined)
    if (column < 0) column = lanes.length
    const through = lanes.flatMap((id, index) => (id && index !== column ? [index] : []))
    lanes[column] = undefined
    const parents: number[] = []
    for (const parent of node.parents) {
      if (!shown.has(parent)) continue
      let target = lanes.indexOf(parent)
      if (target < 0) {
        target = parents.length === 0 ? column : lanes.indexOf(undefined)
        if (target < 0) target = lanes.length
        lanes[target] = parent
      }
      parents.push(target)
    }
    width = Math.max(width, lanes.length)
    return {
      node,
      column,
      incoming,
      through,
      parents,
      boundary: parents.length < node.parents.length,
    }
  })
  return { rows, width: width * laneWidth + 8 }
}

function revisionOf(node: RevisionNode) {
  return node.workingCopy ? '@' : node.commit
}

function matchesRevision(node: RevisionNode, revision: string) {
  return (
    revision === node.commit ||
    (revision === '@' && node.workingCopy) ||
    node.bookmarks.includes(revision)
  )
}

export function RevisionPicker({
  fetchGraph,
  comparison,
  command,
}: {
  fetchGraph: (revset: string) => Promise<RevisionGraph>
  comparison?: RevisionComparison
  command?: string
}) {
  const initial = new URLSearchParams(window.location.search)
  const currentChange = initial.get(changeParam)
  const active =
    comparison ??
    (initial.has(fromParam) && initial.has(toParam)
      ? { from: initial.get(fromParam)!, to: initial.get(toParam)! }
      : undefined)
  const knownLabels = (
    window.history.state as { revisionLabels?: Record<string, RevisionLabel> } | null
  )?.revisionLabels
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<ReviewMode>(active ? 'comparison' : 'change')
  const [customRange, setCustomRange] = useState(!!active && active.to !== '@')
  const [filter, setFilter] = useState(initial.get('graphRevset') ?? '')
  const [revset, setRevset] = useState(filter)
  const [from, setFrom] = useState(active?.from ?? '')
  const [to, setTo] = useState(active?.to ?? currentChange ?? '@')
  const [picking, setPicking] = useState<Endpoint>('From')
  const dialog = useRef<HTMLDialogElement>(null)
  const activeEndpoint = useRef<HTMLButtonElement>(null)
  const singleMode = useRef<HTMLButtonElement>(null)
  const compareMode = useRef<HTMLButtonElement>(null)
  const comparing = mode === 'comparison'
  const quickComparison = comparing && !customRange
  useLayoutEffect(() => {
    if (open)
      (quickComparison
        ? compareMode
        : comparing
          ? activeEndpoint
          : singleMode
      ).current?.focus()
  }, [open, picking, comparing, quickComparison])
  const graph = useQuery({
    queryKey: ['revisions', revset],
    queryFn: () => fetchGraph(revset),
    enabled: open,
    retry: false,
  })
  const positioned = useMemo(() => layout(graph.data?.nodes ?? []), [graph.data])
  const comparable =
    from !== '' &&
    to !== '' &&
    from !== to &&
    !graph.data?.nodes.some(
      (node) => matchesRevision(node, from) && matchesRevision(node, to),
    )
  const label = (revision: string): RevisionLabel => {
    if (revision === '@') return { name: '@', description: 'Working copy' }
    const node = graph.data?.nodes.find((row) => matchesRevision(row, revision))
    if (node) {
      return {
        name: node.bookmarks.includes(revision) ? revision : node.change.slice(0, 8),
        description: node.description,
      }
    }
    return (
      knownLabels?.[revision] ?? {
        name:
          revision === 'fork_point(trunk() | @)'
            ? 'Fork point'
            : /^[a-f0-9]{40}$/.test(revision)
              ? revision.slice(0, 8)
              : revision,
      }
    )
  }
  function review(selection: ReviewSelection) {
    const url = new URL(window.location.href)
    for (const key of REVIEW_REVISION_PARAMS) url.searchParams.delete(key)
    const entries: [string, string][] = !selection
      ? []
      : 'change' in selection
        ? [[changeParam, selection.change]]
        : [
            [fromParam, selection.from],
            [toParam, selection.to],
          ]
    for (const [key, value] of entries) url.searchParams.set(key, value)
    if (revset) url.searchParams.set('graphRevset', revset)
    else url.searchParams.delete('graphRevset')
    dialog.current?.close()
    const revisionLabels = Object.fromEntries(
      entries.map(([, revision]) => [revision, label(revision)]),
    )
    navigateReview(url, { revisionLabels })
  }
  function endpointButton(side: Endpoint, revision: string) {
    const detail = revision ? label(revision) : undefined
    return (
      <button
        type="button"
        ref={side === picking ? activeEndpoint : undefined}
        className="revision-endpoint"
        data-side={side.toLowerCase()}
        aria-pressed={picking === side}
        aria-label={`Choose ${side}${detail ? ': ' + detail.name : ''}`}
        title={detail?.description || revision || undefined}
        onClick={() => setPicking(side)}
      >
        <span className="revision-endpoint-side">{side}</span>
        {detail ? (
          <span className="revision-endpoint-value">
            <code>{detail.name}</code>
            {detail.description && <span>{detail.description}</span>}
          </span>
        ) : (
          <span className="revision-endpoint-empty">Select a revision</span>
        )}
      </button>
    )
  }
  function openPicker(side?: Endpoint) {
    setMode(side || active ? 'comparison' : 'change')
    setCustomRange(side === 'To' || (!!active && active.to !== '@'))
    if (side) setPicking(side)
    setOpen(true)
    dialog.current?.showModal()
  }
  function endpointTrigger(side: Endpoint, revision: string) {
    const name = label(revision).name
    return (
      <button
        type="button"
        className="revision-trigger-endpoint"
        aria-haspopup="dialog"
        aria-label={`Change ${side}: ${name}`}
        title={`Change ${side}: ${name}`}
        onClick={() => openPicker(side)}
      >
        <code>{name}</code>
      </button>
    )
  }
  return (
    <>
      {active ? (
        <div
          className="revision-trigger-group"
          role="group"
          aria-label="Current comparison"
        >
          {endpointTrigger('From', active.from)}
          <span className="revision-trigger-arrow" aria-hidden="true">
            →
          </span>
          {endpointTrigger('To', active.to)}
          <button
            type="button"
            className="revision-trigger-menu"
            aria-label="Revisions"
            aria-haspopup="dialog"
            title={command}
            onClick={() => openPicker()}
          >
            <span aria-hidden="true" className="revision-chevron">
              ⌄
            </span>
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="difftastic-button revision-trigger"
          aria-label="Revisions"
          aria-haspopup="dialog"
          title={command}
          onClick={() => openPicker()}
        >
          {currentChange ? <code>{label(currentChange).name}</code> : 'Revisions'}
          <span aria-hidden="true" className="revision-chevron">
            ⌄
          </span>
        </button>
      )}
      <dialog
        className="revision-picker"
        ref={dialog}
        onClose={(event) => {
          if (!event.currentTarget.open) setOpen(false)
        }}
        aria-labelledby="revision-heading"
      >
        <header className="revision-heading">
          <h2 id="revision-heading">Revisions</h2>
          <div className="revision-heading-actions">
            {REVIEW_REVISION_PARAMS.some((key) => initial.has(key)) && (
              <button type="button" className="revision-quiet" onClick={() => review(null)}>
                Reset diff
              </button>
            )}
            <button
              type="button"
              className="revision-quiet revision-icon"
              aria-label="Close revisions"
              onClick={() => dialog.current?.close()}
            >
              ×
            </button>
          </div>
        </header>
        <div className="revision-mode">
          <div className="revision-mode-controls" role="group" aria-label="Review mode">
            <button
              type="button"
              ref={singleMode}
              aria-pressed={!comparing}
              onClick={() => setMode('change')}
            >
              Single change
            </button>
            <button
              type="button"
              ref={compareMode}
              aria-pressed={comparing}
              onClick={() => setMode('comparison')}
            >
              Compare revisions
            </button>
          </div>
          {comparing && (
            <button
              type="button"
              className="revision-quiet revision-range-mode"
              onClick={() => setCustomRange(!customRange)}
            >
              {quickComparison ? 'Custom range' : 'Compare to working copy'}
            </button>
          )}
        </div>
        {quickComparison && (
          <p className="revision-quick-note">
            Pick a base to compare with the working copy <code>@</code>.
          </p>
        )}
        {comparing && customRange && (
          <div
            className="revision-endpoints"
            role="group"
            aria-label="Comparison endpoints"
          >
            {endpointButton('From', from)}
            <button
              type="button"
              className="revision-swap"
              aria-label="Swap From and To"
              title="Swap From and To"
              disabled={!comparable}
              onClick={() => {
                setFrom(to)
                setTo(from)
              }}
            >
              ⇄
            </button>
            {endpointButton('To', to)}
            <button
              type="button"
              className="revision-compare"
              disabled={!comparable}
              onClick={() => review({ from, to })}
            >
              Show diff
            </button>
          </div>
        )}
        <form
          className="revision-filter"
          onSubmit={(event) => {
            event.preventDefault()
            setRevset(filter.trim())
          }}
        >
          <label htmlFor="graph-revset">Revset</label>
          <input
            id="graph-revset"
            value={filter}
            placeholder={graph.data?.revset ?? 'ancestors(@, 40)'}
            onChange={(event) => setFilter(event.target.value)}
          />
          <button type="submit">Apply</button>
        </form>
        <div className="revision-graph-heading" aria-hidden="true">
          {quickComparison
            ? 'Select a base revision'
            : comparing
              ? `Select the ${picking} revision`
              : 'Select a change to open its diff'}
        </div>
        <div className="revision-rows">
          {graph.isFetching && !graph.data && <p>Loading revisions…</p>}
          {graph.error && (
            <p role="alert" className="revision-error">
              {graph.error.message}
            </p>
          )}
          {graph.data?.nodes.length === 0 && <p>No revisions match this filter.</p>}
          {positioned.rows.map(({ node, column, incoming, through, parents, boundary }) => {
            const revision = revisionOf(node)
            const isFrom = comparing && matchesRevision(node, from)
            const isTo = comparing && matchesRevision(node, quickComparison ? '@' : to)
            const description = node.description || node.bookmarks[0]
            const title = node.workingCopy
              ? description
                ? `${description} (working copy)`
                : 'Working copy'
              : description || node.change.slice(0, 8)
            const x = (lane: number) => lane * laneWidth + 10
            const middle = rowHeight / 2
            return (
              <div
                className="revision-row"
                data-from={isFrom || undefined}
                data-to={isTo || undefined}
                key={node.commit}
              >
                <svg
                  width={positioned.width}
                  height={rowHeight}
                  className="revision-dag"
                  aria-hidden="true"
                  fill="none"
                  viewBox={`0 0 ${positioned.width} ${rowHeight}`}
                >
                  {through.map((lane) => (
                    <path key={lane} d={`M ${x(lane)},0 V ${rowHeight}`} />
                  ))}
                  {incoming && <path d={`M ${x(column)},0 V ${middle}`} />}
                  {parents.map((lane) => (
                    <path
                      key={lane}
                      d={`M ${x(column)},${middle} Q ${x(lane)},${middle + 5} ${x(lane)},${rowHeight}`}
                    />
                  ))}
                  {boundary && (
                    <path
                      className="revision-boundary"
                      d={`M ${x(column)},${middle} V ${rowHeight}`}
                    />
                  )}
                  <circle
                    className={node.workingCopy ? 'revision-working-dot' : 'revision-dot'}
                    cx={x(column)}
                    cy={middle}
                    r={4}
                  />
                </svg>
                <button
                  type="button"
                  className="revision-change"
                  aria-label={
                    quickComparison
                      ? `Compare from ${title} to working copy`
                      : comparing
                        ? `Set ${picking} to ${title}`
                        : `View change ${title}`
                  }
                  aria-pressed={
                    comparing && customRange
                      ? picking === 'From'
                        ? isFrom
                        : isTo
                      : undefined
                  }
                  aria-current={
                    !comparing && currentChange === revision ? 'true' : undefined
                  }
                  title={title}
                  disabled={quickComparison && node.workingCopy}
                  onClick={() => {
                    if (!comparing) review({ change: revision })
                    else if (quickComparison) review({ from: revision, to: '@' })
                    else if (picking === 'From') setFrom(revision)
                    else setTo(revision)
                  }}
                >
                  <code>{node.workingCopy ? '@' : node.change.slice(0, 8)}</code>
                  <span>
                    {node.description ||
                      (node.workingCopy ? 'Working copy' : '(no description)')}
                  </span>
                </button>
                {node.bookmarks[0] && (
                  <span className="revision-bookmark" title={node.bookmarks.join(', ')}>
                    {node.bookmarks[0]}
                  </span>
                )}
                {(isFrom || isTo) && (
                  <div className="revision-badges">
                    {isFrom && (
                      <span className="revision-badge" data-side="from">
                        From
                      </span>
                    )}
                    {isTo && (
                      <span className="revision-badge" data-side="to">
                        To
                      </span>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          {graph.data?.truncated && (
            <p>Showing the first 160 revisions. Narrow the revset to see more.</p>
          )}
        </div>
      </dialog>
    </>
  )
}
