# Changelog

Everything before 1.0 is an alpha: expect rough edges and tell me about them in the [issues](https://github.com/rossmelabasto/ross_visualizer/issues).

## 0.2.0

### New

- **Android app (alpha).** The same scenes on your phone, reacting to everything it plays (Spotify, YouTube, any app) and painting with the artwork of the song that's on, with previous, play/pause and next. A tour walks through the two permissions it needs and what each is for.
- **Overlay on Android:** the seven styles above your other apps, letting your touches through, with an opacity slider. It keeps going with the app closed and turns off from its notification.
- **Two bars at the bottom**, on the web, Linux and Android: one for the player (previous, play/pause, next) and one for the scenes. Stacked when the screen is upright, side by side when it's wide.
- The Android app gets updates through the [F-Droid repository](https://repo.rossmel.com/ross-visualizer/#android) of repo.rossmel.com, or as a direct APK download.

## 0.1.1

### New

- Audio source in Settings. "Everything that plays" now also hears apps playing on another output: before, with Discord on a headset and Spotify on the speakers, only Discord came through. Or pick a single app so voices on a call don't move the scenes.
- A welcome tour the first time you open the app: what it does, the scenes, the overlay and keyboard shortcuts for your desktop (niri, Hyprland, Sway or KDE), ready to copy. Settings opens it again.
- A button on the bottom bar to go back to the previous song.
- The rOS scene shows your user and your computer's name in its prompt.
- Actions on the app's icon: right-click → "Overlay on/off" or "Next overlay style".
- Keyboard shortcuts for each desktop, also on repo.rossmel.com and in the docs.

## 0.1.0

First alpha of the Linux desktop app.

### Added

- Desktop app for Linux: listens to everything the computer plays, with no audio source to pick and no login.
- Follows whichever MPRIS player is playing (Spotify, a browser…) for the artwork and the play and next buttons.
- Every scene from the web in full screen.
- Click-through overlay above every window, in seven styles with their own settings: Halo, Horizon, Orbit, Curtain, Embers, rOS rain and Wave.
- Commands for key bindings: `ross-visualizer overlay toggle|off|next|prev|<style>`.
- Packages: pacman repository, APT repository, DNF repository and AppImage.
- Compatibility check that says what will work on your system before you install anything.

### Known limits

- x86_64 only.
- Needs PipeWire; PulseAudio alone isn't enough.
- The overlay needs Wayland with layer-shell (KDE, Hyprland, Sway, niri…). On GNOME or X11 you get the full-screen app without the overlay.
