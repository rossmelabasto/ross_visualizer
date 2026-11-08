# Changelog

Everything before 1.0 is an alpha: expect rough edges and tell me about them in the [issues](https://github.com/rossmelabasto/ross_visualizer/issues).

## 0.1.0

First alpha of the Linux desktop app, for friends to try.

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
