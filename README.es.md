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
| "Captura el texto de la home de github.com" | Texto limpio del artículo (sin barras de navegación, anuncios ni ruido — ahorras 30–70% en tokens) |
| "Abre mi Jira con sesión iniciada y muéstrame mis pendientes" | Una captura de la página con sesión (reutiliza tu Chrome local; tú gestionas el 2FA) |
| "Este enlace está caído, busca un archivo" | La captura más reciente del Internet Archive |
| "Lista los archivos de mi ventana actual de Finder" | Una lista de ventanas y controles del escritorio (un árbol semántico, no una captura de pantalla) |
| "Haz una captura de pantalla de página completa" / "Guarda como PDF" | Una ruta de archivo en disco (sin volcar un blob gigante de imagen al chat) |
| "¿Qué rastreadores de terceros cargó esta página?" | Una lista de recursos con el conteo por dominio de rastreo |
| "Lista todo lo que puedo controlar ahora mismo" | Una lista unificada (páginas web y ventanas de escritorio, todo junto) |
| "Apaga el modo oscuro" | Clic / tecleo / atajo automatizado (con verificación del resultado — confirma que realmente ocurrió) |
| "Solo obtén este endpoint JSON" | Bytes crudos (lo más rápido y barato) |
| "Este sitio tiene Cloudflare, no puedo extraerlo" | Anti-bot de Chrome en la nube (desactivado por defecto; tú lo activas explícitamente) |
| "¿Lasso está bien configurado?" | Un reporte de salud (te dice qué falta) |

> No necesitas memorizar nombres de capacidades. Solo di lo que quieres — Claude elige la forma correcta de hacerlo.

---

## 💰 Costo de un vistazo

Lasso en sí es **completamente gratis + open source MIT**. Esto es lo que realmente cuesta cada capacidad:

| Capacidad | Costo | Notas |
|---|---|---|
| Lasso en sí (servidor MCP + todas las capacidades centrales) | ✅ Gratis | Open source MIT, gratis para siempre |
| Búsqueda (Zhipu + Brave + Bing) | ✅ Tier gratis disponible | Zhipu se factura por token; Brave **2.000 consultas/mes gratis**, Bing **1.000 consultas/mes gratis** — se puede usar sin pagar |
| Extraer páginas públicas / capturas de pantalla / PDF / auditoría de red / bytes crudos | ✅ Gratis | Se ejecuta en local, sin key, sin pago |
| Extraer páginas con sesión iniciada (reutiliza Chrome local) | ✅ Gratis | Se ejecuta en local, sin key, sin pago |
| Controlar el escritorio (macOS / Windows / Linux) | ✅ Gratis | Construido y ejecutado en local, solo necesita autorización del SO; **opcional** cuenta Apple Developer de \$99/año para autorización firmada persistente (también funciona sin firmar — solo hay que reautorizar cada vez) |
| Navegador en la nube (browserbase / stagehand) | ⚠️ De pago, desactivado por defecto | De pago tras la prueba; **no cuesta nada si no lo configuras** — el único elemento de pago de Lasso |

> En una frase: **mientras no actives el navegador en la nube, Lasso cuesta cero** — la búsqueda tiene tiers gratis suficientes para el uso diario, y todo lo demás es completamente gratis.

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

### Extraer páginas públicas (sin login)

> Tú: "Captura el texto de example.com" → texto limpio del artículo, tres granularidades disponibles

Elimina automáticamente barras de navegación, anuncios, barras laterales y demás ruido — **ahorra 30–70% en tokens** (y dinero). ¿Necesitas marcadores de cita (ideal para investigación, para alimentar RAG)? Una frase cambia de modo.

### Extraer páginas con sesión iniciada (incluso con 2FA)

> Tú: "Muéstrame mis pendientes de Jira" → captura de la página con sesión

Reutiliza **tu Chrome con sesión iniciada en local** — tú gestionas el 2FA una vez; Lasso se encarga del resto. Funciona para repos privados de GitHub, intranets de empresa, contenido de suscripción de pago, etc.

> 🔴 **Línea roja**: Lasso **nunca resuelve 2FA / códigos SMS / CAPTCHA / magic links por ti**. Debes pasarlos manualmente una vez en tu Chrome local.

### Obtener bytes crudos (lo más rápido y barato)

> Tú: "Haz GET a este endpoint JSON" → bytes crudos

Cuando no necesitas renderizar una página completa, HTTP directo es **~4× más rápido y ~4× más barato** que pasar por un navegador. Detecta automáticamente el tipo de contenido (JSON / texto / binario).

### Captura de pantalla / Archivo

> Tú: "Haz una captura de página completa" / "Guarda como PDF" → ruta del archivo en disco

Todas las imágenes y PDFs se **guardan en disco y se devuelve una ruta** — sin volcar un blob gigante al chat para desperdiciar contexto.

### Ver qué carga una página

> Tú: "¿Qué rastreadores de terceros cargó esta página?" → lista de recursos con conteo por dominio

Identifica automáticamente cada recurso que carga la página, agrupado por dominio de terceros — útil para detectar riesgos de privacidad y cuellos de botella de rendimiento.

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

**Completamente desactivado por defecto.** Solo se activa cuando lo enciendes explícitamente Y has configurado una key de navegador en la nube. No lo necesitas para páginas normales.

---

## Instalar

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
| Extraer sitios protegidos por Cloudflare | Doble confirmación + una key en la nube | Desactivado por defecto; necesita tu opt-in explícito |

A continuación, cada uno de los cuatro módulos se desglosa con el camino más corto a "simplemente funciona".

### 1. Búsqueda (✅ Gratis · tier gratis; una key para empezar, tres para fallos casi nulos)

**Qué hace**: Busca cualquier cosa, devuelve resultados estructurados (título, snippet, enlace).

**¿Necesita key**: Sí — una key de Zhipu (gratis solicitarla) basta.

**Cómo configurar**:

```bash
lasso config init        # crea la plantilla ~/.lasso/config.json
```

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

**Cómo configurar**: Ejecuta el comando de abajo una vez. Detecta automáticamente tu Chrome local y reutiliza cada sesión que ya tengas iniciada (incluidas aquellas en las que ya pasaste el 2FA tú mismo):

```bash
lasso launch-chrome
```

Después, dile "abre mi Jira con sesión iniciada" a Claude y se conectará solo.

> 🔴 **Línea roja**: 2FA / códigos SMS / CAPTCHA / magic links — Lasso nunca resuelve esto por ti. Debes pasarlos manualmente una vez en tu Chrome local.

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

### 4. Anti-bot en la nube (⚠️ De pago, desactivado por defecto · necesita doble confirmación)

**Qué hace**: Extrae sitios protegidos por Cloudflare o con protección anti-bot fuerte.

**¿Necesita key**: Sí — y solo se activa cuando **tú la enciendes explícitamente**.

**Cómo configurar**: Deben cumplirse ambas condiciones al mismo tiempo:

1. Interruptor maestro: pon `LASSO_ALLOW_CLOUD_BROWSER` a `true`
2. Al menos una key en la nube (browserbase o stagehand — elige una)

Escríbelo en `~/.lasso/config.json`:

```json
{
  "LASSO_ALLOW_CLOUD_BROWSER": true,
  "BROWSERBASE_API_KEY": "your_browserbase_key"
}
```

> Desactivado por defecto — sin configuración no hay tal capacidad. No lo necesitas para páginas normales, **y solo se activa cuando tú lo activas explícitamente**.

**Cómo solicitar keys en la nube, cuotas de prueba** → ver la [Guía de configuración de keys · Navegador en la nube](./doc/KEY-GUIDE.md#d-云浏览器反爬默认关双重解锁).

<details>
<summary><b>Ajuste avanzado (opcional — usuarios comunes pueden omitirlo)</b></summary>

Puedes **ignorar por completo** lo siguiente para el uso diario. Solo aplica a escenarios especiales, y la mayoría se puede establecer vía `lasso config init` en `~/.lasso/config.json` o sobrescribir con variables de entorno (las variables de entorno tienen prioridad sobre el archivo de configuración, útil para cambios temporales):

- Cambiar el puerto de depuración del Chrome con sesión (cuando el `9222` por defecto está ocupado)
- Mover los archivos de caché / estado a otra ubicación
- Restringir solo a fuentes de búsqueda gratis
- Permitir intranet de empresa / rangos de proxy especiales
- Definir tu propia frase para cifrar las cookies de sesión (si no se define, se usa macOS Keychain)
- Guardar capturas de resultados de búsqueda en disco (para pruebas de regresión)

Lista completa de variables y sus valores por defecto: [Guía de configuración de keys · Ajuste avanzado](./doc/KEY-GUIDE.md#e-高级调优可选全不配). **Las redes proxy TUN de Surge / Clash (fake-ip) ya están permitidas por defecto.**

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

## Licencia

**MIT** © wangdong233. El proceso helper de escritorio y las dependencias del motor de navegador son todas MIT / Apache-2.0 — apto para uso empresarial.

> ¿Quieres la arquitectura interna, los principios de diseño, los límites multiplataforma y los comandos de desarrollo? Ver [ARCHITECTURE.md](./ARCHITECTURE.md) y [`doc/TROUBLESHOOTING.md`](./doc/TROUBLESHOOTING.md).

<p align="center">
  <sub>Hecho para todos los que prefieren <strong>decirlo</strong> a <strong>programarlo</strong>.</sub><br>
  <sub>Instala una vez — buscar, extraer, extraer con sesión, controlar el escritorio, todo en una frase.</sub>
</p>
