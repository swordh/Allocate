// Browser-only singleton. Tracks clicks and navigations for bug report diagnostics.
// Safe to import anywhere — guards against SSR with typeof window checks.

type ActionEntry = {
  t: string   // HH:MM:SS
  kind: 'click' | 'nav'
  label: string
  path: string
}

const MAX = 50
const entries: ActionEntry[] = []

function now(): string {
  return new Date().toTimeString().slice(0, 8)
}

function labelFor(el: EventTarget | null): string {
  if (!(el instanceof Element)) return ''
  const candidate =
    (el as HTMLElement).getAttribute('aria-label') ||
    (el.closest('[aria-label]') as HTMLElement | null)?.getAttribute('aria-label') ||
    (el as HTMLElement).innerText?.trim().slice(0, 60) ||
    (el as HTMLInputElement).placeholder?.slice(0, 60) ||
    el.tagName.toLowerCase()
  return candidate?.replace(/\s+/g, ' ').trim() ?? ''
}

function push(entry: ActionEntry) {
  entries.push(entry)
  if (entries.length > MAX) entries.shift()
}

function handleClick(e: MouseEvent) {
  const el = e.target as Element | null
  const interactive = el?.closest('button, a, [role="button"], [role="tab"], input, select, textarea, label')
  const label = labelFor(interactive ?? el)
  const tag = (interactive ?? el)?.tagName.toLowerCase() ?? ''
  push({
    t: now(),
    kind: 'click',
    label: label ? `${label} (${tag})` : tag,
    path: window.location.pathname,
  })
}

function handleNav(path: string) {
  push({ t: now(), kind: 'nav', label: '', path })
}

let installed = false

export function initActionTracker() {
  if (typeof window === 'undefined' || installed) return
  installed = true

  document.addEventListener('click', handleClick, { capture: true, passive: true })

  // Patch pushState / replaceState to detect client-side navigation
  const orig = {
    push: history.pushState.bind(history),
    replace: history.replaceState.bind(history),
  }
  history.pushState = function (...args) {
    orig.push(...args)
    handleNav(window.location.pathname)
  }
  history.replaceState = function (...args) {
    orig.replace(...args)
    handleNav(window.location.pathname)
  }
  window.addEventListener('popstate', () => handleNav(window.location.pathname))
}

export function getRecentActions(): string {
  if (entries.length === 0) return '(no actions recorded)'
  return entries
    .map((e) => {
      if (e.kind === 'nav') return `[${e.t}] NAV → ${e.path}`
      return `[${e.t}] CLICK "${e.label}" at ${e.path}`
    })
    .join('\n')
}
