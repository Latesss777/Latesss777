# Pulse Timer — Clean Code Rules

These rules are mandatory for every change in `pulse-timer/`.

## Source of truth
1. Never hand-edit `index.html`. It is a generated production artifact.
2. Edit only files under `src/`, `assets/`, `scripts/`, and `tests/`.
3. Run `node pulse-timer/scripts/build.mjs` before deployment.
4. CI must fail when generated `index.html` differs from source.

## Module boundaries
1. Audio code lives only in `src/audio/`.
2. Visual tokens and materials live only in `src/styles/`.
3. Pure phase/duration math lives only in `src/core/`; it must never touch DOM, storage, audio, or CSS.
4. Screen orchestration and interaction state live in `src/app/`.
5. Persistence and sharing must not know about UI styling.
6. UI code calls public module APIs; it must not reach into module internals.

## JavaScript
1. No new global variables except a single explicit module namespace when required by the generated bundle.
2. No duplicated state.
3. Functions should do one job and return an explicit result for failure-prone operations.
4. No empty catch blocks in new code. Record an error or intentionally document why it is ignored.
5. Avoid magic numbers: timing, audio gain, blur, radii, and spacing belong in named constants/tokens.
6. Use one event listener per interaction responsibility; avoid duplicate listeners for the same action.
7. Never start an AudioContext at page load. Audio must be unlocked from a user gesture.
8. Never use MediaSession or a playback audio session in the PWA when music coexistence is required.
9. Timer truth is wall-clock time (`Date.now()`), not interval ticks.

## CSS / design
1. Use design tokens. No new arbitrary colors/radii/shadows in component rules.
2. Liquid Glass is reserved for controls/navigation; content cards use restrained frosted material.
3. Every glass surface needs: translucent fill, backdrop blur/saturation, subtle inner highlight, hairline border, and contrast-safe fallback.
4. No neon glow.
5. No decorative container unless it improves hierarchy or interaction.
6. Icons are monochrome by default; color is reserved for state/primary action.
7. Minimum touch target: 44×44 CSS px where practical.
8. Respect `prefers-reduced-motion` and `prefers-contrast`.
9. Avoid parent opacity/filter on glass ancestors because it creates a backdrop root and breaks nested backdrop-filter.

## Testing
1. Every audio change must pass decode/loudness tests.
2. Every source change must pass syntax/build consistency tests.
3. Every timer change must pass deterministic phase-transition tests.
4. Deploy only a commit that passed CI.
