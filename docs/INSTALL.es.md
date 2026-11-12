# Instalar en Linux

[English](INSTALL.md) · Sitio: [repo.rossmel.com/ross-visualizer](https://repo.rossmel.com/ross-visualizer/)

ross_visualizer está en **alfa**. Si algo falla, [abre un issue](https://github.com/rossmelabasto/ross_visualizer/issues).

## ¿Va a funcionar en mi compu?

Esto solo lee información de tu sistema: no instala nada, no pide contraseña y no envía datos a ningún lado.

```sh
curl -fsSL https://repo.rossmel.com/check.sh | bash
```

## Requisitos

Todas las dependencias vienen con el paquete. Solo esto depende de tu sistema:

| Función | Qué necesita |
| --- | --- |
| La app y las escenas | Linux x86_64, glibc 2.35 o más nueva, una GPU con WebGL2 |
| Reaccionar a la música | PipeWire corriendo. PulseAudio solo no alcanza |
| Canción, portada y controles | Un reproductor con MPRIS: Spotify, un navegador y casi todos los de Linux |
| Overlay sobre las ventanas | Wayland con layer-shell: KDE Plasma, Hyprland, Sway, niri y otros. En GNOME o X11 tienes la pantalla completa, sin overlay |

## Paquetes

| Formato | Para | Paquete | Se actualiza |
| --- | --- | --- | --- |
| Repositorio pacman | CachyOS, Arch, EndeavourOS, Manjaro | `ross-visualizer-bin` | Con pacman |
| AUR | CachyOS, Arch y derivadas | `ross-visualizer-bin` | Próximamente |
| Repositorio APT | Ubuntu 22.04 o más nueva, Debian 13, Linux Mint, Pop!_OS | `ross-visualizer` | Con apt |
| Repositorio DNF | Fedora | `ross-visualizer` | Con dnf |
| AppImage | Cualquier distro x86_64 | Descarga directa | A mano |

## CachyOS y Arch

```sh
curl -fsSL https://repo.rossmel.com/key.asc | sudo pacman-key --add -
sudo pacman-key --lsign-key C08F57FCE06B95B52145012C274187B9D5E9FFEB
printf '\n[ross]\nServer = https://repo.rossmel.com/arch/x86_64\n' | sudo tee -a /etc/pacman.conf
sudo pacman -Syu ross-visualizer-bin
```

Se actualiza con `sudo pacman -Syu`. Para quitarlo, corre `sudo pacman -Rns ross-visualizer-bin` y borra el bloque `[ross]` de `/etc/pacman.conf`.

## Ubuntu y Debian

```sh
curl -fsSL https://repo.rossmel.com/key.asc | sudo gpg --dearmor -o /usr/share/keyrings/ross.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/ross.gpg] https://repo.rossmel.com/apt stable main" | sudo tee /etc/apt/sources.list.d/ross.list
sudo apt update
sudo apt install ross-visualizer
```

Se actualiza con `sudo apt update && sudo apt upgrade`. Para quitarlo:

```sh
sudo apt remove ross-visualizer
sudo rm /etc/apt/sources.list.d/ross.list /usr/share/keyrings/ross.gpg
```

## Fedora

```sh
sudo curl -fsSL https://repo.rossmel.com/rpm/ross.repo -o /etc/yum.repos.d/ross.repo
sudo dnf install ross-visualizer
```

La primera vez dnf te pregunta si confías en la clave. Su huella es `C08F 57FC E06B 95B5 2145 012C 2741 87B9 D5E9 FFEB`.

Se actualiza con `sudo dnf upgrade`. Para quitarlo:

```sh
sudo dnf remove ross-visualizer
sudo rm /etc/yum.repos.d/ross.repo
```

## Android

Android 7.0 o más nuevo. Agrega el repositorio F-Droid (en F-Droid, Droid-ify o Neo Store) desde [repo.rossmel.com/ross-visualizer](https://repo.rossmel.com/ross-visualizer/#android) y se actualiza sola, o descarga el APK desde la misma página. La primera vez, un tutorial te pide el permiso de audio (Android clasifica ahí al visualizador del sistema; no se graba nada) y el acceso a notificaciones (para ver la canción y su portada; no lee tus notificaciones). El overlay necesita además "Mostrar sobre otras apps".

## AppImage

Descárgalo de la [página de versiones](https://github.com/rossmelabasto/ross_visualizer/releases), hazlo ejecutable y ábrelo. No se actualiza solo y tu sistema igual necesita `pipewire` y `playerctl`.

```sh
chmod +x ross_visualizer_*_amd64.AppImage
./ross_visualizer_*_amd64.AppImage
```

## Atajos de teclado

Con dos atajos prendes el overlay y cambias de estilo desde cualquier lado, sin abrir la app. Cada escritorio guarda sus atajos en su propia configuración, así que la app no puede agregarlos sola. La primera vez que la abres, el tutorial te muestra los de tu escritorio. Si usas el AppImage, cambia `ross-visualizer` por la ruta del archivo.

| Atajo | Qué hace |
| --- | --- |
| `Super+Ctrl+V` | Prende o apaga el overlay |
| `Super+Ctrl+B` | Pasa al siguiente estilo |

**niri:** dentro del bloque `binds { }` de `~/.config/niri/config.kdl`. niri las toma al guardar.

```kdl
Mod+Ctrl+V hotkey-overlay-title="Visualizer: overlay sí/no" { spawn "ross-visualizer" "overlay" "toggle"; }
Mod+Ctrl+B hotkey-overlay-title="Visualizer: siguiente estilo" { spawn "ross-visualizer" "overlay" "next"; }
```

**Hyprland:** en `~/.config/hypr/hyprland.conf`. Hyprland las toma al guardar.

```ini
bind = SUPER CTRL, V, exec, ross-visualizer overlay toggle
bind = SUPER CTRL, B, exec, ross-visualizer overlay next
```

**Sway:** en `~/.config/sway/config`, y luego `swaymsg reload`.

```
bindsym Mod4+Ctrl+v exec ross-visualizer overlay toggle
bindsym Mod4+Ctrl+b exec ross-visualizer overlay next
```

**KDE Plasma:** Preferencias del sistema → Teclado → Atajos → Añadir nuevo → Comando o script. Crea uno con `ross-visualizer overlay toggle` y `Meta+Ctrl+V`, y otro con `ross-visualizer overlay next` y `Meta+Ctrl+B`.

**Otros escritorios:** asigna un atajo a `ross-visualizer overlay toggle` y otro a `ross-visualizer overlay next`. En GNOME y en X11 no hay overlay, así que no hacen falta.

Sin configurar nada: clic derecho en el ícono de la app en tu lanzador o dock → "Overlay sí/no" o "Siguiente estilo de overlay".

## Si algo falla

- **La ventana sale negra o en blanco con NVIDIA:** corre `WEBKIT_DISABLE_DMABUF_RENDERER=1 ross-visualizer` y cuéntame si con eso se arregla.
- **Las escenas no se mueven:** revisa que algo esté sonando y que PipeWire corra con `pw-cli info 0`.
- **No aparece la opción de overlay:** tu sesión no tiene layer-shell (GNOME o X11).

## Cambios

Mira el [registro de cambios](../CHANGELOG.es.md).
