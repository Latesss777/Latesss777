# Pulse Timer architecture

```
pulse-timer/
  src/
    template.html
    audio/
      audio-engine.js
    app/
      app.js
    styles/
      base.css
      liquid-glass.css
  scripts/
    build.mjs
  sounds/
    countdown.b64
    start_whistle.b64
    end_bell.b64
  tests/
    audio-static.test.js
    structure.test.js
  index.html        # GENERATED
```

## Runtime layers

- **Audio engine**: owns AudioContext, signal decoding, gain/limiting, iOS audio-session strategy, recovery, and diagnostics.
- **App/timer**: owns workouts, timer phases, persistence, editor, sharing, gestures, and screen state.
- **Styles**: base layout is separate from the Liquid Glass material layer.
- **Build**: inlines source files into a single `index.html` because the current Render service publishes only that artifact.

This keeps production compatible with Render while allowing audio, design, and timer logic to evolve independently.
