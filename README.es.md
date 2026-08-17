<h1 align="center">Lasso</h1>

> El "agarre de Claude Code para todo lo que está fuera": buscar, extraer páginas web, extraer páginas con sesión iniciada, controlar el escritorio, todo en una sola frase.
> Lazo de vaquero — captura cualquier interfaz.

<p align="center">
  <img src="https://img.shields.io/npm/v/lasso-mcp">
  <img src="https://img.shields.io/badge/license-MIT-green">
  <img src="https://img.shields.io/badge/MCP-compatible-purple">
</p>

**Instala Lasso una vez en Claude Code, y a partir de ahí buscar, extraer páginas, extraer páginas con sesión iniciada y controlar el escritorio es cosa de una sola frase.** Si cada semana buscas, capturas una página o te mueves entre apps de escritorio — y no quieres una herramienta distinta para cada cosa — instálalo una vez y deja todo en manos de Claude.

Estrella gemela de [media-gen-mcp](https://github.com/wangdong233/media-gen-mcp) (el agarre para imágenes): "cada operación de imagen en un MCP" ↔ "cada interacción externa en un MCP".

<div align="center">

[简体中文](README.md) | [English](README.en.md) | [Deutsch](README.de.md) | **Español** | [Français](README.fr.md) | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

## Tabla de contenidos

- [Lo que dices, lo que obtienes](#lo-que-dices-lo-que-obtienes)
- [💰 Costo de un vistazo](#-costo-de-un-vistazo)
- [Inicio en 60 segundos](#inicio-en-60-segundos)
- [Qué puede hacer por ti](#qué-puede-hacer-por-ti)
- [Instalar](#instalar)
- [Configurar](#configurar)
- [Privacidad y seguridad](#privacidad-y-seguridad)
- [Solución de problemas](#solución-de-problemas)
- [Para quién es / Para quién no](#para-quién-es--para-quién-no)
- [Apoya al autor](#apoya-al-autor)
- [Licencia](#licencia)

---

## Lo que dices, lo que obtienes

| Dices …… | Obtienes |
|---|---|
| "Busca lo último sobre el ecosistema async de rust" | Resultados de búsqueda estructurados (si un motor cae, cambia automáticamente al siguiente — no te enteras) |
| "Busca actualizaciones de Claude Code de la última semana" (v1.11) | Resultados filtrados por frescura vía `freshness=week` — sin fechas escritas a mano en la consulta |
| "Captura el texto de la home de github.com" | Texto limpio del artículo (sin barras de navegación, anuncios ni ruido — ahorras 30–70% en tokens; 20+ sitios de alto tráfico tienen extractores dedicados y las tablas conservan su estructura — v1.12) |
| "Abre mi Jira con sesión iniciada y muéstrame mis pendientes" | Una captura de la página con sesión (reutiliza tu Chrome local; tú gestionas el 2FA) |
| "Este enlace está caído, busca un archivo" | La captura más reciente del Internet Archive |
| "Lista los archivos de mi ventana actual de Finder" | Una lista de ventanas y controles del escritorio (un árbol semántico, no una captura de pantalla; avisa con `truncated:true` si el árbol se corta — v1.12) |
| "Haz clic en ese botón de carpeta nueva" / "Escribe XX en el cuadro de búsqueda" (v1.11) | Acciones de escritorio ejecutadas de verdad (clic/tecdeo semántico AXAPI + verificación del resultado; en canvas/Electron recurre automáticamente a clics por coordenadas) |
| "Haz una captura de pantalla de página completa" / "Guarda como PDF" | Una ruta de archivo en disco (sin volcar un blob gigante de imagen al chat) |
| "¿Qué rastreadores de terceros cargó esta página?" | Una lista de recursos con el conteo por dominio de rastreo |
| "Lista todo lo que puedo controlar ahora mismo" | Una lista unificada (páginas web y ventanas de escritorio, todo junto) |
| "Apaga el modo oscuro" | Clic / tecleo / atajo automatizado (con verificación del resultado — confirma que realmente ocurrió) |
| "Solo obtén este endpoint JSON" | Bytes crudos (lo más rápido y barato) |
| "Este sitio parece tener algo de anti-bot, prueba" | `browse_headless` trae anti-detección integrada (pasa los checks básicos) — muchos sitios se extraen directamente, sin configurar nada |
| "Este sitio tiene Cloudflare, no puedo extraerlo" | Anti-bot de Chrome en la nube — **Steel autoalojado (gratis)** o browserbase/stagehand (de pago, desactivado por defecto) |
| "¿Lasso está bien configurado?" | Un reporte de salud (te dice qué falta) |

> No necesitas memorizar nombres de capacidades. Solo di lo que quieres — Claude elige la forma correcta de hacerlo.

---

## 💰 Costo de un vistazo

Lasso en sí es **completamente gratis + open source MIT**. Esto es lo que realmente cuesta cada capacidad:

| Capacidad | Costo | Notas |
|---|---|---|
| Lasso en sí (servidor MCP + todas las capacidades centrales) | ✅ Gratis | Open source MIT, gratis para siempre |
| Búsqueda (Zhipu + Brave + Bing) | ✅ Tier gratis disponible | Zhipu se factura por token; Brave **2.000 consultas/mes gratis**, Bing **1.000 consultas/mes gratis** — se puede usar sin pagar. **¿Ya tienes configurado el MCP `web-search-prime` de Zhipu en tu máquina? Lasso lo detecta y lo reutiliza automáticamente — ni siquiera necesitas configurar un ZHIPU_API_KEY aparte** |
| Extraer páginas públicas / capturas de pantalla / PDF / auditoría de red / bytes crudos | ✅ Gratis | Se ejecuta en local, sin key, sin pago |
| Extraer páginas con sesión iniciada (reutiliza Chrome local) | ✅ Gratis | Se ejecuta en local, sin key, sin pago |
| Controlar el escritorio (macOS / Windows / Linux) | ✅ Gratis | Construido y ejecutado en local, solo necesita autorización del SO; **opcional** cuenta Apple Developer de \$99/año para autorización firmada persistente (también funciona sin firmar — solo hay que reautorizar cada vez) |
| Navegador en la nube · Steel autoalojado (v1.6 nuevo) | ✅ Gratis | Steel (open source Apache-2.0) en Docker local — **cero coste por sesión + las cookies nunca salen de tu máquina**; requiere `LASSO_ALLOW_CLOUD_BROWSER=true` + `STEEL_ENDPOINT=http://localhost:3000` |
| Navegador en la nube · alojado (browserbase / stagehand) | ⚠️ De pago, desactivado por defecto | browserbase pasa a pago por uso tras la prueba; stagehand es un canal experimental programático (sin entrada de herramienta MCP); **sin configurar no cuesta nada** |
| Anti-detección de `browse_headless` (v1.5 nuevo) | ✅ Gratis | Inyecta por defecto 16 capas de anti-detección (UA / webdriver / webgl, etc.) — pasa muchos checks básicos de bots sin configurar nada |

> En una frase: **mientras no actives el navegador en la nube alojado (browserbase/stagehand), Lasso cuesta cero de principio a fin** — la búsqueda tiene tiers gratis suficientes para el uso diario, y Steel autoalojado también es gratis.

---

## Inicio en 60 segundos

### 30 segundos · Instalación en una línea (cero configuración)

```bash
claude mcp add lasso -- npx -y lasso-mcp
```

Reinicia Claude Code → escribe `/mcp` → verás `lasso ✓ Connected`. Listo. **Sin keys en el comando de instalación** — la configuración es un paso aparte (siguiente nivel).

### 30 segundos · Sin nada configurado, ya puedes hacer todo esto

No necesitas keys justo después de instalar (esto es **Tier 1: cero configuración**):

- Extraer el texto de cualquier **página web pública**, convertido a markdown limpio
- **Capturas de pantalla de página completa** y **guardar como PDF**, devolviendo una ruta de archivo
- Ver **qué rastreadores de terceros carga una página**
- Obtener bytes crudos directamente de una API JSON o un archivo
- Controlar apps nativas de macOS (Finder / Mail / System Settings, etc. — requiere un tic una vez en System Settings)

> 💡 **La búsqueda también puede funcionar sin configurar nada**: si tu `~/.claude.json` ya tiene configurado el MCP `web-search-prime` de Zhipu, Lasso lo detecta y lo reutiliza al arrancar — ni siquiera necesitas un `ZHIPU_API_KEY` aparte, la búsqueda simplemente funciona. Ejecuta `lasso doctor` y mira si `#36 machine_search_mcp` está en `pass`.

Tu primer output — simplemente dile a Claude:

> "Captura el texto de example.com y conviértelo a markdown"

### ¿Quieres más? Añádelo en el archivo de configuración (Tier 2)

- **Búsqueda** → ejecuta `lasso config init` para crear `~/.lasso/config.json`, luego rellena una key de Zhipu (ver [Configurar](#configurar))
- **Extraer páginas con sesión iniciada** (Jira / GitHub privado / intranet de la empresa) → ejecuta `lasso launch-chrome` una vez
- **Controlar el escritorio de macOS** → ejecuta `lasso doctor` una vez para que te guíe por la autorización

Cómo obtener cada key, qué tiers gratis hay — ver la [**Guía de configuración de keys**](./doc/KEY-GUIDE.md).

---

## Qué puede hacer por ti

Agrupado por **lo que quieres hacer**, no por nombre de herramienta. Cada uno: una frase de entrada, una frase de salida.

### Búsqueda

> Tú: "Busca X" → resultados estructurados de búsqueda

Por defecto Zhipu (fuerte para chino); puedes añadir Brave y Bing para multi-fuente. **Si una fuente está con rate-limit o caída, cambia automáticamente a la siguiente — no te enteras.** Agotar la cuota gratis de un proveedor no rompe todo el conjunto.

Para contenido sensible al tiempo como **noticias y seguimiento de versiones**, di directamente "busca X de la última semana / del último mes" — el filtro de frescura (day / week / month / year, en todos los motores — solo Bing no tiene granularidad de «año» y la omite, v1.11) se aplica automáticamente, sin fechas escritas a mano en la consulta.

### Extraer páginas públicas (sin login)

> Tú: "Captura el texto de example.com" → texto limpio del artículo, tres granularidades disponibles

Elimina automáticamente barras de navegación, anuncios, barras laterales y demás ruido — **ahorra 30–70% en tokens** (y dinero). GitHub / Reddit / Hacker News / Wikipedia / Substack / Medium y otros **sitios de alto tráfico — más de 20 en total — tienen extractores dedicados**, así que las tablas y las fórmulas matemáticas tampoco pierden su estructura (v1.12) — y cada enlace del texto es una dirección absoluta totalmente clicable. ¿Necesitas marcadores de cita (ideal para investigación, para alimentar RAG)? Una frase cambia de modo.

> **Desde v1.5, `browse_headless` trae la anti-detección activada por defecto** (UA camuflado / `navigator.webdriver` eliminado / webgl, plugins y codecs falsificados, y una docena de capas más). **Sin configuración — automático.** Muchos sitios que "detectan headless" ahora se extraen directamente (v1.8 corrigió un defecto por el que la inyección fallaba en silencio — ahora surte efecto de verdad, y las inyecciones fallidas se reportan con honestidad en el log). Desde v1.11 la anti-detección se aplica **en la capa de arranque del navegador**: UA, viewport e idioma se emiten juntos desde el perfil, así que la cabecera HTTP de red y el JS de la página ven los mismos valores — sin contradicciones. Desde v1.12 la huella por defecto en macOS **se alinea con tu sistema** (adiós al "el UA dice Windows pero los rasgos de la máquina delatan macOS"). Solo el anti-bot pesado tipo Cloudflare necesita el navegador en la nube (ver "Esquivar anti-bot" más abajo). ¿Quieres verificar el efecto de la anti-detección? Ejecuta `lasso doctor --stealth-check` para una comparación con creepjs.

### Extraer páginas con sesión iniciada (incluso con 2FA)

> Tú: "Muéstrame mis pendientes de Jira" → captura de la página con sesión

Reutiliza **tu Chrome con sesión iniciada en local** — tú gestionas el 2FA una vez; Lasso se encarga del resto. Funciona para repos privados de GitHub, intranets de empresa, contenido de suscripción de pago, etc.

> 🔴 **Línea roja**: Lasso **nunca resuelve 2FA / códigos SMS / CAPTCHA / magic links por ti**. Debes pasarlos manualmente una vez en tu Chrome local.

### Obtener bytes crudos (lo más rápido y barato)

> Tú: "Haz GET a este endpoint JSON" → bytes crudos

Cuando no necesitas renderizar una página completa, HTTP directo es **~4× más rápido y ~4× más barato** que pasar por un navegador. Detecta automáticamente el tipo de contenido (JSON / texto / binario).

### Captura de pantalla / Archivo

> Tú: "Haz una captura de página completa" / "Guarda como PDF" → ruta del archivo en disco

Todas las imágenes y PDFs se **guardan en disco y se devuelve una ruta** — sin volcar un blob gigante al chat para desperdiciar contexto. Las salidas de texto sobredimensionadas (fetch_url / network, etc.) que superen los 48 KiB también se escriben automáticamente en disco, devolviendo una vista previa más un manejador de continuación `@oN` — pásalas por páginas con la herramienta `read_text` (llamable directamente por MCP desde v1.8).

### Ver qué carga una página

> Tú: "¿Qué rastreadores de terceros cargó esta página?" → lista de recursos con conteo por dominio

Identifica automáticamente cada recurso que carga la página, agrupado por dominio de terceros — útil para detectar riesgos de privacidad y cuellos de botella de rendimiento. Desde v1.11, la captura de recursos va directa a la capa de red nativa del motor del navegador — **completa incluso bajo redes proxy / TUN** — y cada recurso lleva su método de petición y su código de estado.

### Controlar apps nativas del escritorio

> Tú: "Apaga el modo oscuro" / "Lee el primer elemento de mi bandeja de Mail" → acción automatizada (con verificación)

En macOS puedes manejar Finder / Mail / Safari / Notes / System Settings y cualquier app nativa. **Windows y Linux también funcionan** (ver límite honesto más abajo). Cada acción se verifica — confirma que "realmente ocurrió", nunca finge éxito.

> **Límite honesto**: macOS está verificado en hardware real; Windows / Linux pasan auto-verificaciones a nivel compilación y de contrato, pero las pruebas manuales completas en máquina real siguen en curso. **No simulamos "totalmente verificado en Win/Linux".**

### Planificación unificada entre web y escritorio

> Tú: "Lista todo lo que puedo controlar ahora mismo" → una lista unificada

Páginas web y ventanas de escritorio comparten una sola lista — no tienes que distinguir "esto está en el navegador" vs "esto está en el escritorio". Claude elige sobre qué actuar, y de ahí fluye todo.

### Revivir enlaces caídos

> Tú: "Este enlace da 404" → la captura más reciente del Internet Archive

Acude al Internet Archive (Wayback Machine) para encontrar la última copia archivada de esa URL. **Nunca trata un enlace vivo como caído** — solo busca cuando dices "esto ya no está".

### Esquivar anti-bot (desactivado por defecto)

> Tú: "Este sitio tiene Cloudflare, no puedo extraerlo" → anti-bot de Chrome en la nube

**Completamente desactivado por defecto.** Solo se activa cuando lo enciendes explícitamente Y has configurado un navegador en la nube (Steel autoalojado o browserbase/stagehand alojado). El anti-bot ligero ya lo cubre la anti-detección integrada de `browse_headless` — **solo la protección pesada tipo Cloudflare necesita el navegador en la nube**.

- **Steel autoalojado (recomendado · gratis)**: un navegador en la nube open source en Docker local — cero coste por sesión, las cookies nunca salen de tu máquina. Se abre con un comando, ver [Guía de keys · Steel](./doc/KEY-GUIDE.md#steel_endpoint--自托管云浏览器v16-新推荐免费).
- **browserbase (alojado · de pago)**: pago por uso tras la prueba; la alternativa cuando no quieres ejecutar Docker tú mismo.
- **stagehand (alojado · de pago)**: ⚠️ canal experimental programático — configurar su key solo monta un canal interno, **no hay entrada de herramienta MCP** (el contrato REST no está verificado; `lasso doctor` #39 `stagehand_rest_contract_probe` prueba exactamente eso).

---

## Instalar

**Versión actual v1.13.0** (v1.13 — 7 ajustes de la capa de implementación (3.ª ronda de revisión de optimalidad): **huella de idioma consistente en el navegador headless** — la cabecera HTTP `Accept-Language` ahora se emite según el perfil stealth (antes enviaba el valor real del host, así que un perfil en inglés en una máquina china delataba la contradicción "cabecera zh-CN ↔ página en-US"); `navigator.languages` ahora también es consciente del perfil; **corregido el punto de aterrizaje del VLM en capturas por región** — en escenarios `screenshot_region`, las coordenadas inferidas por el VLM se convierten de vuelta a coordenadas de pantalla completa (antes había un desplazamiento sistemático del origen de la región — y además reportaba éxito); **`desktop find` rechaza consultas de solo ref** — `where` solo acepta text/role; una consulta de solo ref ahora reporta honestamente `invalid_params` (antes degeneraba en silencio a un match de todo el árbol — explosión de tokens disfrazada de éxito); **salida más rápida y estable** — la liberación de sesiones Steel ahora tiene un tope de 3 segundos (con Steel autoalojado colgado, la salida de Claude Code ya no se cuelga hasta 5 minutos); si falta el permiso de macOS para síntesis de entrada, el nivel VLM ahora reporta claramente "se necesita autorización" en vez de fallar de forma vaga. v1.12 — 14 ajustes de la capa de implementación (2.ª ronda de revisión de optimalidad): **extracción markdown de doble activación** — extractores específicos por sitio de defuddle (HN/Reddit/GitHub/Wikipedia/Substack/Medium, 20+ sitios en total) + conversión fiel de estructura de tablas/matemáticas (las tablas GFM ya no pierden estructura; los enlaces relativos se absolutizan automáticamente; la salida puede contener dialectos de Obsidian como `==resaltado==` y notas al pie `[^N]`); **la huella por defecto del navegador headless se alinea con el sistema anfitrión** — en macOS el valor por defecto es una huella de Chrome para macOS (elimina la contradicción "el UA dice Windows, los client hints delatan macOS"; `doctor` avisa de la desviación de versión respecto a tu Chrome instalado); **cola del escritorio honesta** — la inferencia por captura del VLM ya no finge éxito (ejecuta cuando puede, reporta unknown honesto cuando no), `wait/expect` exigen dos aciertos consecutivos (los elementos que parpadean al cargar ya no cuentan como éxito), `snapshot` reporta `truncated:true` en el nivel superior al cortarse, `find` adjunta a los nodos encontrados una lista de acciones ejecutables; **fix de campos de entrada en Electron** — los controles que se tragan AXSetValue (Slack/VSCode, etc.) degradan `type` automáticamente a "foco + teclado sintético" (ASCII); **arrastrar y soltar pasa a ser utilizable** — 200 ms de pulsación + trayectoria interpolada de 12 puntos + 100 ms de asentamiento (los sliders y el drag-para-ordenar pasaron de fallar casi siempre a funcionar); **freshness consistente en toda la cadena** — machine_mcp y el fallback de DuckDuckGo ya no descartan en silencio el parámetro de frescura; si Claude Code termina de forma anómala, el proceso de Lasso se cierra de inmediato (antes podía quedar colgado hasta una hora). v1.11 — se cerró la brecha de implementación del "agarre para todo": **el escritorio pasa de observar a actuar** — click/type/scroll de `desktop` ahora se ejecutan de verdad (clic semántico AXAPI + verificación escribir-then-leer + errores honestos por referencias caducadas), más acciones de ratón por coordenadas (arrastrar/rueda/mover como fallback de canvas/Electron) y poda del árbol `skeleton` (gran ahorro de tokens en apps densas); **capa driver actualizada chrome-devtools-mcp 0.3.0 → 1.7.0** (11 meses / 57 releases; stealth de UA/viewport a nivel de arranque; telemetría upstream desactivada por defecto); **la búsqueda ganó un filtro temporal `freshness`** (day/week/month/year se pasa a todos los motores — sin escribir fechas a mano en las consultas para noticias/versiones); el fallback sin key para inglés pasó de Baidu a DuckDuckGo; nuevo proxy de salida `LASSO_PROXY` para navegadores (afecta solo a headless/nube — el tráfico de tu Chrome con sesión no se toca). v1.10 — navegadores silenciosos por defecto y cerrados al acabar: `launch-chrome` arranca por defecto con cero ventanas y cero molestias (adaptado a macOS/Windows, `--mode visible` recupera el comportamiento antiguo), siempre con anti-throttling en segundo plano y silencio, y mientras el servidor corre se cierra solo ~60 s tras su último uso (ajustable con `LASSO_LAUNCH_IDLE_MS`; el comportamiento de 5 minutos se conserva como `300000`). v1.9 — cierre del ciclo de vida de navegadores: el navegador headless se recicla automáticamente tras 5 minutos de inactividad, `lasso chrome-stop` cierra los Chrome que Lasso lanzó (según su registro), `tab_restore` restaura tu lista original de pestañas — ver "cerrar al terminar" más arriba. v1.8 — corregidos los 24 defectos destapados por el test de campo completo: adaptación al contrato upstream chrome-devtools-mcp@0.3.0, capturas que de verdad aterrizan en disco, sondeo de launch-chrome, conexión de cuotas por llamada, la herramienta de paginación `read_text` y más — lista completa en el "registro de fixes v1.8" de [doc/17-功能测试清单.md](doc/17-功能测试清单.md).)

**Requisitos previos**: Node.js ≥ 20; Claude Code (o cualquier cliente compatible con MCP).

```bash
# Claude Code (recomendado)
claude mcp add lasso -- npx -y lasso-mcp
```

Reinicia Claude Code → `/mcp` → `lasso ✓ Connected`. **Eso es todo — sin keys en el comando de instalación.** Navegación / capturas de pantalla / PDF / control de escritorio funcionan de inmediato (la búsqueda es la única excepción — ver [Configurar](#configurar)).

**Usuarios de macOS que quieren control del escritorio**: ejecuta `lasso doctor` una vez y sigue las indicaciones para marcar `lasso-rust-helper` bajo "System Settings → Privacy & Security" tanto en Accessibility como en Screen Recording (`doctor` te guía — no hace falta que busques la ruta tú mismo).

---

## Configurar

**Instalar es cero-config** — el comando de instalación de arriba ya habilita navegación / fetch / capturas de pantalla / PDF / inspección de recursos de terceros / control del escritorio. **Solo la búsqueda requiere key.**

### Busca por lo que quieres hacer

| Lo que quieres | Qué configurar | Qué desbloquea |
|---|---|---|
| Extraer páginas públicas / capturas / PDF / ver rastreadores / obtener bytes crudos / controlar escritorio | **Nada** | Funciona justo después de instalar |
| Búsqueda | Una key de Zhipu (gratis solicitarla) | La entrada principal de búsqueda |
| Fallos de búsqueda casi nulos (multi-fuente) | Añadir keys de Brave / Bing (ambas con tier gratis) | Auto-failover si una cae — no te enteras |
| Extraer páginas con sesión iniciada | Ejecutar `lasso launch-chrome` una vez | Reutiliza tu sesión de Chrome local |
| Controlar el escritorio de macOS | Ejecutar `lasso doctor` una vez | Controlar apps nativas |
| Extraer sitios protegidos por Cloudflare | Doble confirmación + un canal de navegador en la nube (Steel autoalojado gratis / alojado de pago) | Desactivado por defecto; necesita tu opt-in explícito |

A continuación, cada uno de los cuatro módulos se desglosa con el camino más corto a "simplemente funciona".

### 1. Búsqueda (✅ Gratis · tier gratis; una key para empezar, tres para fallos casi nulos)

**Qué hace**: Busca cualquier cosa, devuelve resultados estructurados (título, snippet, enlace).

**¿Necesita key**: Sí — pero si tu máquina ya tiene configurado el MCP `web-search-prime` de Zhipu (en tu `~/.claude.json` local bajo `mcpServers`, con type=http + Authorization), **Lasso detecta esa key al arrancar y la reutiliza como primera fuente de búsqueda — ni siquiera necesitas configurar un ZHIPU_API_KEY aparte**. Si el MCP de la máquina está con rate-limit o falla, se degrada automáticamente a la key propia de Lasso (rellénala abajo). Ejecuta `lasso doctor` y mira si `#36 machine_search_mcp` está en `pass` (host=open.bigmodel.cn) o en `warn` (no detectado).

> Prioridad sin configuración: reutilización del MCP de la máquina → `ZHIPU_API_KEY` propio de Lasso → Brave → Bing → fallback de `browse_headless`. Si el primero falla, cambia automáticamente al siguiente — no te enteras.

**Cómo configurar** (solo si la máquina no tiene el MCP de Zhipu / quieres una key independiente):

```bash
lasso config init        # crea la plantilla ~/.lasso/config.json
lasso --version          # muestra el número de versión (desde v1.8)
lasso --help             # uso de todos los subcomandos
```

> Desde v1.8 la línea de comandos sigue las convenciones habituales: subcomandos o argumentos desconocidos imprimen el uso y terminan con código distinto de cero — ya no cae en silencio al modo servidor MCP quedándose esperando entrada.

Abre `~/.lasso/config.json` y rellena:

```json
{
  "ZHIPU_API_KEY": "your_zhipu_key"
}
```

**¿Quieres más robustez** (muy recomendable): añade también Brave y Bing — ambas tienen tier gratis. Si una fuente está con rate-limit o caída, cambia automáticamente a la siguiente y no te enteras:

```json
{
  "ZHIPU_API_KEY": "your_zhipu_key",
  "BRAVE_API_KEYS": "bravekey1,bravekey2,bravekey3",
  "BING_API_KEYS": "bingkey1,bingkey2"
}
```

> Separa varias keys con comas — N keys te dan N× la cuota gratis, rotadas automáticamente.

Los nombres de las keys coinciden con lo que aparece en la tabla de arriba — solo rellénalas. Guarda el archivo; Lasso lo carga en el próximo arranque.

**Cómo solicitar keys, cuotas del tier gratis, detalles de rotación multi-key** → ver la [Guía de configuración de keys · Búsqueda](./doc/KEY-GUIDE.md#a-搜索).

### 2. Extraer páginas con sesión iniciada (✅ Gratis · sin key, ejecuta un comando)

**Qué hace**: Extrae páginas en las que tienes sesión iniciada — pendientes de Jira, repos privados de GitHub, intranets de empresa, contenido de suscripción de pago.

**¿Necesita key**: No.

**Cómo configurar**: Ejecuta el comando de abajo una vez. Encuentra automáticamente tu Chrome local y lo arranca con puerto de depuración. Desde v1.8 usa por defecto un **perfil independiente propio de Lasso** (Chrome 136+ prohíbe abrir el puerto de depuración en el perfil por defecto — el método antiguo se cerraba al instante); inicia sesión en tus cuentas una vez en esa ventana (el 2FA tú mismo), y a partir de ahí **la sesión de ese perfil se reutiliza siempre**:

```bash
lasso launch-chrome
```

Tras el arranque, Lasso sondea el puerto de depuración (una verificación a nivel `curl /json/version`): si Chrome no levantó o el puerto está ocupado, da un **error claro** en vez de "devuelve éxito pero no conecta". Para reutilizar un directorio de perfil existente: `lasso launch-chrome --profile <directorio>`.

**Desde v1.10 este Chrome "trabaja en silencio" por defecto**: arranca con **cero ventanas, sin robar tu foco de teclado/ventana y siempre silenciado** — tú sigues escribiendo código en primer plano mientras él extrae páginas en segundo plano (el único rastro visible es un icono extra de Chrome en el Dock / la barra de tareas, imposible de quitar a nivel de sistema operativo). ¿Quieres verlo trabajar? Usa `lasso launch-chrome --mode visible` (o pon `"LASSO_LAUNCH_MODE": "visible"` en `~/.lasso/config.json`).

Después, dile "abre mi Jira con sesión iniciada" a Claude y se conectará solo.

> 🔴 **Línea roja**: 2FA / códigos SMS / CAPTCHA / magic links — Lasso nunca resuelve esto por ti. Debes pasarlos manualmente una vez en tu Chrome local.

**Cerrar al terminar (desde v1.10, casi automático)**: mientras el servidor corre, este Chrome **se cierra solo en ~60 s tras su último uso** (terminado-uso — nada que esperar, nada que recordar). Para ajustar el umbral: `LASSO_LAUNCH_IDLE_MS=300000` recupera el comportamiento de 5 minutos, `=1000` roza lo instantáneo (a costa de un nuevo arranque en frío de ~11 s cuando haya pausas algo más largas), `=0` desactiva el autocierre. Para una tarea larga puntual: `lasso launch-chrome --idle-ms 3600000`. También puedes cerrarlo manualmente en cualquier momento (solo los que Lasso lanzó él mismo, con propiedad verificada — jamás tus navegadores abiertos a mano):

```bash
lasso chrome-stop          # cierra todos los Chrome que Lasso lanzó (según su registro)
lasso chrome-stop --port 9222   # cierra solo el del puerto indicado
```

> Límite honesto: al ejecutar `lasso launch-chrome` suelto (sin servidor) no hay autocierre por inactividad — la salida sigue siendo `chrome-stop`. Que `browse_logged_in` se conecte a **tu propio Chrome visible** es "baja molestia, no cero molestia" (una limitación de la plataforma macOS; alguna operación puntual puede robar el foco una vez) — para silencio puro usa el nivel oculto del propio Lasso o `browse_headless`; el canal `desktop` simula el teclado y el ratón de una persona real, así que **ocupa el teclado/ratón físicos por diseño** — no existe una forma silenciosa.

Las pestañas que `browse_logged_in` abre en tu Chrome se cierran y tu lista original de pestañas se restaura cuando al terminar una tarea dices `admin {action:"tab_restore", reason:"tarea completada"}` (lo mismo ocurre automáticamente al salir del servidor). El navegador headless, por su parte, **se recicla automáticamente tras 5 minutos sin uso** en vez de quedarse ocupando memoria — para usos frecuentes seguidos: `LASSO_HEADLESS_IDLE_MS=3600000` (1 hora) ahorra arranques en frío; `0` lo desactiva por completo.

**Detalles** → [Guía de configuración de keys · Navegación con sesión](./doc/KEY-GUIDE.md#b-登录态浏览命令行配置无-key).

### 3. Controlar el escritorio (✅ Gratis · sin key, autoriza una vez en tu SO)

**Qué hace**: Maneja apps nativas en macOS / Windows / Linux (clic, teclear, leer contenidos de ventanas, lanzar atajos).

**¿Necesita key**: No.

**Cómo configurar** (elige tu SO):

- **macOS**: Ejecuta `lasso doctor` una vez y sigue las indicaciones para marcar `lasso-rust-helper` bajo "System Settings → Privacy & Security" tanto en **Accessibility** como en **Screen Recording**. `doctor` te guía paso a paso — no hace falta que busques la ruta.
- **Windows**: La primera vez que pidas a Claude una acción de escritorio, el sistema muestra un diálogo de autorización — haz clic en "Allow" (equivalente a Accessibility en macOS).
- **Linux**: Asegúrate de que la interfaz de accesibilidad esté instalada (la mayoría de escritorios GNOME / MATE la traen por defecto; si no, `sudo apt install at-spi2-core`).

> **Límite honesto**: macOS está verificado en hardware real; Windows / Linux pasan auto-verificaciones a nivel compilación y de contrato, pero las pruebas manuales completas en máquina real siguen en curso. **No simulamos "totalmente verificado en Win/Linux".**

**Detalles** → [Guía de configuración de keys · Control de escritorio](./doc/KEY-GUIDE.md#c-桌面控制系统授权无-key).

### 4. Navegador en la nube: autoalojado o alojado (autoalojado gratis / alojado de pago, desactivado por defecto · necesita doble confirmación)

**Qué hace**: Extrae sitios protegidos por Cloudflare o con protección anti-bot fuerte (el anti-bot ligero ya lo cubre la anti-detección integrada de `browse_headless` — esta sección es solo para los casos duros).

**¿Necesita key**: Depende del camino que elijas. Uno de tres canales de nube — **solo el camino alojado necesita key**:

- **(a) Steel autoalojado (recomendado · gratis)**: un navegador en la nube open source en Docker local — **cero coste por sesión + las cookies nunca salen de tu máquina**. No hay key que solicitar; simplemente ejecuta Docker tú mismo.
- **(b) browserbase alojado (de pago)**: 100 minutos de prueba, luego pago por uso.
- **(c) stagehand alojado (de pago)**: observación de páginas amigable con IA, más para probar. ⚠️ **Canal experimental programático** — incluso con la key configurada **no hay entrada de herramienta MCP** (el contrato REST no está verificado en runtime; `lasso doctor` #39 prueba exactamente esto); para pasar de verdad el anti-bot, elige Steel o browserbase.

**Cómo configurar**: Deben cumplirse ambas condiciones al mismo tiempo:

1. Interruptor maestro: pon `LASSO_ALLOW_CLOUD_BROWSER` a `true`
2. Al menos un canal de nube — Steel (pon `STEEL_ENDPOINT`) o browserbase (pon su key); una key de stagehand solo monta el canal experimental interno y no expone herramientas

**Configuración mínima · Steel autoalojado (gratis, recomendado)**:

```json
{
  "LASSO_ALLOW_CLOUD_BROWSER": true,
  "STEEL_ENDPOINT": "http://localhost:3000"
}
```

Steel arranca con un comando de Docker: `docker run -p 3000:3000 -p 9223:9223 ghcr.io/steel-dev/steel-browser`. Pasos completos de apertura en [Guía de keys · Steel](./doc/KEY-GUIDE.md#steel_endpoint--自托管云浏览器v16-新推荐免费).

**Configuración mínima · browserbase alojado (de pago)**:

```json
{
  "LASSO_ALLOW_CLOUD_BROWSER": true,
  "BROWSERBASE_API_KEY": "your_browserbase_key"
}
```

> Desactivado por defecto — sin configuración no hay tal capacidad. No lo necesitas para páginas normales, **y solo se activa cuando tú lo pides explícitamente**. El anti-bot ligero no necesita ningún navegador en la nube — la anti-detección integrada de `browse_headless` lo resuelve.

**Cómo solicitar keys alojadas, cómo abrir Steel con Docker** → ver la [Guía de configuración de keys · Navegador en la nube](./doc/KEY-GUIDE.md#d-云浏览器反爬默认关双重解锁).

<details>
<summary><b>Ajuste avanzado (opcional — usuarios comunes pueden omitirlo)</b></summary>

Puedes **ignorar por completo** lo siguiente para el uso diario. Solo aplica a escenarios especiales, y la mayoría se puede establecer vía `lasso config init` en `~/.lasso/config.json` o sobrescribir con variables de entorno (las variables de entorno tienen prioridad sobre el archivo de configuración, útil para cambios temporales):

- Cambiar el puerto de depuración del Chrome con sesión (cuando el `9222` por defecto está ocupado)
- Mover los archivos de caché / estado a otra ubicación
- Restringir solo a fuentes de búsqueda gratis
- Permitir intranet de empresa / rangos de proxy especiales
- Definir tu propia frase para cifrar las cookies de sesión (si no se define, se usa macOS Keychain)
- Guardar capturas de resultados de búsqueda en disco (para pruebas de regresión)
- Ajustar el tiempo de autoreciclaje por inactividad del navegador headless (`LASSO_HEADLESS_IDLE_MS`, por defecto 5 minutos; `0` lo desactiva)
- Ajustar el tiempo de "cerrar al terminar" del Chrome lanzado por launch-chrome (`LASSO_LAUNCH_IDLE_MS`, por defecto 60 s; `300000` recupera 5 minutos, `0` desactiva) o volver al arranque visible (`LASSO_LAUNCH_MODE=visible`)
- Configurar un proxy de salida para los navegadores (`LASSO_PROXY`, p. ej. `http://127.0.0.1:7890`; **afecta solo al navegador headless y al Steel en la nube — el tráfico de tu Chrome con sesión se mantiene siempre igual** — v1.11)
- Fijar el endpoint del navegador en la nube Steel autoalojado (`STEEL_ENDPOINT`, p. ej. `http://localhost:3000`; para activarlo se necesita también `LASSO_ALLOW_CLOUD_BROWSER=true`)

Lista completa de variables y sus valores por defecto: [Guía de configuración de keys · Ajuste avanzado](./doc/KEY-GUIDE.md#e-高级调优可选全不配). **Las redes proxy TUN de Surge / Clash (fake-ip, `198.18.0.0/15`) y `127.0.0.1` (usado por el puerto de depuración CDP del Chrome local) ya están permitidas por defecto** — no hace falta configurar nada más. Es comportamiento de diseño, no una configuración que falte.

> **Compatible hacia atrás**: si ya habías instalado con `claude mcp add -e KEY=VAL`, esas variables de entorno **siguen funcionando** y **tienen prioridad** sobre el archivo de configuración. El archivo de configuración es solo una vía adicional y más amable — no reemplaza a las variables de entorno.

</details>

---

## Privacidad y seguridad

Tus datos son tuyos.

- **Las cookies de sesión nunca se exportan**, salvo que tú lo actives explícitamente y las cifres en disco. Lasso nunca envía tu estado de sesión a ningún sitio en secreto.
- **Los logs de acciones de escritorio se quedan en local** — cero reportes remotos. Lasso no "llama a casa" con lo que haces.
- **El navegador en la nube está desactivado por defecto** — requiere tu **doble confirmación explícita** (interruptor maestro + key) para activarse. Sin eso, la capacidad directamente no existe.
- **Sin resolución de 2FA / CAPTCHA / códigos de verificación** (línea roja). Estos siempre te requieren a ti, en persona, pasarlos una vez en tu navegador local.
- **Nadie puede tocar tus servicios internos** — el acceso a la red interna se deniega por defecto; las redes proxy TUN de Surge / Clash ya están permitidas por defecto.
- **Los resultados de búsqueda no se escriben en disco por defecto** — solo si tú activas explícitamente el modo de grabación (para pruebas de regresión).

---

## Solución de problemas

**Para cualquier problema, el primer paso es siempre `lasso doctor`.** Se autocomprueba y te dice qué está mal configurado.

| Síntoma | Qué hacer |
|---|---|
| El control del escritorio en macOS no funciona | Marca `lasso-rust-helper` bajo "System Settings → Privacy & Security → Accessibility / Screen Recording" (`lasso doctor` te guía) |
| La extracción de página con sesión falla | Inicia sesión una vez manualmente en tu Chrome local (también el 2FA), luego di "abre mi X con sesión iniciada" |
| Guardar como PDF falla | Di mejor "haz una captura de pantalla de página completa de esta página" |
| La búsqueda no devuelve nada | Comprueba si la key caducó / la cuota se agotó; añadir varios proveedores (Zhipu + Brave + Bing) reduce drásticamente la tasa de fallo |
| Un enlace no abre | Di "este enlace está caído, busca un archivo" para consultar el Internet Archive |
| Aparece que el acceso a la red interna fue bloqueado | Revisa la URL; las redes proxy TUN están permitidas por defecto, otras redes internas necesitan permiso explícito |
| Verificar el efecto de la anti-detección | Ejecuta `lasso doctor --stealth-check` — maneja la página de detección creepjs y compara contra una línea base (opcional, no afecta el uso diario) |

FAQ completo y tips de depuración en [`doc/TROUBLESHOOTING.md`](./doc/TROUBLESHOOTING.md).

---

## Para quién es / Para quién no

**Para**

- **Usuarios intensivos de Claude Code** — buscan, extraen y controlan el escritorio cada semana, y no quieren instalar un MCP distinto para cada cosa
- **Investigadores / redactores de informes / gente de datos** — buscar, capturar texto limpio, revivir enlaces caídos, de extremo a extremo
- **Quien construye RAG / bases de conocimiento** — páginas web a markdown limpio, con marcadores de cita, ahorrando tokens y dinero
- **Gente de automatización / DevOps** — manejar apps nativas de macOS, extraer dashboards internos con sesión iniciada
- **Cualquiera que extrae a menudo páginas con sesión iniciada** — reutilizar la sesión local de Chrome, sin volver a guardar credenciales en la configuración

**No para**

- **Quien no usa Claude Code u otro cliente MCP** — Lasso es un servicio MCP y necesita un cliente MCP que lo maneje
- **Quien solo necesita una capacidad y ya tiene solución dedicada** — el todo-en-uno puede ser redundante
- **Quien busca esquivar 2FA / CAPTCHA** — línea roja; no lo hacemos, y no lo haremos.

---

## Apoya al autor

Si Lasso te ayuda, invítale un café al autor ☕

<div align="center">

WeChat | Alipay
:-: | :-:
<img src="doc/support-wechat.jpg" height="200" alt="WeChat sponsor QR"> | <img src="doc/support-alipay.jpg" height="200" alt="Alipay sponsor QR">

</div>

O ⭐ [dar Star a este repo](../../stargazers), [abrir un Issue](../../issues), o [enviar un PR](../../pulls) — cada uno de ellos anima al autor.

---

## Más documentos

- ¿Arquitectura en profundidad? Ver [Arquitectura funcional](doc/08-media-interact-功能架构.md)
- ¿Hoja de ruta de versiones? Ver [Planificación de implementación](doc/09-media-interact-实施排期.md)
- ¿Cómo conseguir keys? Ver [Guía de configuración de keys](doc/KEY-GUIDE.md)

## Licencia

**MIT** © wangdong233. El proceso helper de escritorio y las dependencias del motor de navegador son todas MIT / Apache-2.0 — apto para uso empresarial.

> ¿Quieres la arquitectura interna, los principios de diseño, los límites multiplataforma y los comandos de desarrollo? Ver [ARCHITECTURE.md](./ARCHITECTURE.md) y [`doc/TROUBLESHOOTING.md`](./doc/TROUBLESHOOTING.md).

<p align="center">
  <sub>Hecho para todos los que prefieren <strong>decirlo</strong> a <strong>programarlo</strong>.</sub><br>
  <sub>Instala una vez — buscar, extraer, extraer con sesión, controlar el escritorio, todo en una frase.</sub>
</p>
