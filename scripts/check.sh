#!/usr/bin/env bash
# ross_visualizer: ¿va a funcionar en esta compu?
#   curl -fsSL https://ros.rossmel.com/check.sh | bash
# Solo mira: no instala nada, no pide sudo y no sube nada a ningún lado.
# Sale con 0 si la app puede correr aquí y con 1 si algo la impide.
set -u
export LC_ALL=C

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' D=$'\e[2m' B=$'\e[1m' N=$'\e[0m'
else
  G='' Y='' R='' D='' B='' N=''
fi

ok()    { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
warn()  { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
fail()  { printf '  %s✗%s %s\n' "$R" "$N" "$1"; }
info()  { printf '    %s%s%s\n' "$D" "$1" "$N"; }
title() { printf '\n%s%s%s\n' "$B" "$1" "$N"; }
has()   { command -v "$1" >/dev/null 2>&1; }

lib_present() {
  local ldconfig_bin
  ldconfig_bin=$(command -v ldconfig || echo /sbin/ldconfig)
  "$ldconfig_bin" -p 2>/dev/null | grep -q "$1"
}

blocked=0       # la app no puede correr
audio=yes       # yes | no
media=yes       # yes | no
overlay=unknown # yes | no | unknown

. /etc/os-release 2>/dev/null || true
distro_id=${ID:-desconocida}
distro_like=${ID_LIKE:-}
case " $distro_id $distro_like " in
  *" arch "*|*" cachyos "*)            family=arch ;;
  *" ubuntu "*|*" debian "*)           family=deb ;;
  *" fedora "*|*" rhel "*)             family=rpm ;;
  *)                                   family=other ;;
esac

printf '%sross_visualizer · verificación de compatibilidad%s\n' "$B" "$N"
printf '%sSolo lee información de tu sistema; no cambia nada.%s\n' "$D" "$N"

# ---------------------------------------------------------------- sistema
title 'Sistema'
printf '  %s %s, kernel %s\n' "${PRETTY_NAME:-Linux}" "$(uname -m)" "$(uname -r)"

if [ "$(uname -m)" = x86_64 ]; then
  ok 'Arquitectura x86_64'
else
  fail "Arquitectura $(uname -m): por ahora solo hay paquetes para x86_64"
  blocked=1
fi

glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')
if [ -n "${glibc:-}" ]; then
  if [ "$(printf '%s\n2.35\n' "$glibc" | sort -V | head -1)" = 2.35 ]; then
    ok "glibc $glibc"
  else
    fail "glibc $glibc: hace falta 2.35 o más nueva"
    blocked=1
  fi
else
  fail 'No se encontró glibc (¿musl?): los paquetes no corren aquí'
  blocked=1
fi

case $family in
  arch)  ok 'Familia Arch: se instala con pacman o desde AUR' ;;
  deb)   ok 'Familia Debian/Ubuntu: se instala con apt' ;;
  rpm)   ok 'Familia Fedora: se instala con dnf' ;;
  other) warn "Distro \"$distro_id\" sin repo propio: usa el AppImage" ;;
esac

# ---------------------------------------------------------------- sesión
title 'Sesión gráfica'
session=${XDG_SESSION_TYPE:-}
[ -z "$session" ] && [ -n "${WAYLAND_DISPLAY:-}" ] && session=wayland
[ -z "$session" ] && [ -n "${DISPLAY:-}" ] && session=x11
desktop=${XDG_CURRENT_DESKTOP:-${DESKTOP_SESSION:-desconocido}}

case $session in
  wayland)
    ok "Wayland, escritorio: $desktop"
    if has wayland-info; then
      if wayland-info 2>/dev/null | grep -q zwlr_layer_shell_v1; then
        overlay=yes
        ok 'Tu compositor tiene layer-shell (comprobado)'
      else
        overlay=no
        fail 'Tu compositor no tiene layer-shell (comprobado)'
      fi
    else
      lowered=$(printf '%s' "$desktop" | tr '[:upper:]' '[:lower:]')
      case $lowered in
        *gnome*|*ubuntu*|*pantheon*)
          overlay=no
          fail "$desktop no tiene layer-shell" ;;
        *kde*|*plasma*|*hyprland*|*niri*|*sway*|*river*|*wayfire*|*labwc*|*cosmic*|*mango*)
          overlay=yes
          ok "$desktop tiene layer-shell" ;;
        *)
          warn "No se pudo confirmar si $desktop tiene layer-shell"
          info 'Instala wayland-utils y vuelve a correr esto para saberlo con certeza.' ;;
      esac
    fi
    ;;
  x11)
    overlay=no
    warn 'Sesión X11: la pantalla completa funciona, el overlay no' ;;
  tty|'')
    overlay=unknown
    warn 'No se detectó sesión gráfica: corre esto desde una terminal de tu escritorio'
    ;;
  *)
    overlay=unknown
    warn "Sesión \"$session\" no reconocida" ;;
esac

# ---------------------------------------------------------------- audio
title 'Audio'
if has pw-cli && pw-cli info 0 >/dev/null 2>&1; then
  ok 'PipeWire está corriendo'
else
  if has pw-cli; then
    fail 'PipeWire está instalado pero no corre en esta sesión'
  else
    fail 'PipeWire no está instalado'
  fi
  info 'La app escucha el audio de la compu por PipeWire; PulseAudio solo no alcanza.'
  audio=no
fi

if has pw-record; then
  if [ "$audio" = yes ]; then
    # La misma captura que hace la app, 1 segundo, sin guardar nada.
    bytes=$(timeout 2 pw-record -P '{ stream.capture.sink=true }' --raw --format f32 --channels 1 --rate 48000 - 2>/dev/null | head -c 96000 | wc -c)
    if [ "${bytes:-0}" -gt 0 ]; then
      ok 'Se puede capturar lo que suena (probado 1 segundo, sin guardar nada)'
    else
      fail 'pw-record no devolvió audio'
      info 'Puede ser un PipeWire viejo (hace falta --raw) o no tener salida de audio activa.'
      audio=no
    fi
  fi
else
  warn 'pw-record no está: lo instala el paquete de la app'
fi

# ---------------------------------------------------------------- reproductor
title 'Canción y portada'
if has playerctl; then
  ok 'playerctl presente'
  players=$(playerctl --list-all 2>/dev/null | paste -sd ', ' -)
  if [ -n "$players" ]; then
    ok "Reproductores abiertos: $players"
  else
    warn 'Ningún reproductor abierto ahora mismo'
    info 'No es un problema: abre Spotify u otro y aparecerá la portada.'
  fi
else
  warn 'playerctl no está: lo instala el paquete de la app'
fi

# ---------------------------------------------------------------- gráficos
title 'Gráficos'
if ls /dev/dri/renderD* >/dev/null 2>&1; then
  ok 'Hay aceleración por GPU (/dev/dri)'
else
  warn 'No se ve GPU con aceleración: las escenas pueden ir muy lentas'
fi
if has lspci; then
  lspci 2>/dev/null | grep -Ei 'vga|3d|display' | sed -E 's/^[^ ]+ [^:]+: //' | while read -r gpu; do info "$gpu"; done
fi
if lsmod 2>/dev/null | grep -q '^nvidia ' || [ -e /proc/driver/nvidia/version ]; then
  warn 'Driver propietario de NVIDIA: si la ventana sale negra o en blanco, avísame'
  info 'Prueba: WEBKIT_DISABLE_DMABUF_RENDERER=1 ross-visualizer'
fi
info 'WebGL2 no se puede comprobar desde la terminal; la app lo avisa al abrirse.'

# ---------------------------------------------------------------- bibliotecas
title 'Bibliotecas'
missing_lib=0
for pair in 'libwebkit2gtk-4.1.so.0|WebKitGTK 4.1' 'libgtk-3.so.0|GTK 3' 'libgtk-layer-shell.so.0|gtk-layer-shell' 'libayatana-appindicator3.so.1|icono de bandeja'; do
  so=${pair%%|*}
  name=${pair##*|}
  if lib_present "$so"; then
    ok "$name"
  else
    warn "$name: falta, lo instala el paquete de la app"
    missing_lib=1
  fi
done
[ "$missing_lib" = 1 ] && info 'Estas faltas no son un problema si instalas con apt, dnf o pacman.'

# ---------------------------------------------------------------- instalación
title 'Instalación actual'
if has ross-visualizer; then
  ok "Ya instalado en $(command -v ross-visualizer)"
else
  info 'ross_visualizer todavía no está instalado.'
fi

# ---------------------------------------------------------------- veredicto
verdict() { # etiqueta, estado, detalle
  # printf rellena por bytes y los acentos ocupan dos: se compensa para que la tabla quede alineada.
  local extra width
  extra=$(printf '%s' "$1" | tr -cd '\200-\277' | wc -c)
  width=$((24 + extra))
  case $2 in
    yes)     printf '  %s✓%s %-*s %s\n' "$G" "$N" "$width" "$1" "$3" ;;
    no)      printf '  %s✗%s %-*s %s\n' "$R" "$N" "$width" "$1" "$3" ;;
    unknown) printf '  %s?%s %-*s %s\n' "$Y" "$N" "$width" "$1" "$3" ;;
  esac
}

title 'Veredicto'
if [ "$blocked" = 1 ]; then
  verdict 'La app' no 'no puede correr en este sistema'
else
  verdict 'Ventana y escenas' yes 'debería funcionar'
  if [ "$audio" = yes ]; then
    verdict 'Reacción a la música' yes 'escucha todo lo que suena en la compu'
  else
    verdict 'Reacción a la música' no 'sin PipeWire las escenas se quedan quietas'
  fi
  verdict 'Canción y portada' "$media" 'con cualquier reproductor MPRIS (Spotify, navegador…)'
  case $overlay in
    yes)     verdict 'Overlay' yes 'sobre todas las ventanas, sin bloquear clics' ;;
    no)      verdict 'Overlay' no 'necesita Wayland con layer-shell (KDE, Hyprland, Sway, niri…)' ;;
    unknown) verdict 'Overlay' unknown 'no se pudo confirmar' ;;
  esac
fi

printf '\n%sEs una versión alfa: si algo falla, pega esta salida en%s\n' "$D" "$N"
printf '%shttps://github.com/rossmelabasto/ross_visualizer/issues%s\n' "$D" "$N"

exit "$blocked"
