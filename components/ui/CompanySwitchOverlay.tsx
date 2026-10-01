import styles from './CompanySwitchOverlay.module.css'

interface CompanySwitchOverlayProps {
  targetCompanyName: string
}

/**
 * Full-frame, non-dismissible overlay shown while `useCompanySwitch`
 * (lib/useCompanySwitch.ts) runs — no Escape handler, no close button: the
 * user cannot back out of an in-flight company switch. Shared by the desktop
 * and mobile company switchers (issue #352) and by the post-leave redirect
 * (issue #352 PR 2), so it lives in components/ui/, not feature-local.
 *
 * The progress bar has no real steps to track — `switchCompany` plus the
 * token-refresh handshake has no measurable sub-progress — so it's a fixed
 * cosmetic animation that runs most of the way and holds, matching the
 * design's `growbar` keyframes rather than driving off real state.
 */
export default function CompanySwitchOverlay({ targetCompanyName }: CompanySwitchOverlayProps) {
  return (
    <div className={styles.overlay} role="status" aria-live="polite">
      <div className={styles.content}>
        <p className={styles.eyebrow}>Switching company</p>
        <p className={styles.name}>{targetCompanyName}</p>
        <div className={styles.track}>
          <div className={styles.bar} />
        </div>
        <p className={styles.footnote}>New session, new data. Your other open sessions are signed out.</p>
      </div>
    </div>
  )
}
