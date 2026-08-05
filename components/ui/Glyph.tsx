import styles from './Glyph.module.css'

type GlyphChar = '‹' | '›' | '→'

interface GlyphProps {
  char: GlyphChar
  /** Degrees. Applied inline, so a CSS `transform` on the same element replaces it. */
  rotate?: 0 | 90 | 180 | 270
  className?: string
}

/**
 * Chevrons and arrows are text glyphs in the design, not SVG. Use <Icon> for
 * everything else.
 */
export default function Glyph({ char, rotate = 0, className }: GlyphProps) {
  return (
    <span
      aria-hidden="true"
      className={className ? `${styles.glyph} ${className}` : styles.glyph}
      style={rotate ? { transform: `rotate(${rotate}deg)` } : undefined}
    >
      {char}
    </span>
  )
}
