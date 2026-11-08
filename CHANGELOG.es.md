# Cambios

Todo lo anterior a la 1.0 es alfa: puede tener detalles, y me sirve que me los cuentes en los [issues](https://github.com/rossmelabasto/ross_visualizer/issues).

## 0.1.0

Primera alfa de la app de escritorio para Linux, para que la prueben mis amigos.

### Novedades

- App de escritorio para Linux: escucha todo lo que suena en la compu, sin elegir fuente de audio y sin iniciar sesión.
- Sigue al reproductor MPRIS que esté sonando (Spotify, un navegador…) para la portada y los botones de reproducir y siguiente.
- Todas las escenas de la web en pantalla completa.
- Overlay sobre todas las ventanas, sin bloquear clics, en siete estilos con sus ajustes: Halo, Horizon, Orbit, Curtain, Embers, rOS rain y Wave.
- Comandos para asignar a atajos de teclado: `ross-visualizer overlay toggle|off|next|prev|<estilo>`.
- Paquetes: repositorio pacman, repositorio APT, repositorio DNF y AppImage.
- Comprobación que te dice qué va a funcionar en tu sistema antes de instalar nada.

### Límites conocidos

- Solo x86_64.
- Necesita PipeWire; PulseAudio solo no alcanza.
- El overlay necesita Wayland con layer-shell (KDE, Hyprland, Sway, niri…). En GNOME o X11 tienes la pantalla completa, sin overlay.
