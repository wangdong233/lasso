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
| Búsqueda (reuso del MCP de Zhipu de la máquina + Brave) | ✅ Normalmente cero configuración | Si la máquina ya tiene configurado el MCP `web-search-prime` de Zhipu, Lasso lo reutiliza automáticamente (ruta principal, sin necesidad de ninguna key de búsqueda); Brave es un plan de pago opcional que incluye \$5/mes de crédito (el tier gratis se eliminó desde 2026-02); Lasso además trae un fallback de búsqueda real gratuito, así que tienes búsqueda aunque no configures ninguno. Desde v1.17 Lasso ya no admite su propia key directa de Zhipu (`ZHIPU_API_KEY` está retirada) |
| Extraer páginas públicas / capturas de pantalla / PDF / auditoría de red / bytes crudos / búsqueda privada local (v1.17: historial+archivos) | ✅ Gratis | Se ejecuta en local, sin key, sin pago |
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

> 💡 **La búsqueda es de cero configuración por defecto**: si tu `~/.claude.json` ya tiene configurado el MCP `web-search-prime` de Zhipu, Lasso lo detecta y lo reutiliza al arrancar — la búsqueda simplemente funciona, sin ninguna key de búsqueda (desde v1.17 esta es la única forma admitida de usar Zhipu). Ejecuta `lasso doctor` y mira si `#36 machine_search_mcp` está en `pass`.

Tu primer output — simplemente dile a Claude:

> "Captura el texto de example.com y conviértelo a markdown"

### ¿Quieres más? Añádelo en el archivo de configuración (Tier 2)

- **Búsqueda** → normalmente cero configuración (reuso del MCP de Zhipu de la máquina); opcionalmente añade una key de Brave como segunda fuente (ver [Configurar](#configurar))
- **Extraer páginas con sesión iniciada** (Jira / GitHub privado / intranet de la empresa) → ejecuta `lasso launch-chrome` una vez
- **Controlar el escritorio de macOS** → ejecuta `lasso doctor` una vez para que te guíe por la autorización

Cómo obtener cada key, qué tiers gratis hay — ver la [**Guía de configuración de keys**](./doc/KEY-GUIDE.md).

---

## Qué puede hacer por ti

Agrupado por **lo que quieres hacer**, no por nombre de herramienta. Cada uno: una frase de entrada, una frase de salida.

### Búsqueda

> Tú: "Busca X" → resultados estructurados de búsqueda

Por defecto se reutiliza el MCP de Zhipu de la máquina (fuerte para chino, cero configuración); opcionalmente puedes añadir Brave como multi-fuente (las capas muertas de Bing y de Zhipu directo ya están eliminadas; las claves de configuración sobrantes se toleran pero se ignoran silenciosamente). **Si una fuente está con rate-limit o caída, cambia automáticamente a la siguiente — no te enteras.** Agotar la cuota gratis de un proveedor no rompe todo el conjunto.

Para contenido sensible al tiempo como **noticias y seguimiento de versiones**, di directamente "busca X de la última semana / del último mes" — el filtro de frescura (day / week / month / year, v1.11) se aplica automáticamente, sin fechas escritas a mano en la consulta.

> ¿Quieres **el cuerpo de las páginas junto con los resultados**? Di "busca e incluye 3 bloques de contenido" (`content_blocks: 1-5`, v1.17) — tras obtener los enlaces, Lasso obtiene en paralelo las N páginas principales y recorta cada cuerpo a ~6k caracteres **relevantes para tu consulta** (el párrafo inicial siempre se conserva, las secciones con palabras clave primero): un paso hacia "enlaces + contenido legible de inmediato". Los elementos que no se pueden obtener se **anotan con honestidad** (`fetch_failed` / `not_html`) conservando el enlace — tú (o la IA) decidís si vale la pena usar el navegador. Cero dependencias de pago, sin navegador.

### Busca en tu propia máquina (nuevo en v1.17)

> Tú: "¿qué páginas sobre X leí últimamente?" / "¿qué archivos locales mencionan X?" → búsqueda privada local

`search_local` consulta directamente el **historial de Chrome** (todos los perfiles) y el **índice Spotlight de archivos** (mdfind) de tu máquina — sin red, sin nube. Privacidad integrada: **solo se devuelven título / URL / hora / fragmento del título, nunca una exportación del contenido completo de la página**, máximo 50 resultados, bases de datos de origen abiertas solo en lectura. La búsqueda de texto completo en Apple Notes aún no está abierta (un honesto "aún no implementado" en lugar de fingir que se buscó).

### Extraer páginas públicas (sin login)

> Tú: "Captura el texto de example.com" → texto limpio del artículo, tres granularidades disponibles

Elimina automáticamente barras de navegación, anuncios, barras laterales y demás ruido — **ahorra 30–70% en tokens** (y dinero). GitHub / Reddit / Hacker News / Wikipedia / Substack / Medium y otros **sitios de alto tráfico — más de 20 en total — tienen extractores dedicados**, así que las tablas y las fórmulas matemáticas tampoco pierden su estructura (v1.12) — y cada enlace del texto es una dirección absoluta totalmente clicable. ¿Necesitas marcadores de cita (ideal para investigación, para alimentar RAG)? Una frase cambia de modo.

> ¿Quieres **seguir interactuando justo después de leer** (pulsar un botón, rellenar un formulario)? Di «incluye los handles interactivos en la extracción» (`include_refs`, v1.17) — al final del markdown se añade una tabla de handles tipo `[r1] button "Enviar"` (el cuerpo queda sin marcas), y luego «pulsa r1» / «rellena r2 con X» localiza directamente por handle, sin repetir la instantánea de toda la página. Si la página cambió, el handle **falla con honestidad** (devuelve didnt + sugiere re-extraer — sin adivinar, sin reintentar solo).

> **Desde v1.5, `browse_headless` trae la anti-detección activada por defecto** (UA camuflado / `navigator.webdriver` eliminado / webgl, plugins y codecs falsificados, y una docena de capas más). **Sin configuración — automático.** Muchos sitios que "detectan headless" ahora se extraen directamente (v1.8 corrigió un defecto por el que la inyección fallaba en silencio — ahora surte efecto de verdad, y las inyecciones fallidas se reportan con honestidad en el log). Desde v1.11 la anti-detección se aplica **en la capa de arranque del navegador**: UA, viewport e idioma se emiten juntos desde el perfil, así que la cabecera HTTP de red y el JS de la página ven los mismos valores — sin contradicciones. Desde v1.12 la huella por defecto en macOS **se alinea con tu sistema** (adiós al "el UA dice Windows pero los rasgos de la máquina delatan macOS"). Solo el anti-bot pesado tipo Cloudflare necesita el navegador en la nube (ver "Esquivar anti-bot" más abajo). ¿Quieres verificar el efecto de la anti-detección? Ejecuta `lasso doctor --stealth-check` para una comparación con creepjs.

### Extraer páginas con sesión iniciada (incluso con 2FA)

> Tú: "Muéstrame mis pendientes de Jira" → captura de la página con sesión

Reutiliza **tu Chrome con sesión iniciada en local** — tú gestionas el 2FA una vez; Lasso se encarga del resto. Funciona para repos privados de GitHub, intranets de empresa, contenido de suscripción de pago, etc.

> 🔴 **Línea roja**: Lasso **nunca resuelve 2FA / códigos SMS / CAPTCHA / magic links por ti**. Debes pasarlos manualmente una vez en tu Chrome local.

> 🛡️ **Confirmación dentro de la ronda para acciones de alto riesgo** (v1.17): cuando una acción automática toca un patrón de alto riesgo (editores de texto enriquecido, arrastrar y soltar, avisos transitorios…), los clientes con soporte de elicitation (Claude Code ≥ 2.1.76) reciben una pregunta en la misma ronda — «continuar / saltar / abortar» — y el paso solo se ejecuta si eliges continuar, en lugar de abortar toda la ejecución. Los clientes antiguos mantienen exactamente el comportamiento actual (bloqueo seguro). **La confirmación vale solo para esa ocasión**: te volverán a preguntar cada vez; no se recuerda nada.

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

**Versión actual v1.18.3** (changelog en el bloque plegado al final de esta sección).

Requisitos previos: Node.js ≥ 20 + Claude Code (o cualquier cliente compatible con MCP).

```bash
claude mcp add lasso -- npx -y lasso-mcp
```

Reinicia Claude Code → `/mcp` → `lasso ✓ Connected`. **Solo esta línea, sin ninguna key** — tras instalar, extraer páginas / capturas / PDF / control de escritorio funcionan de inmediato; solo la búsqueda admite una key opcional (ver [Configurar](#configurar)).

**Usuarios de macOS que quieren controlar el escritorio**: ejecuta `lasso doctor` una vez y marca `lasso-rust-helper` en "Accessibility" y "Screen Recording" siguiendo las indicaciones — `doctor` te guía paso a paso.

<details>
<summary>📋 Changelog (v1.8 → v1.17 — despliega para ver qué cambió en cada versión)</summary>

- **v1.17**: cinco mejoras — ① clave directa de Zhipu retirada (`ZHIPU_API_KEY` ya no se consume; la capacidad Zhipu se lleva únicamente con la reutilización del MCP web-search-prime de la máquina, búsqueda sin configuración por defecto) ② `search` incorpora el segundo salto `content_blocks` (tras los enlaces, obtener en paralelo los cuerpos top-N recortados a ~6k caracteres según la consulta, fallos anotados con honestidad, cero dependencias de pago) ③ nueva herramienta `search_local` (historial de Chrome + Spotlight, privada y local; solo título/URL/hora, sin exportación de texto completo) ④ confirmación por elicitation dentro del turno para acciones de alto riesgo (clientes antiguos sin cambios) ⑤ `browse extract` incorpora manejadores interactivos `include_refs` (apéndice estilo `[r1]` + clic/llenado por manejador, caducidad honesta al cambiar la página). Los resultados de búsqueda llevan ahora un eje `quality` uniforme (api / scrape / stale).

- **v1.15**: capa muerta de Bing eliminada por completo (Bing Search APIs retirado por completo el 2025-08-11 — código borrado, no solo documentado; un `BING_API_KEYS` residual se ignora silenciosamente y `lasso doctor` sugiere eliminarlo) + **sonda rápida de HTTP puro** antes del navegador headless (si todas las capas de API caen, primero se descarga la página de resultados sin navegador en ~1s; solo si sale vacía arranca la ruta lenta — prueba real: 20 resultados en 1,9s frente a 5,3s de la ruta headless con captcha y cero resultados; las páginas de bloqueo blando como el captcha/portada de Baidu nunca falsifican éxito y escalan al navegador).

- **v1.14**: deuda de hechos operativos de búsqueda saldada (libro de cuotas de Brave alineado al crédito mensual de $5 ≈1000 consultas/mes; `free_only=L2` ya no enruta el Brave medido como nivel gratuito; cuota de Bing a cero) + fallback inglés sin key de doble motor (fallo/vacío de DDG cascada a un intento Brave SERP); `lasso doctor --deep` (sonda de nivel de plan de Brave, consume 1 unidad de cuota) + aviso estático de retiro de Bing; sistema de fechado de frescura en KEY-GUIDE (cada afirmación de key lleva fecha de "última verificación" y disparador de reverificación a 90 días).
- **v1.13**: huella de idioma consistente en el navegador headless (el HTTP `Accept-Language` se emite con el perfil; eliminada la contradicción "cabecera zh-CN ↔ página en-US"); corregido el punto de aterrizaje del VLM en capturas por región; `desktop find` rechaza consultas de solo ref; liberación de sesiones Steel con tope de 3 segundos (Steel colgado ya no bloquea la salida 5 minutos).
- **v1.12**: extracción markdown de doble activación (extractores dedicados de defuddle para 20+ sitios + fidelidad de tablas/matemáticas); huella por defecto en macOS alineada con el sistema anfitrión; cola del escritorio honesta (el VLM no finge éxito / expect exige dos aciertos consecutivos / señal `truncated:true`); degradación automática de `type` en campos de entrada de Electron; la interpolación de arrastre pasa a ser utilizable; cierre inmediato si Claude Code termina de forma anómala.
- **v1.11**: el escritorio pasa de "poder mirar" a "poder clicar" (click/type/scroll implementados de verdad + ratón por coordenadas + poda `skeleton`); capa driver actualizada a chrome-devtools-mcp 1.7.0 (stealth a nivel de arranque, telemetría desactivada por defecto); la búsqueda gana el filtro temporal `freshness`; el fallback sin key para inglés pasa a DuckDuckGo; nuevo proxy de salida `LASSO_PROXY`.
- **v1.10**: navegadores silenciosos por defecto + cerrados al acabar (arranque de `launch-chrome` sin ventanas, autocierre a los ~60 s, `--mode visible` para volver atrás).
- **v1.9**: cierre del ciclo de vida de navegadores (headless autoreciclado tras 5 minutos de inactividad, `lasso chrome-stop`, `tab_restore` restaura la lista original de pestañas).
- **v1.8**: corregidos los 24 defectos destapados por el test de campo completo (adaptación al contrato upstream, capturas que de verdad aterrizan en disco, paginación de `read_text`, etc.) — lista completa en el "registro de fixes v1.8" de [doc/17-功能测试清单.md](doc/17-功能测试清单.md).

</details>

---

## Configurar

**Solo la búsqueda necesita key; todo lo demás funciona recién instalado.** Consulta en la tabla según lo que quieras hacer:

| Lo que quieres hacer | Qué configurar |
|---|---|
| Extraer páginas públicas / capturas / PDF / ver recursos de terceros / obtener bytes crudos / controlar el escritorio | **Nada en absoluto** |
| Buscar | Normalmente cero configuración (reuso del MCP de Zhipu); key de Brave opcional (plan de pago) |
| Búsqueda casi sin fallos | Añadir una key de Brave (plan de pago con \$5/mes de crédito; sin configurarla también hay búsqueda real gratuita de respaldo) |
| Extraer páginas con sesión iniciada | Ejecutar `lasso launch-chrome` una vez |
| Controlar el escritorio de macOS | Ejecutar `lasso doctor` una vez para autorizar |
| Extraer sitios con Cloudflare | Interruptor maestro + Steel (autoalojado gratis) / browserbase (de pago) |

Los cuatro módulos siguientes dan cada uno la configuración mínima para que "simplemente funcione"; los detalles están plegados y se pueden desplegar.

### 1. Búsqueda (✅ Gratis · el único módulo que necesita key)

**Primero mira si hace falta configurar**: si tu máquina ya tiene configurado el MCP `web-search-prime` de Zhipu, Lasso **detecta y reutiliza su key automáticamente** — no hay que rellenar nada. Ejecuta `lasso doctor`: si `#36 machine_search_mcp` está en `pass`, es exactamente este caso.

**Para configurar, tres pasos**:

```bash
lasso config init        # crea ~/.lasso/config.json
```

```json
{ "ZHIPU_API_KEY": "your_zhipu_key" }
```

Al guardar surte efecto. **¿Más estabilidad?** Añade también Brave (plan de pago con \$5/mes de crédito ≈ 1000 consultas; requiere tarjeta de crédito — el tier gratis se eliminó desde 2026-02; si un proveedor configurado cae, pasa automáticamente al siguiente; varias keys separadas por comas, cada una con su cuota):

```json
{
  "ZHIPU_API_KEY": "your_zhipu_key",
  "BRAVE_API_KEYS": "bravekey1,bravekey2"
}
```

> Orden de degradación: reutilización del MCP de la máquina → Brave (si hay key configurada) → búsqueda real en el navegador headless como remate (v1.14: fallback inglés de doble motor — un fallo o vacío de DDG reintenta automáticamente una vez con búsqueda real de Brave; v1.15 añade antes una **sonda rápida de HTTP puro** (~1s, descarga la página de resultados sin ningún navegador — en pruebas reales algunos motores desconfían menos de clientes sin navegador); solo si no encuentra nada arranca la ruta lenta del navegador). Si falla el anterior, pasa automáticamente al siguiente. (La fuente Bing se eliminó por completo tras el retiro del upstream el 2025-08-11, y el nivel directo de Zhipu se eliminó en v1.17; un `BING_API_KEYS` / `ZHIPU_API_KEY` residual se ignora silenciosamente y `lasso doctor` sugiere eliminarlo.)

Cómo solicitar keys, cuánta cuota gratis hay → [Guía de configuración de keys · Búsqueda](./doc/KEY-GUIDE.md#a-搜索). Comandos habituales: `lasso --version` / `lasso --help` (desde v1.8, los comandos desconocidos imprimen el uso y terminan con código distinto de cero, en vez de colgarse en silencio).

### 2. Extraer páginas con sesión iniciada (✅ Gratis · un comando, sin key)

```bash
lasso launch-chrome
```

La primera vez, inicia sesión en tus cuentas en esa ventana (el 2FA lo gestionas tú), y **la sesión se reutiliza desde entonces para siempre**. Después basta con decirle a Claude "abre mi Jira con sesión iniciada".

- Trabaja por defecto **en silencio y sin ventana**, sin robar el foco y siempre silenciado; añade `--mode visible` si quieres verlo trabajar
- **Se cierra solo ~60 s después de su último uso** — no tienes que acordarte de recoger; cierre manual en cualquier momento con `lasso chrome-stop`
- Las pestañas que abre en tu Chrome se restauran a la lista original cuando al terminar la tarea dices `admin {action:"tab_restore", reason:"listo"}` (lo mismo ocurre automáticamente al salir del servidor)

> 🔴 **Línea roja**: 2FA / códigos de verificación / CAPTCHA — Lasso no los resuelve por ti; los pasas tú manualmente una vez en la ventana.

<details>
<summary>Detalles: reutilización de perfil / puerto ocupado / ajuste / límites del silencio</summary>

- Desde v1.8 se usa por defecto un perfil independiente de Lasso (Chrome 136+ prohíbe abrir el puerto de depuración en el perfil por defecto — el método antiguo se cerraba al instante); para reutilizar un perfil existente: `lasso launch-chrome --profile <directorio>`.
- Tras el arranque se sondea automáticamente el puerto de depuración; si Chrome no levantó o el puerto está ocupado, da un error claro en vez de fingir éxito.
- Umbral de autocierre: `LASSO_LAUNCH_IDLE_MS` (por defecto 60000; `300000` vuelve a 5 minutos; `0` lo desactiva). Para dejar pasar una tarea larga puntual: `--idle-ms 3600000`.
- El navegador headless se autorecicla tras 5 minutos de inactividad (`LASSO_HEADLESS_IDLE_MS` ajustable/desactivable).
- Límite honesto: al ejecutar `lasso launch-chrome` suelto (sin servidor) no hay autocierre por inactividad — la salida sigue siendo `chrome-stop`; que `browse_logged_in` se conecte a **tu propio Chrome visible** es "baja molestia, no cero molestia" (limitación a nivel de plataforma de macOS; alguna operación puntual puede robar el foco una vez) — para silencio puro usa el nivel oculto o `browse_headless`; `desktop` simula el teclado y el ratón de una persona real, así que ocupa por diseño el teclado/ratón físicos — no existe una forma silenciosa.
- chrome-stop solo cierra los Chrome que Lasso lanzó él mismo, con propiedad verificada — nunca tus navegadores abiertos a mano.

</details>

**Detalles** → [Guía de configuración de keys · Navegación con sesión](./doc/KEY-GUIDE.md#b-登录态浏览命令行配置无-key).

### 3. Controlar el escritorio (✅ Gratis · autoriza una vez, sin key)

- **macOS**: ejecuta `lasso doctor` y marca `lasso-rust-helper` en "Accessibility" + "Screen Recording" siguiendo las indicaciones
- **Windows**: en la primera acción de escritorio, el sistema muestra un diálogo de autorización — haz clic en "Allow"
- **Linux**: instala la interfaz de accesibilidad (GNOME/MATE la traen por defecto; si no, `sudo apt install at-spi2-core`)

> Límite honesto: macOS está verificado en entornos reales; Windows / Linux pasan las auto-verificaciones de compilación y contrato, y las pruebas manuales completas en máquina real siguen en curso — sin fingir un "totalmente verificado".

**Detalles** → [Guía de configuración de keys · Control de escritorio](./doc/KEY-GUIDE.md#c-桌面控制系统授权无-key).

### 4. Navegador en la nube (desactivado por defecto · solo necesario con anti-bot pesado)

El anti-bot ligero ya lo resuelve la anti-detección integrada de `browse_headless` — **si no lo necesitas, no lo configures**. Se activa solo para anti-bot de nivel Cloudflare, y necesita a la vez el interruptor maestro + un canal:

```json
{
  "LASSO_ALLOW_CLOUD_BROWSER": true,
  "STEEL_ENDPOINT": "http://localhost:3000"
}
```

- **Steel autoalojado (recomendado · gratis)**: un comando de Docker — `docker run -p 3000:3000 -p 9223:9223 ghcr.io/steel-dev/steel-browser`; cero coste por sesión, las cookies nunca salen de tu máquina
- **browserbase alojado (de pago)**: cambia a `"BROWSERBASE_API_KEY": "your_key"` — la alternativa si no quieres ejecutar Docker
- ⚠️ stagehand: canal experimental programático sin entrada de herramienta MCP — no cuentes con él para extraer páginas

**Cómo solicitar keys, pasos completos para abrir Steel** → [Guía de configuración de keys · Navegador en la nube](./doc/KEY-GUIDE.md#d-云浏览器反爬默认关双重解锁).

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
| La búsqueda no devuelve nada | Ejecuta `lasso doctor` y mira `machine_search_mcp` / `brave_keys`; comprueba si la key de Brave caducó / la cuota se agotó; el reuso del MCP de la máquina + el fallback de búsqueda real gratuito funcionan sin configurar nada |
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
