/**
 * profile-gestures (t_lever spike) — proves a runtime desktop plugin can
 * switch the active Hermes profile via two indirect levers reached through
 * `host`, since the plugin SDK exports no `switchProfile` (see README.md /
 * the kanban card for the bundle-reading evidence).
 *
 * Throwaway quality on purpose: two buttons, no gestures, no overlay.
 *
 * UI is jsx() calls — JSX syntax will not parse on this no-build path.
 * Only utilities core already ships are used (no new Tailwind classes).
 */

import { host, SIDEBAR_NAV_AREA, ROUTES_AREA, useQuery } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'profile-gestures'

/** Non-default profiles sorted by profile order, `default` prepended if present.
 *  Mirrors core's Nt() in profile-D2NTN1hO.js. */
function orderedProfiles(profiles) {
  const nonDefault = profiles.filter(p => !p.is_default).map(p => p.name)
  return profiles.some(p => p.is_default) ? ['default', ...nonDefault] : nonDefault
}

/** Wrap-around neighbour pick. Mirrors core's It() in profile-D2NTN1hO.js. */
function neighbourProfile(profiles, activeName, direction) {
  const order = orderedProfiles(profiles)
  if (order.length < 2) return null
  const idx = order.indexOf(activeName)
  const base = idx < 0 ? (direction === 1 ? -1 : 0) : idx
  return order[(base + direction + order.length) % order.length]
}

function ProfileLeverPane() {
  const profilesQuery = useQuery({
    queryKey: [ID, 'profiles'],
    queryFn: () => host.profiles.list()
  })

  // host.profiles.list()'s exact return shape isn't documented by the SDK;
  // defensively unwrap {profiles:[...]} or a bare array.
  const raw = profilesQuery.data
  const profiles = Array.isArray(raw) ? raw : Array.isArray(raw?.profiles) ? raw.profiles : []
  const active = host.state.profile.get()
  const nextName = neighbourProfile(profiles, active, 1)
  const prevName = neighbourProfile(profiles, active, -1)

  // Lever 1: host.newChat(profileName) — starts a new chat in the target
  // profile and sets window.location.hash = '#/'.
  const onNext = () => {
    if (!nextName) return
    host.newChat(nextName)
  }

  // Lever 2: host.openSession(sessionId, { profile, keepAllProfilesScope: false })
  // — switches AND restores the target profile's most recent persisted
  // session. Falls back to newChat if there is no persisted session.
  const onPrev = async () => {
    if (!prevName) return
    const sessions = await host.listPersistedSessions(null, { profile: prevName, limit: 1 })
    const sessionId = sessions?.sessions?.[0]?.id ?? sessions?.[0]?.id
    if (sessionId) {
      host.openSession(sessionId, { profile: prevName, keepAllProfilesScope: false })
    } else {
      host.notify({ kind: 'error', message: `No persisted session for ${prevName}; falling back to newChat` })
      host.newChat(prevName)
    }
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2 p-2',
    children: [
      jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: `active: ${active}` }),
      jsx('button', {
        type: 'button',
        className: 'rounded px-2 py-1 text-[0.75rem] hover:bg-(--ui-row-hover-background)',
        onClick: onNext,
        children: `next profile (newChat) → ${nextName ?? '—'}`
      }),
      jsx('button', {
        type: 'button',
        className: 'rounded px-2 py-1 text-[0.75rem] hover:bg-(--ui-row-hover-background)',
        onClick: onPrev,
        children: `prev profile (openSession) → ${prevName ?? '—'}`
      })
    ]
  })
}

export default {
  id: ID,
  name: 'Profile Gestures (spike)',
  register(ctx) {
    ctx.register({
      id: 'profile-gestures-page',
      area: ROUTES_AREA,
      data: { path: '/profile-gestures/levers' },
      render: () => jsx(ProfileLeverPane, {})
    })
    ctx.register({
      id: 'profile-gestures-nav',
      area: SIDEBAR_NAV_AREA,
      order: 90,
      data: { codicon: 'arrow-swap', label: 'Profile Levers', path: '/profile-gestures/levers' }
    })
  }
}
