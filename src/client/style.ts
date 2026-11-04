/**
 * All plugin-owned CSS lives in one `<style>` element, injected unconditionally
 * at the top of `apply` (AGENTS.md §9): if injection ran after any service
 * guard, an HMR reload that raced the service would leave the panel unstyled.
 *
 * Keyframes and transitions cannot be expressed as inline styles, so anything
 * animated has to be named here. The `corner-shape: round` resets are part of
 * this sheet for the same reason they exist at all: the host sets a global
 * `corner-shape: superellipse(1.5)`, so every surface that must be a real
 * circle or a plain rounded rectangle has to opt back out.
 */
export const STYLE_ID = 'dsh-useful-taskball-style'

export const CSS = `
[data-taskball-ball] {
  corner-shape: round;
  will-change: transform;
}
/* F-010 (D-055): the sector boundaries and fills are registered custom
   properties (see ball-visual.ts), so transitioning THEM is what animates the
   ring — the gradient string itself never changes. Only the values move, which
   is the one form of conic-gradient animation the browser can interpolate
   (verified on this machine 2026-10-30: 24 distinct intermediate angles over a
   300ms transition).
   The transition sits on the resting state here, unlike the spin: a sector
   change can happen at any time and does not need an explicit flag, and there is
   no reset problem because the values are absolute angles, not a rotation.
   Under prefers-reduced-motion the duration is zeroed at the end of this
   sheet, so the ring lands on its final state immediately. */
[data-taskball-ball] {
  transition:
    --taskball-b0 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-b1 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-b2 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-b3 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-b4 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-b5 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-b6 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-b7 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-c0 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-c1 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-c2 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-c3 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-c4 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-c5 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-c6 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-c7 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-s0 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-s1 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-s2 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-s3 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-s4 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-s5 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-s6 200ms cubic-bezier(0.22, 1, 0.36, 1),
    --taskball-s7 200ms cubic-bezier(0.22, 1, 0.36, 1);
}
/* The transition lives ONLY on the spinning state. If it sat on the base rule,
   clearing the flag would animate 360deg back to 0deg — the ball visibly spun
   one way and then unwound the other way. Without a transition on the resting
   state the reset is instant, and 360deg and 0deg look identical, so the turn
   reads as a single clean revolution. */
[data-taskball-ball][data-spin] {
  transition: transform 420ms cubic-bezier(0.22, 1, 0.36, 1);
}
[data-taskball-ball][data-spin="right"] { transform: rotate(360deg); }
[data-taskball-ball][data-spin="left"] { transform: rotate(-360deg); }

/* D-033: before the first snapshot the ball has nothing to report, and saying
   "no task states" would be a claim it cannot make. A soft pulse says "still
   loading" without inventing a status colour or a text label. */
[data-taskball-ball][data-loading="true"] {
  animation: taskball-loading 1.4s ease-in-out infinite;
}
@keyframes taskball-loading {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}

[data-taskball-bubble] {
  corner-shape: round;
  animation: taskball-bubble-in 240ms cubic-bezier(0.22, 1, 0.36, 1);
  transform-origin: var(--taskball-bubble-origin, center);
}
/* The bubble grows out of the ball, so its origin is the ball-facing edge. */
[data-taskball-bubble][data-side="left"] { --taskball-bubble-origin: right center; --taskball-bubble-shift: 10px; }
[data-taskball-bubble][data-side="right"] { --taskball-bubble-origin: left center; --taskball-bubble-shift: -10px; }

@keyframes taskball-bubble-in {
  from { opacity: 0; transform: scale(0.62) translateX(var(--taskball-bubble-shift, 0)); }
  60% { opacity: 1; }
  to { opacity: 1; transform: scale(1) translateX(0); }
}

/* Row exit motion. Transform + opacity only: animating max-height (the previous
   approach) forced a layout pass on every frame, which is what made the row
   look like it stuttered instead of gliding out. The row is removed from the
   DOM by React once the fold commits, so no collapse rule is needed. */
[data-taskball-row][data-leaving="true"][data-anim="slide-out"] {
  animation: taskball-row-out 220ms cubic-bezier(0.4, 0, 1, 1) forwards;
  pointer-events: none;
}
[data-taskball-row][data-leaving="true"][data-anim="slide-down"] {
  animation: taskball-row-down 280ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
  pointer-events: none;
}
@keyframes taskball-row-out {
  from { opacity: 1; transform: translateX(0) scale(1); }
  to { opacity: 0; transform: translateX(var(--taskball-out-dir, 24px)) scale(0.96); }
}
@keyframes taskball-row-down {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(18px); }
}
/* The whole-row status modes (including the 0.5px theme-outline variant) were
   removed on 2026-11-03: only the colour chip and the dot remain, and neither
   reads the row-outline variable. The rules are deleted rather than left dormant,
   so a stale stored value cannot resurrect a mode the panel no longer renders. */

/* D-074 (user 2026-11-02): the collapsed bar gets a white frame around its whole
   outline. Measured on the real page: the light theme's gutter and composer card
   are both rgb(255,255,255), so a white frame alone is invisible there (the pixel
   at the strip's edge read rgb(140,197,255) — present, but with nothing to
   contrast against). The fix keeps the white frame and adds a hairline edge just
   outside it, so the frame reads on any backdrop. Both colours are theme-scoped
   custom properties, never fixed values in the component (D-037's lesson). */
[data-taskball-strip] { --taskball-strip-edge: rgba(15, 23, 42, 0.22); }
body[data-ds-dark-theme] [data-taskball-strip] { --taskball-strip-edge: rgba(255, 255, 255, 0.18); }

/* F-004 (D-038): confirming a failure slides the row out to the left; the two
   blocks that take its place are an overlay inside the same wrapper, so the list
   height never changes. Paint only — the fold happens on confirm, not here. */
[data-taskball-row] {
  transition: transform 180ms ease, opacity 140ms ease;
}
[data-taskball-row][data-confirming="true"] {
  opacity: 0;
  pointer-events: none;
  transform: translateX(-100%);
}

/* F-012 (D-040): the row's slot collapses from 1fr to 0fr while the row itself
   animates out, so the panel's height follows continuously instead of jumping
   the moment the row unmounts. grid-template-rows is animatable and needs no
   measurement — animating a measured height is the pattern F10 already proved
   re-triggers itself in this host. The duration must match the row's own exit
   animation, or the two motions read as two separate events. */
[data-taskball-slot] {
  transition: grid-template-rows 220ms cubic-bezier(0.4, 0, 1, 1);
}
[data-taskball-slot][data-anim="slide-down"] {
  transition-duration: 280ms;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
}

[data-taskball-swatch] {
  corner-shape: round;
  transition: transform 220ms ease;
}
[data-taskball-panel] { corner-shape: round; }
[data-taskball-panel][data-open="true"] { animation: taskball-panel-in 180ms ease; }
@keyframes taskball-panel-in {
  from { opacity: 0; transform: translateY(6px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

/* F-009: the quick settings popup grows out of the ball like the bubble does, so
   it reads as something the ball produced rather than a second app window. It
   is its own layer (data-taskball-quick) and its own animation: reusing the
   panel's keyframe would tie two independent lifetimes together. */
[data-taskball-quick] {
  corner-shape: round;
  animation: taskball-quick-in 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes taskball-quick-in {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}
[data-taskball-check] {
  corner-shape: round;
  accent-color: var(--taskball-check-color, currentColor);
}
/* F-023: keep our own fills when a third-party skin rewrites every dialog.
   open-sea-skin ships
     body :is([data-shortcut-modal="settings"], [role="dialog"], [role="alertdialog"]) { background: ... !important }
   which is broader than its intent ("protect modal cards") and therefore hits
   our three role="dialog" surfaces too, flattening the D-075 frosted default
   into a 97%-opaque box. A stylesheet !important outranks a plain inline
   declaration, so the inline background alone cannot defend itself.
   The fix routes the value through a custom property instead: React writes
   custom properties with style.setProperty, so the !important here is OURS and
   wins. Setting background with an inline !important does NOT work — React
   assigns ordinary properties via style[name] = value, and the browser silently
   drops a value carrying !important (verified 2026-11-03).
   --taskball-*-fill is set by the surface itself, so this sheet stays the only
   place that knows about the skin.

   THREE ROUNDS OF SPECIFICITY, and the last one is why this lives in @layer.
   Round 1 (skin 1.2.6) shipped the rule at (0,1,2). It lost in dark theme, because
   the skin has TWO rules and the dark one is the harder case:
     body :is([role="dialog"])                      (0,1,1)   light theme
     body[data-ds-dark-theme] :is([role="dialog"])  (0,2,1)   dark theme
   Round 2 shipped (0,2,2) via a second always-present attribute and won.
   Round 3 (skin 1.2.7) broke it AGAIN: the skin added :not(#__open-sea-skin-panel__)
   to exclude its OWN panel, and an ID selector inside :not() counts toward
   specificity, so the skin's dark rule jumped to (1,2,1) — an ID column we cannot
   reach without inventing a fake ID of our own.
   That is the structural lesson: chasing the skin's specificity is unwinnable, because
   every skin release that fixes its own bug widens or deepens the same selector.
   @layer ends the contest instead of moving the bar:
     - for !important declarations, LAYERED beats UNLAYERED unconditionally, regardless
       of specificity (measured 2026-11-03 against a synthetic (3,3,1) rule: (0,1,0)
       inside a layer still won);
     - so the skin can raise its specificity forever and still lose.
   The (0,2,2) attributes below are kept on purpose, not as the defense but as a
   fallback: if a future engine dropped @layer support the whole block would be
   discarded, and these attributes would still give the rule a chance.
   Residual risk, documented in docs/compatibility.md: if the skin ever wraps its
   rules in its own @layer AND is parsed before ours, the first-declared layer wins
   and this loses. The escape hatch then is an inline !important via
   style.setProperty — deliberately NOT adopted now, to avoid an imperative DOM
   path for a case that does not exist today. */
@layer taskball-defense {
  html body [data-taskball-panel][data-open],
  html body [data-taskball-quick][role="dialog"] {
    background: var(--taskball-surface-fill) !important;
  }
  /* The bulk-confirm backdrop is a full-screen dimmer, not a card: its fill is a
     fixed translucent slate and must not be replaced by the near-opaque skin rule
     either, or the panel behind it stops showing through. */
  html body [data-taskball-bulk-confirm][aria-modal="true"] {
    background: var(--taskball-backdrop-fill) !important;
  }
}
@media (prefers-reduced-motion: reduce) {
  [data-taskball-ball], [data-taskball-swatch], [data-taskball-row], [data-taskball-slot] { transition: none; }
  [data-taskball-ball][data-loading="true"] { animation: none; }
  [data-taskball-row][data-leaving="true"] { animation: none; opacity: 0; }
  [data-taskball-bubble], [data-taskball-panel], [data-taskball-quick] { animation: none; }
}
`

/** Inject once per fiber; the disposer removes only this fiber's element. */
export function injectStyle(): () => void {
  const existing = globalThis.document?.getElementById(STYLE_ID)
  if (existing !== null && existing !== undefined) {
    return () => {}
  }
  const element = globalThis.document?.createElement('style')
  if (element === null || element === undefined) return () => {}
  element.id = STYLE_ID
  element.textContent = CSS
  globalThis.document?.head?.appendChild(element)
  return () => {
    element.remove()
  }
}
