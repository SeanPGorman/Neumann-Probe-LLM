import * as React from "react"

const DESKTOP_BREAKPOINT = 1024

// Matches the layout's real stacking breakpoint (Tailwind `lg`, used by
// `lg:flex-row`/`lg:w-72` in Commander). Intentionally NOT the 768px of
// `useIsMobile` — that would leave a 768–1024px dead zone where the resizable
// split renders but the design expects vertical stacking.
//
// State is seeded synchronously from matchMedia (client-only Vite SPA, no SSR):
// returning false-until-measured would paint the stacked mobile branch on every
// desktop load, then snap to the split — a visible flash + full pane remount.
export function useIsDesktop() {
  const [isDesktop, setIsDesktop] = React.useState(
    () => window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT}px)`).matches
  )

  React.useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT}px)`)
    const onChange = () => setIsDesktop(mql.matches)
    mql.addEventListener("change", onChange)
    onChange()
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return isDesktop
}
