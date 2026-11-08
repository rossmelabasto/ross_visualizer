# Installing on Linux

[Español](INSTALL.es.md) · Website: [ros.rossmel.com](https://ros.rossmel.com)

ross_visualizer is an **alpha**. If something breaks, please [open an issue](https://github.com/rossmelabasto/ross_visualizer/issues).

## Will it work on my computer?

This only reads information about your system: it installs nothing, asks for no password and sends nothing anywhere.

```sh
curl -fsSL https://ros.rossmel.com/check.sh | bash
```

## Requirements

Every dependency comes with the package. Only these depend on your system:

| Feature | Needs |
| --- | --- |
| The app and its scenes | Linux x86_64, glibc 2.35 or newer, a GPU with WebGL2 |
| Reacting to the music | PipeWire running. PulseAudio alone isn't enough |
| Song, artwork and controls | A player with MPRIS: Spotify, a browser and most Linux players |
| Overlay above your windows | Wayland with layer-shell: KDE Plasma, Hyprland, Sway, niri and others. On GNOME or X11 you get the full-screen app without the overlay |

## Packages

| Format | For | Package | Updates |
| --- | --- | --- | --- |
| pacman repository | CachyOS, Arch, EndeavourOS, Manjaro | `ross-visualizer-bin` | With pacman |
| AUR | CachyOS, Arch and derivatives | `ross-visualizer-bin` | Coming soon |
| APT repository | Ubuntu 22.04 or newer, Debian 13, Linux Mint, Pop!_OS | `ross-visualizer` | With apt |
| DNF repository | Fedora | `ross-visualizer` | With dnf |
| AppImage | Any x86_64 distro | Direct download | By hand |

## CachyOS and Arch

```sh
curl -fsSL https://ros.rossmel.com/key.asc | sudo pacman-key --add -
sudo pacman-key --lsign-key C08F57FCE06B95B52145012C274187B9D5E9FFEB
printf '\n[ross]\nServer = https://ros.rossmel.com/arch/x86_64\n' | sudo tee -a /etc/pacman.conf
sudo pacman -Syu ross-visualizer-bin
```

Update with `sudo pacman -Syu`. To remove it, run `sudo pacman -Rns ross-visualizer-bin` and delete the `[ross]` block from `/etc/pacman.conf`.

## Ubuntu and Debian

```sh
curl -fsSL https://ros.rossmel.com/key.asc | sudo gpg --dearmor -o /usr/share/keyrings/ross.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/ross.gpg] https://ros.rossmel.com/apt stable main" | sudo tee /etc/apt/sources.list.d/ross.list
sudo apt update
sudo apt install ross-visualizer
```

Update with `sudo apt update && sudo apt upgrade`. To remove it:

```sh
sudo apt remove ross-visualizer
sudo rm /etc/apt/sources.list.d/ross.list /usr/share/keyrings/ross.gpg
```

## Fedora

```sh
sudo curl -fsSL https://ros.rossmel.com/rpm/ross.repo -o /etc/yum.repos.d/ross.repo
sudo dnf install ross-visualizer
```

The first time, dnf asks whether you trust the key. Its fingerprint is `C08F 57FC E06B 95B5 2145 012C 2741 87B9 D5E9 FFEB`.

Update with `sudo dnf upgrade`. To remove it:

```sh
sudo dnf remove ross-visualizer
sudo rm /etc/yum.repos.d/ross.repo
```

## AppImage

Download it from the [releases page](https://github.com/rossmelabasto/ross_visualizer/releases), make it executable and run it. It doesn't update itself, and your system still needs `pipewire` and `playerctl`.

```sh
chmod +x ross_visualizer_*_amd64.AppImage
./ross_visualizer_*_amd64.AppImage
```

## Troubleshooting

- **The window is black or blank on NVIDIA:** run `WEBKIT_DISABLE_DMABUF_RENDERER=1 ross-visualizer`, and tell me if that fixes it.
- **The scenes don't move:** check that something is playing and that PipeWire is running with `pw-cli info 0`.
- **There's no overlay option:** your session has no layer-shell (GNOME or X11).

## Changes

See the [changelog](../CHANGELOG.md).
