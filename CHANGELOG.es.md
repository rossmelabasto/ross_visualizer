# Cambios

Todo lo anterior a la 1.0 es alfa: puede tener detalles, y me sirve que me los cuentes en los [issues](https://github.com/rossmelabasto/ross_visualizer/issues).

## 0.1.1

### Novedades

- Fuente de audio en Ajustes. «Todo lo que suena» ahora también escucha las apps que suenan por otra salida: antes, con Discord en el audífono y Spotify en los parlantes, solo se oía Discord. O elige una sola app para que, en una llamada, las voces no muevan las escenas.
- Tutorial de bienvenida la primera vez que abres la app: qué hace, las escenas, el overlay y los atajos de teclado para tu escritorio (niri, Hyprland, Sway o KDE), listos para copiar. Se vuelve a abrir desde Ajustes.
- Botón para volver a la canción anterior en la barra de abajo.
- La escena rOS muestra tu usuario y el nombre de tu compu en el prompt.
- Acciones en el ícono de la app: clic derecho → "Overlay sí/no" o "Siguiente estilo de overlay".
- Los atajos de teclado para cada escritorio, también en repo.rossmel.com y en la documentación.

## 0.1.0

Primera alfa de la app de escritorio para Linux.

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
