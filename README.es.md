# ross_visualizer

**Tu música, hecha luz.** Un visualizer de música en tiempo real para el navegador: los colores salen de la portada y el movimiento sale del sonido.

**Demo → [visualizer.rossmel.com](https://visualizer.rossmel.com)** · [English](README.md)

![Escena Galaxia](docs/screenshots/galaxy.jpg)

## Qué hace

- **Buscas cualquier canción** y suena su vista previa de 30 s (API de búsqueda de iTunes, sin iniciar sesión), mientras las escenas toman la paleta de su portada.
- **O escucha tu propio audio**: el micrófono, el audio de tu PC (en Chrome/Edge, compartiendo pantalla con "Compartir audio"), un archivo local (lee la portada incrustada en las etiquetas MP3/FLAC) o una pista sintetizada que viene incluida.
- **Siete escenas** con transición entre ellas: tinta que la música vierte en el agua (un simulador de fluidos de Navier–Stokes de verdad: cada banda echa su propio color y los beats lanzan chorros), una nebulosa volumétrica de gas brillante y polvo oscuro, una galaxia de 120 mil partículas que cambia entre espiral, barrada, anillo y elíptica, una aurora boreal volumétrica vista desde la orilla de un lago, un caleidoscopio hecho con la portada, un túnel de líneas de contorno con tres versiones para elegir (`V`) y una terminal que dibuja el espectro en ASCII.
- Funciona en el celular: deslizas para cambiar de escena, se instala como PWA y no deja que la pantalla se apague.

No se sube nada: todo el análisis de audio ocurre en tu navegador.

## Cómo funciona

- **Audio** (`src/audio/features.ts`): cuatro bandas con control automático de ganancia, detección de beats por *spectral flux* en el rango del bombo (40–160 Hz) con umbral adaptativo, y tempo estimado con un histograma de intervalos entre golpes.
- **Paleta** (`src/color/palette.ts`): la portada se reduce a 64×64, se agrupa con k-means en **OKLab** (un espacio de color perceptual) y los grupos se puntúan para llenar cinco roles: fondo, primario, secundario, acento y brillo. Las portadas apagadas conservan su tono; las de blanco y negro usan el lima de la marca como acento.
- **Render** (`src/gl/`): WebGL2 con bloom, tonemapping ACES y resolución adaptativa. Los shaders son GLSL ES 3.00 para poder reutilizarlos en Android.

## Correrlo

```sh
npm install
npm run dev      # http://127.0.0.1:5190
npm test
npm run build
```

## Teclas

`1`–`7` escenas · `←`/`→` · `Espacio` reproducir/pausar · `F` pantalla completa · `H` ocultar la interfaz · `V` versión del túnel · `/` buscar

## Lo que viene

- App de escritorio (Tauri) con modo **overlay** transparente y captura nativa del audio del sistema.
- App de Android con modo overlay, leyendo la sesión multimedia del sistema.
- Más escenas.

## Créditos

El simulador de fluidos está adaptado de [WebGL Fluid Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation) de Pavel Dobryakov (MIT). El ruido 3D por textura y el domain warping siguen a [Inigo Quilez](https://iquilezles.org/articles/warp/), y el aspecto de la aurora las notas de Toni Sagristà en [Rendering volume aurorae and nebulae](https://tonisagrista.com/blog/2024/rendering-aurorae-nebulae/).

Hecho por [Rossmel Abasto](https://portfolio.rossmel.com) · Licencia MIT
