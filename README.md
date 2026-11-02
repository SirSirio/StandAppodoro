# StandAppodoro

Pomodoro, but the break is not optional. Every 30 minutes the laptop becomes unusable until you have been hands-off for 30 seconds. Stand app.

Windows only for now.

## Install

Download `StandAppodoro-Setup-<version>.exe` from the latest [release](../../releases/latest) and run it.
It installs per user (no admin needed) and starts right away. Enable "Start with Windows" from the tray menu.

The app lives in the tray: a peach ring that empties as the 30 minutes run out, with the minutes left in the middle.
Windows hides new tray icons behind the `^` chevron. Drag the ring onto the taskbar, or turn it on under
Settings > Personalization > Taskbar > Other system tray icons. Right-click it for Break now, Pause, Start with Windows, Settings, Quit.

Settings: how long you work, how long you must stay hands-off, the warning length, and the postpone budget.

## Run from source

```
npm install
npm start
```

Or double-click `Start StandAppodoro.cmd`. `npm run dist` builds the installer into `dist/`.
Pushing a tag like `v1.0.1` makes GitHub Actions build the installer and attach it to a release.

## How a cycle goes

1. **Work** for 30 minutes. Being away from the laptop for 5 minutes restarts the clock.
2. **Warning tile** (top right) counts down 60 seconds. Postpone with +5, +10, +15. Budget: 15 minutes per cycle.
3. **Break**: the screen is captured and warped into a black hole that follows the cursor and grows to full size in about 6 seconds.
   The ring empties as you stay away. The count only advances while nothing is touched, and restarts on any input.
   Calm music fades out the longer you stay away. Touching the mouse or keyboard ramps a siren in within about 7 seconds.
4. **Escape**: hold Esc for 10 seconds. The next break then comes after 15 minutes instead of 30.

## Testing

```
npm run fast    # 1 "minute" = 1 second: warning after 30 s, break after 42 s
npm run break   # starts a break 3 s after launch
```

All timings are in `CFG` at the top of `main.js`.
