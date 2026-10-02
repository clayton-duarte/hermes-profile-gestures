// Synthetic verification harness, run with: node scratch_test.mjs
// Extracts the pure logic functions from plugin.js by re-implementing their
// exact bodies here (plugin.js can't be imported directly — it imports
// '@hermes/plugin-sdk' and 'react/jsx-runtime', neither resolvable under
// plain node). Kept byte-identical to plugin.js; if you touch the algorithm
// there, mirror it here.

function sortByOrder(items, order) {
  const rank = new Map(order.map((name, i) => [name, i]))
  return [...items]
    .map((item, i) => ({ item, i, r: rank.has(item) ? rank.get(item) : Infinity }))
    .sort((a, b) => (a.r !== b.r ? a.r - b.r : a.i - b.i))
    .map(({ item }) => item)
}

function orderedProfileNames(profiles, savedOrder) {
  const nonDefault = profiles.filter(p => !p.is_default).map(p => p.name)
  const sorted = sortByOrder(nonDefault, savedOrder)
  return profiles.some(p => p.is_default) ? ['default', ...sorted] : sorted
}

function neighbourProfile(order, activeName, direction) {
  if (order.length < 2) return null
  const idx = order.indexOf(activeName)
  const base = idx < 0 ? (direction === 1 ? -1 : 0) : idx
  return order[(base + direction + order.length) % order.length]
}

const GESTURE_END_GAP_MS = 72
const GESTURE_IDLE_END_MS = 88
const MOMENTUM_DELTA_FLOOR = 0.5
const PROJECTION_DECAY = 0.86
const MIN_COMMIT_TRAVEL_PX = 48

function createWheelGestureTracker({ axis = 'x' } = {}) {
  let lastTimestamp = 0
  let isGestureActive = false
  let wasMomentum = false
  let accumulatedMovement = 0
  let projectedRemainder = 0

  function axisDelta(event) {
    return axis === 'x' ? event.deltaX : event.deltaY
  }

  function update(event) {
    const now = event.timeStamp ?? Date.now()
    const delta = axisDelta(event)
    const gapMs = now - lastTimestamp
    const isStart = !isGestureActive || gapMs > GESTURE_END_GAP_MS
    const isMomentumCancel = !isStart && wasMomentum && !event.momentum
    const isMomentum = !!event.momentum || (!isStart && wasMomentum && !isMomentumCancel)

    if (isStart) {
      accumulatedMovement = 0
      projectedRemainder = 0
    }

    accumulatedMovement += delta
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

  return { update }
}

function resolveDirection(projection) {
  if (Math.abs(projection) < MIN_COMMIT_TRAVEL_PX) return 0
  return projection < 0 ? 1 : -1
}

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg)
  console.log('PASS: ' + msg)
}

// --- Test 1: profile order matches "sort by saved order, default first" ---
{
  const profiles = [
    { name: 'default', is_default: true },
    { name: 'work', is_default: false },
    { name: 'personal', is_default: false },
    { name: 'builder', is_default: false }
  ]
  // saved rail order: personal, builder, work
  const savedOrder = ['personal', 'builder', 'work']
  const order = orderedProfileNames(profiles, savedOrder)
  assert(
    JSON.stringify(order) === JSON.stringify(['default', 'personal', 'builder', 'work']),
    `profile order respects saved order with default first: got ${JSON.stringify(order)}`
  )

  // Empty saved order (this machine's actual current state -- confirmed no
  // hermes.desktop.profileOrder key in Local Storage leveldb) -> falls back
  // to profiles.list() order for non-default profiles, default first.
  const emptyOrder = orderedProfileNames(profiles, [])
  assert(
    JSON.stringify(emptyOrder) === JSON.stringify(['default', 'work', 'personal', 'builder']),
    `empty saved order falls back to list order, default first: got ${JSON.stringify(emptyOrder)}`
  )

  // Names absent from saved order sort last, stable.
  const partialOrder = orderedProfileNames(profiles, ['builder'])
  assert(
    JSON.stringify(partialOrder) === JSON.stringify(['default', 'builder', 'work', 'personal']),
    `names absent from saved order sort last, stable: got ${JSON.stringify(partialOrder)}`
  )
}

// --- Test 2: neighbour wrap-around ---
{
  const order = ['default', 'work', 'personal']
  assert(neighbourProfile(order, 'default', 1) === 'work', 'neighbour +1 from default is work')
  assert(neighbourProfile(order, 'personal', 1) === 'default', 'neighbour +1 wraps from last to first')
  assert(neighbourProfile(order, 'default', -1) === 'personal', 'neighbour -1 wraps from first to last')
  assert(neighbourProfile(['solo'], 'solo', 1) === null, 'single-profile order has no neighbour')
}

// --- Test 3: fast flick commits (large deltaX, single burst) ---
{
  const tracker = createWheelGestureTracker({ axis: 'x' })
  let t = 0
  let first
  let last
  for (const dx of [-40, -60, -55, -30]) {
    const state = tracker.update({ deltaX: dx, deltaY: 2, timeStamp: t })
    if (!first) first = state
    last = state
    t += 16
  }
  const direction = resolveDirection(last.axisMovementProjection)
  assert(first.isStart === true, 'fast flick: first event flagged isStart')
  assert(direction === 1, `fast flick commits forward (projection=${last.axisMovementProjection.toFixed(1)})`)
}

// --- Test 4: slow short drag snaps back (small deltaX, below commit threshold) ---
{
  const tracker = createWheelGestureTracker({ axis: 'x' })
  let t = 0
  let last
  for (const dx of [-3, -2, -2]) {
    last = tracker.update({ deltaX: dx, deltaY: 1, timeStamp: t })
    t += 40
  }
  const direction = resolveDirection(last.axisMovementProjection)
  assert(direction === 0, `slow short drag snaps back (projection=${last.axisMovementProjection.toFixed(1)})`)
}

// --- Test 5: momentum tail does not double-fire a new gesture ---
{
  const tracker = createWheelGestureTracker({ axis: 'x' })
  let t = 0
  // Primary flick.
  for (const dx of [-50, -70, -60]) {
    tracker.update({ deltaX: dx, deltaY: 2, timeStamp: t })
    t += 16
  }
  // Momentum tail: decaying deltas, gap stays under GESTURE_END_GAP_MS so the
  // tracker must NOT report isStart again (same gesture continuing).
  t += 16
  const tail1 = tracker.update({ deltaX: -18, deltaY: 0, timeStamp: t, momentum: true })
  t += 16
  const tail2 = tracker.update({ deltaX: -6, deltaY: 0, timeStamp: t, momentum: true })
  assert(tail1.isStart === false, 'momentum tail event 1 is not a new gesture start')
  assert(tail2.isStart === false, 'momentum tail event 2 is not a new gesture start')
  assert(tail1.isMomentum === true && tail2.isMomentum === true, 'momentum tail flagged isMomentum')

  // A real new touch arriving ON TOP of the momentum tail (gap stays small,
  // so NOT a fresh isStart) must be flagged isMomentumCancel so callers don't
  // treat it as more decaying momentum (that would double-fire the commit).
  t += 16
  const cancel = tracker.update({ deltaX: 25, deltaY: 1, timeStamp: t })
  assert(cancel.isStart === false, 'a touch landing mid-tail is not treated as a fresh gesture start')
  assert(
    cancel.isMomentumCancel === true,
    'new touch landing on a momentum tail is flagged isMomentumCancel (prevents double-fire)'
  )

  // After the gap exceeds GESTURE_END_GAP_MS with no momentum behind it, the
  // next event is a clean new start, not a cancel.
  t += 200
  const freshStart = tracker.update({ deltaX: -10, deltaY: 1, timeStamp: t })
  assert(freshStart.isStart === true, 'event after the idle gap starts a brand-new gesture')
  assert(freshStart.isMomentumCancel === false, 'a clean new gesture is not flagged as a momentum cancel')
}

// --- Test 6: vertical scroll is ignored by the capture layer's own guard ---
{
  // This mirrors plugin.js's onWheel guard: `if (|deltaX| <= |deltaY|) return`
  function wouldCapture(event) {
    return Math.abs(event.deltaX) > Math.abs(event.deltaY)
  }
  assert(wouldCapture({ deltaX: 2, deltaY: 40 }) === false, 'vertical scroll (deltaY dominant) is not captured')
  assert(wouldCapture({ deltaX: 40, deltaY: 2 }) === true, 'horizontal swipe (deltaX dominant) is captured')
}

console.log('\nAll synthetic tests passed.')
