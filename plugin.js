/**
 * profile-gestures — Arc-style two-finger horizontal swipe over the sidebar
 * nav area switches the active Hermes profile.
 *
 * Runtime desktop plugin: plain ESM, loaded uncompiled, no build step,
 * hot-reloads on save. Only `@hermes/plugin-sdk` and `react` may be imported
 * (enforced by the host loader) — everything else here is inlined.
 *
 * UI is jsx()/jsxs() calls — JSX syntax will not parse on this no-build path.
 * Only Tailwind utilities core already ships are used (Tailwind never scans
 * this file, so a class name that appears only here compiles to nothing).
 * Codicons are sized with the `size` prop, never `text-[…]`.
 *
 * ---------------------------------------------------------------------------
 * Wheel-gesture phase detection (isStart/isEnding/isMomentum/
 * isMomentumCancel + axis movement projection) is a stdlib-only reimplementation
 * of the algorithm in **wheel-gestures** (MIT License, Felix Richter / xiel,
 * https://wheel-gestures.xiel.dev/docs/on-wheel,
 * https://github.com/xiel/wheel-gestures). Inlined because runtime plugins
 * cannot import third-party packages — see `unsupported import` in the host's
 * plugin loader. Original MIT license text:
 *
 *   MIT License
 *   Copyright (c) Felix Richter
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software and associated documentation files (the
 *   "Software"), to deal in the Software without restriction, including
 *   without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to
 *   permit persons to whom the Software is furnished to do so, subject to
 *   the following conditions: the above copyright notice and this permission
 *   notice shall be included in all copies or substantial portions of the
 *   Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 * ---------------------------------------------------------------------------
 */

import {
  host,
  haptic,
  PROFILE_SWATCHES,
  SIDEBAR_NAV_AREA,
  Skeleton
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef, useState } from 'react'

const ID = 'profile-gestures'
const PROFILE_ORDER_KEY = 'hermes.desktop.profileOrder'

/* ---------------------------------------------------------------------------
 * Debug logging — `host.logs` (checked against the SDK's exports) is a READ
 * API (`host.logs(params)` tails an app log FILE on disk; it has no write/
 * append surface a plugin could push lines into), so there is no SDK-exposed
 * channel to pipe runtime events into a Hermes log file. `console.log` is
 * therefore the right surface: it lands in the renderer's devtools console,
 * which is also where `host.logs`'s own 'desktop'/'gui' tail reads from for
 * this process. See manual verification steps in the PR description for
 * exactly how to open it.
 * ------------------------------------------------------------------------- */
const DEBUG = true

function log(...args) {
  if (!DEBUG) return
  console.log('[profile-gestures]', ...args)
}

log('module evaluated')

/* ---------------------------------------------------------------------------
 * Profile order — mirrors core's Nt()/It() in profile-D2NTN1hO.js exactly:
 *   sort non-default profiles by the saved hermes.desktop.profileOrder array
 *   (names absent from the array sort last, stable), then prepend `default`
 *   when a default profile exists. Wrap-around neighbour pick uses modulo.
 * ------------------------------------------------------------------------- */

/** Read the saved order array from localStorage. Renderer-side, so direct. */
function readSavedProfileOrder() {
  try {
    const raw = window.localStorage.getItem(PROFILE_ORDER_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(n => typeof n === 'string') : []
  } catch {
    return []
  }
}

/** Stable sort of `items` by position in `order`; absent items sort last. */
function sortByOrder(items, order) {
  const rank = new Map(order.map((name, i) => [name, i]))
  return [...items]
    .map((item, i) => ({ item, i, r: rank.has(item) ? rank.get(item) : Infinity }))
    .sort((a, b) => (a.r !== b.r ? a.r - b.r : a.i - b.i))
    .map(({ item }) => item)
}

/** Core's Nt(): non-default profiles sorted by saved order, `default` prepended. */
function orderedProfileNames(profiles, savedOrder) {
  const nonDefault = profiles.filter(p => !p.is_default).map(p => p.name)
  const sorted = sortByOrder(nonDefault, savedOrder)
  return profiles.some(p => p.is_default) ? ['default', ...sorted] : sorted
}

/** Core's It(): wrap-around neighbour pick by +1/-1 direction. */
function neighbourProfile(order, activeName, direction) {
  if (order.length < 2) return null
  const idx = order.indexOf(activeName)
  const base = idx < 0 ? (direction === 1 ? -1 : 0) : idx
  return order[(base + direction + order.length) % order.length]
}

/* ---------------------------------------------------------------------------
 * Wheel gesture phase detection — reconstructs the fields Chromium's wheel
 * event stream doesn't give you directly: isStart, isEnding, isMomentum,
 * isMomentumCancel, and an axisMovementProjection (predicted resting delta).
 * See attribution header above.
 * ------------------------------------------------------------------------- */

// A new gesture starts if more than this many ms have passed since the last
// wheel event on this target (mirrors wheel-gestures' default gesture gap).
const GESTURE_END_GAP_MS = 72
// A gesture is considered "ending" (about to stop) once this many ms pass
// with no further wheel events — detected via a timer, since Chromium never
// fires an explicit end event.
const GESTURE_IDLE_END_MS = 88
// Delta magnitude below which trackpad momentum is considered to have
// decayed to a halt (used to recognise momentum tails).
const MOMENTUM_DELTA_FLOOR = 0.5
// How strongly recent deltas are weighted when projecting the resting
// position (higher = more weight on the most recent samples).
const PROJECTION_DECAY = 0.86

/**
 * Tracks one continuous wheel-event stream and derives gesture phase +
 * a projected resting movement, functionally equivalent to wheel-gestures'
 * WheelEventState / axisMovementProjection.
 */
function createWheelGestureTracker({ axis = 'x' } = {}) {
  let lastTimestamp = 0
  let isGestureActive = false
  let wasMomentum = false
  let accumulatedMovement = 0
  let projectedRemainder = 0
  let endTimer = null

  function axisDelta(event) {
    return axis === 'x' ? event.deltaX : event.deltaY
  }

  /** Call for every qualifying wheel event. Returns a WheelGestureState. */
  function update(event) {
    const now = event.timeStamp ?? Date.now()
    const delta = axisDelta(event)
    const gapMs = now - lastTimestamp
    const isStart = !isGestureActive || gapMs > GESTURE_END_GAP_MS
    // A real touch landing back on the trackpad interrupts an in-flight
    // momentum tail: the stream continues (gap still small, so NOT isStart)
    // but the OS stops reporting momentum deltas. Flag that transition so
    // callers don't mistake the interruption for the tail just decaying out.
    const isMomentumCancel = !isStart && wasMomentum && !event.momentum
    const isMomentum = !!event.momentum || (!isStart && wasMomentum && !isMomentumCancel)

    if (isStart) {
      accumulatedMovement = 0
      projectedRemainder = 0
    }

    accumulatedMovement += delta
    // Exponential decay projection: assume the remaining momentum tail decays
    // geometrically from the current delta, same shape as wheel-gestures'
    // axisMovementProjection.
    projectedRemainder = delta !== 0
      ? delta / (1 - PROJECTION_DECAY)
      : projectedRemainder * PROJECTION_DECAY

    isGestureActive = true
    wasMomentum = Math.abs(delta) > MOMENTUM_DELTA_FLOOR ? isMomentum : wasMomentum
    lastTimestamp = now

    return {
      delta,
      deltaAccumulated: accumulatedMovement,
      axisMovementProjection: accumulatedMovement + projectedRemainder,
      isStart,
      isMomentum,
      isMomentumCancel,
      isEnding: false
    }
  }

  /** Schedule an "ending" callback once the stream has gone idle. */
  function scheduleEnd(onEnd) {
    if (endTimer) clearTimeout(endTimer)
    endTimer = setTimeout(() => {
      endTimer = null
      isGestureActive = false
      const wasMomentumAtEnd = wasMomentum
      wasMomentum = false
      onEnd({
        deltaAccumulated: accumulatedMovement,
        axisMovementProjection: accumulatedMovement + projectedRemainder,
        isMomentum: wasMomentumAtEnd,
        isEnding: true
      })
    }, GESTURE_IDLE_END_MS)
  }

  function cancelEnd() {
    if (endTimer) {
      clearTimeout(endTimer)
      endTimer = null
    }
  }

  function reset() {
    cancelEnd()
    isGestureActive = false
    wasMomentum = false
    accumulatedMovement = 0
    projectedRemainder = 0
    lastTimestamp = 0
  }

  return { update, scheduleEnd, cancelEnd, reset }
}

// Minimum accumulated travel (px) below which a release snaps back instead
// of committing a profile switch.
const MIN_COMMIT_TRAVEL_PX = 48

/** Projection-based destination, clamped to ±1 profile. */
function resolveDirection(projection) {
  if (Math.abs(projection) < MIN_COMMIT_TRAVEL_PX) return 0
  // Natural scrolling: swiping left (negative deltaX) advances to the next
  // profile, mirroring Arc/Safari's "swipe left to go forward" convention.
  return projection < 0 ? 1 : -1
}

/* ---------------------------------------------------------------------------
 * Overlay component
 * ------------------------------------------------------------------------- */

function swatchFor(name) {
  return PROFILE_SWATCHES?.[name] ?? null
}

function ProfileChip({ name, dimmed }) {
  const color = swatchFor(name)
  return jsxs('div', {
    className:
      'flex items-center gap-2 rounded-md px-3 py-2 ' +
      (dimmed ? 'opacity-50' : 'opacity-100'),
    children: [
      color
        ? jsx('span', {
            className: 'size-2.5 shrink-0 rounded-full',
            style: { backgroundColor: color }
          })
        : jsx(Skeleton, { className: 'size-2.5 shrink-0 rounded-full' }),
      jsx('span', {
        className: 'truncate text-[0.75rem] font-medium',
        children: name
      })
    ]
  })
}

function TransitionOverlay({ active, current, neighbour, translateX, maxTravel }) {
  if (!active) return null
  // Rubber-band translate clamps visually to ~1 chip-width of travel so the
  // overlay never runs away from the pointer.
  const clamped = Math.max(-maxTravel, Math.min(maxTravel, translateX))
  return jsx('div', {
    className:
      'pointer-events-none absolute inset-0 z-10 flex items-center justify-center ' +
      'bg-(--ui-panel-background) transition-opacity duration-150',
    style: { opacity: active ? 1 : 0 },
    children: jsxs('div', {
      className: 'flex items-center gap-1',
      style: { transform: `translateX(${clamped}px)` },
      children: [
        current ? jsx(ProfileChip, { name: current, dimmed: false }) : null,
        neighbour ? jsx(ProfileChip, { name: neighbour, dimmed: true }) : null
      ]
    })
  })
}

/* ---------------------------------------------------------------------------
 * Capture layer + gesture-to-lever wiring
 * ------------------------------------------------------------------------- */

const ACTIVATION_TIMEOUT_MS = 6000

function GestureCapture() {
  const containerRef = useRef(null)
  const trackerRef = useRef(null)
  const [gesture, setGesture] = useState({ active: false, translateX: 0, neighbour: null })
  const activeProfile = host.state.profile.get()

  useEffect(() => {
    trackerRef.current = createWheelGestureTracker({ axis: 'x' })
  }, [])

  useEffect(() => {
    log('component mounted')
    const anchor = containerRef.current
    if (!anchor) {
      log('mount effect: no anchor node ref — bailing')
      return undefined
    }

    // The anchor itself is `pointer-events-none` (it only hosts the visual
    // overlay), so it is never a wheel hit-test target. Walk up to the real,
    // hit-testable sidebar container and attach the listener there instead.
    const el = anchor.closest('[data-sidebar="sidebar"]') ?? anchor.parentElement ?? anchor
    if (el === anchor) {
      log('WARNING: could not resolve a [data-sidebar="sidebar"] ancestor or even a parentElement; falling back to the pointer-events-none anchor itself, which will not receive wheel events')
    } else {
      const rect = el.getBoundingClientRect()
      log('capture target resolved', {
        tag: el.tagName,
        className: el.className,
        dataSidebar: el.getAttribute?.('data-sidebar') ?? null,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })
    }

    let settled = true

    async function computeOrder() {
      const raw = await host.profiles.list()
      log('host.profiles.list() raw value', raw)
      const profiles = Array.isArray(raw) ? raw : Array.isArray(raw?.profiles) ? raw.profiles : []
      const savedOrder = readSavedProfileOrder()
      const order = orderedProfileNames(profiles, savedOrder)
      log('computed order', order)
      return order
    }

    async function commitSwitch(targetName) {
      log('commitSwitch', { targetName })
      haptic?.('selection')
      const originalProfile = host.state.profile.get()
      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
      }, ACTIVATION_TIMEOUT_MS)
      try {
        const sessions = await host.listPersistedSessions(null, { profile: targetName, limit: 1 })
        const sessionId = sessions?.sessions?.[0]?.id ?? sessions?.[0]?.id
        const activation = sessionId
          ? host.openSession(sessionId, { profile: targetName, keepAllProfilesScope: false })
          : Promise.resolve(host.newChat(targetName))
        await Promise.race([
          activation,
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Timed out activating ${targetName}`)), ACTIVATION_TIMEOUT_MS)
          })
        ])
        clearTimeout(timeout)
        if (timedOut) throw new Error(`Timed out activating ${targetName}`)
        log('commitSwitch succeeded', { targetName })
      } catch (err) {
        clearTimeout(timeout)
        log('commitSwitch failed', { targetName, error: String(err) })
        host.notifyError?.(err, `Could not switch to ${targetName}`)
        if (host.state.profile.get() !== originalProfile) {
          // Best-effort snap back to the original profile.
          try {
            const sessions = await host.listPersistedSessions(null, { profile: originalProfile, limit: 1 })
            const sessionId = sessions?.sessions?.[0]?.id ?? sessions?.[0]?.id
            if (sessionId) {
              host.openSession(sessionId, { profile: originalProfile, keepAllProfilesScope: false })
            } else {
              host.newChat(originalProfile)
            }
          } catch {
            // Nothing more we can do; the error toast already fired.
          }
        }
      }
    }

    function endGesture(state) {
      const direction = resolveDirection(state.axisMovementProjection)
      log('gesture phase: end', { axisMovementProjection: state.axisMovementProjection, direction })
      setGesture(g => ({ ...g, active: false }))
      if (direction === 0) return
      computeOrder().then(order => {
        const current = host.state.profile.get()
        const target = neighbourProfile(order, current, direction)
        log('resolved neighbour on end', { current, target })
        if (target && target !== current) commitSwitch(target)
      })
    }

    function onWheel(event) {
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      if (!horizontal) {
        log('wheel event', { deltaX: event.deltaX, deltaY: event.deltaY, horizontal: false })
        return
      }
      event.preventDefault()
      const tracker = trackerRef.current
      if (!tracker) return
      settled = false
      const state = tracker.update(event)
      log('wheel event', {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        horizontal: true,
        isStart: state.isStart,
        isMomentum: state.isMomentum,
        isMomentumCancel: state.isMomentumCancel,
        deltaAccumulated: state.deltaAccumulated
      })

      if (state.isMomentumCancel) {
        // A fresh touch landed on top of a decaying momentum tail — treat as
        // a brand-new gesture and don't double-fire the previous one.
        tracker.cancelEnd()
      }

      if (state.isStart) {
        log('gesture phase: start')
        computeOrder().then(order => {
          const current = host.state.profile.get()
          const dir = state.deltaAccumulated < 0 ? 1 : -1
          const neighbour = neighbourProfile(order, current, dir)
          log('resolved neighbour on start', { current, dir, neighbour })
          setGesture({ active: true, translateX: 0, neighbour })
        })
      }

      setGesture(g => (g.active ? { ...g, translateX: -state.deltaAccumulated } : g))

      tracker.scheduleEnd(state2 => {
        settled = true
        endGesture(state2)
      })
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      trackerRef.current?.reset()
    }
  }, [])

  return jsx('div', {
    ref: containerRef,
    className: 'pointer-events-none absolute inset-0',
    children: jsx(TransitionOverlay, {
      active: gesture.active,
      current: activeProfile,
      neighbour: gesture.neighbour,
      translateX: gesture.translateX,
      maxTravel: 96
    })
  })
}

export default {
  id: ID,
  name: 'Profile Gestures',
  register(ctx) {
    log('register() called')
    ctx.register({
      id: 'profile-gestures-overlay',
      area: SIDEBAR_NAV_AREA,
      order: 0,
      render: () => jsx(GestureCapture, {})
    })
  }
}
