'use client'

const MAX = 50
const actions: string[] = []

export function trackAction(label: string) {
  const ts = new Date().toISOString().slice(11, 19)
  actions.push(`${ts} ${label}`)
  if (actions.length > MAX) actions.shift()
}

export function getRecentActions(): string {
  return actions.slice().reverse().join('\n') || '(none)'
}
