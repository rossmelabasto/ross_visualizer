# Instalar en Linux

[English](INSTALL.md) · Sitio: [ros.rossmel.com](https://ros.rossmel.com)

ross_visualizer está en **alfa**. Si algo falla, [abre un issue](https://github.com/rossmelabasto/ross_visualizer/issues).

## ¿Va a funcionar en mi compu?

Esto solo lee información de tu sistema: no instala nada, no pide contraseña y no envía datos a ningún lado.

```sh
curl -fsSL https://ros.rossmel.com/check.sh | bash
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
curl -fsSL https://ros.rossmel.com/key.asc | sudo pacman-key --add -
sudo pacman-key --lsign-key C08F57FCE06B95B52145012C274187B9D5E9FFEB
printf '\n[ross]\nServer = https://ros.rossmel.com/arch/x86_64\n' | sudo tee -a /etc/pacman.conf
sudo pacman -Syu ross-visualizer-bin
```

Se actualiza con `sudo pacman -Syu`. Para quitarlo, corre `sudo pacman -Rns ross-visualizer-bin` y borra el bloque `[ross]` de `/etc/pacman.conf`.

## Ubuntu y Debian

```sh
curl -fsSL https://ros.rossmel.com/key.asc | sudo gpg --dearmor -o /usr/share/keyrings/ross.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/ross.gpg] https://ros.rossmel.com/apt stable main" | sudo tee /etc/apt/sources.list.d/ross.list
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
sudo curl -fsSL https://ros.rossmel.com/rpm/ross.repo -o /etc/yum.repos.d/ross.repo
sudo dnf install ross-visualizer
```

La primera vez dnf te pregunta si confías en la clave. Su huella es `C08F 57FC E06B 95B5 2145 012C 2741 87B9 D5E9 FFEB`.

Se actualiza con `sudo dnf upgrade`. Para quitarlo:

```sh
sudo dnf remove ross-visualizer
sudo rm /etc/yum.repos.d/ross.repo
```

## AppImage

Descárgalo de la [página de versiones](https://github.com/rossmelabasto/ross_visualizer/releases), hazlo ejecutable y ábrelo. No se actualiza solo y tu sistema igual necesita `pipewire` y `playerctl`.

```sh
chmod +x ross_visualizer_*_amd64.AppImage
./ross_visualizer_*_amd64.AppImage
```

## Si algo falla

- **La ventana sale negra o en blanco con NVIDIA:** corre `WEBKIT_DISABLE_DMABUF_RENDERER=1 ross-visualizer` y cuéntame si con eso se arregla.
- **Las escenas no se mueven:** revisa que algo esté sonando y que PipeWire corra con `pw-cli info 0`.
- **No aparece la opción de overlay:** tu sesión no tiene layer-shell (GNOME o X11).

## Cambios

Mira el [registro de cambios](../CHANGELOG.es.md).
