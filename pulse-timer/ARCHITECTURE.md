# Pulse Timer architecture

```
pulse-timer/
  src/
    template.html
    audio/
      audio-engine.js
    core/
      timer-core.js
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
- **Timer core**: pure phase construction and duration math; no DOM, storage, sound, or CSS.
- **App/UI**: owns workouts, persistence, editor, sharing, gestures, and screen orchestration.
- **Styles**: base layout is separate from the Liquid Glass material layer.
- **Build**: inlines source files into a single `index.html` because the current Render service publishes only that artifact.

This keeps production compatible with Render while allowing audio, design, and timer logic to evolve independently.
