<h1 align="center">Lasso</h1>

> A "alça de controle" do Claude Code para tudo que está fora — pesquisar, extrair dados da web, capturar páginas com login, controlar o desktop, tudo numa única frase.
> Laço de cowboy — captura qualquer interface.

<p align="center">
  <img src="https://img.shields.io/npm/v/lasso-mcp">
  <img src="https://img.shields.io/badge/license-MIT-green">
  <img src="https://img.shields.io/badge/MCP-compatible-purple">
</p>

**Instale o Lasso uma vez no Claude Code e, a partir de então, pesquisar, extrair páginas, extrair páginas com login e controlar o desktop vira tudo numa única frase.** Se você pesquisa, captura uma página ou navega por apps de desktop toda semana — e não quer uma ferramenta separada para cada tarefa — instale uma vez e deixe tudo nas mãos do Claude.

Estrela gêmea do [media-gen-mcp](https://github.com/wangdong233/media-gen-mcp) (a alça de imagens): "toda operação de imagem num único MCP" ↔ "toda interação externa num único MCP".

<div align="center">

[简体中文](README.md) | [English](README.en.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [日本語](README.ja.md) | **Português** | [Русский](README.ru.md)

</div>

## Índice

- [O Que Você Diz, O Que Você Obtém](#o-que-você-diz-o-que-você-obtém)
- [💰 Custo num Relance](#-custo-num-relance)
- [Início em 60 Segundos](#início-em-60-segundos)
- [O Que Ele Pode Fazer por Você](#o-que-ele-pode-fazer-por-você)
- [Instalação](#instalação)
- [Configuração](#configuração)
- [Privacidade e Segurança](#privacidade-e-segurança)
- [Solução de Problemas](#solução-de-problemas)
- [Para Quem É / Para Quem Não É](#para-quem-é--para-quem-não-é)
- [Apoie o Autor](#apoie-o-autor)
- [Licença](#licença)

---

## O Que Você Diz, O Que Você Obtém

| Você diz …… | Você obtém |
|---|---|
| "Pesquise o mais recente sobre o ecossistema async do rust" | Resultados estruturados de busca (alterna automaticamente para o próximo motor se um cair — você nem percebe) |
| "Pesquise as atualizações do Claude Code da última semana" (v1.11) | Resultados filtrados por tempo via `freshness=week` — sem escrever datas à mão na query |
| "Pegue o texto da homepage do github.com" | Texto limpo do artigo (barras de navegação / anúncios / sujeira removidos — economiza 30–70% em tokens; 20+ sites de alto tráfego usam extratores dedicados e as tabelas não perdem a estrutura — v1.12) |
| "Abra meu Jira logado e mostre minhas tarefas" | Um snapshot da página com login (reutiliza seu Chrome local; você resolve o 2FA) |
| "Este link está morto, ache um archive" | O snapshot mais recente da Internet Archive |
| "Liste os arquivos da minha janela atual do Finder" | Uma lista de janelas e controles do desktop (uma árvore semântica, não um screenshot; se a árvore for truncada, ele avisa claramente `truncated:true` — v1.12) |
| "Clique naquele botão de nova pasta" / "Digite XX no campo de busca" (v1.11) | Ação de desktop executada de verdade (clique / digitação semântica AXAPI + verificação do resultado; fallback automático para clique por coordenadas em canvas / Electron) |
| "Tire um screenshot de página inteira desta página" / "Salve como PDF" | Um caminho de arquivo no disco (nada de blob gigante de imagem despejado no chat) |
| "Quais rastreadores de terceiros esta página carregou?" | Uma lista de recursos com contagem por domínio de rastreador |
| "Liste tudo que eu posso controlar agora" | Uma lista unificada (páginas web e janelas do desktop, tudo nela) |
| "Desligue o dark mode" | Clique / digitação / hotkey automáticos (com verificação de resultado — ele confirma que realmente aconteceu) |
| "Só faz fetch deste JSON endpoint" | Bytes brutos (mais rápido, mais barato) |
| "Este site parece ter um anti-bot, tenta aí" | O `browse_headless` tem antidetecção embutida (passa checagens básicas de bot) — muitos sites são extraídos direto, sem config |
| "Este site tem Cloudflare, não consigo extrair" | Anti-bot via Chrome na nuvem — **Steel auto-hospedado (grátis)** ou browserbase / stagehand (pago, desativado por padrão) |
| "O Lasso está configurado corretamente?" | Um relatório de health-check (te diz o que falta) |

> Você não precisa memorizar nenhum nome de capacidade. Basta dizer o que quer — o Claude escolhe o jeito certo de fazer.

---

## 💰 Custo num Relance

O Lasso em si é **completamente grátis + MIT open source**. Veja quanto cada capacidade custa de verdade:

| Capacidade | Custo | Observações |
|---|---|---|
| O próprio Lasso (servidor MCP + todas as capacidades principais) | ✅ Grátis | MIT open source, grátis para sempre |
| Busca (Zhipu + Brave + Bing) | ✅ Plano grátis disponível | Zhipu cobrado por token; Brave **2.000 consultas/mês grátis**, Bing **1.000 consultas/mês grátis** — usável sem pagar. **Já configurou o MCP `web-search-prime` da Zhipu na sua máquina? O Lasso detecta e reutiliza automaticamente — nem precisa configurar um ZHIPU_API_KEY separado** |
| Extrair páginas públicas / screenshots / PDF / auditoria de rede / bytes brutos | ✅ Grátis | Roda localmente, sem key, sem pagamento |
| Extrair páginas com login (reutiliza o Chrome local) | ✅ Grátis | Roda localmente, sem key, sem pagamento |
| Controlar o desktop (macOS / Windows / Linux) | ✅ Grátis | Construído e executado localmente, só precisa de autorização do SO; conta Apple Developer de \$99/ano **opcional** para autorização persistente assinada (também funciona sem assinar — basta autorizar de novo a cada vez) |
| Navegador na nuvem · Steel auto-hospedado (novo na v1.6) | ✅ Grátis | Rode o Steel (Apache-2.0 open source) em Docker local — **custo zero por sessão + os cookies nunca saem da sua máquina**; precisa de `LASSO_ALLOW_CLOUD_BROWSER=true` + `STEEL_ENDPOINT=http://localhost:3000` |
| Navegador na nuvem · hospedado (browserbase / stagehand) | ⚠️ Pago, desativado por padrão | browserbase paga por uso após o trial; stagehand é um canal experimental programático (sem entrada de ferramenta MCP); **não custa nada se você não configurar** |
| Antidetecção do `browse_headless` (novo na v1.5) | ✅ Grátis | Injeta 16 camadas de antidetecção por padrão (UA / webdriver / webgl etc.) — passa muitas checagens básicas de bot de cara |

> Em uma frase: **enquanto você não ligar o navegador na nuvem hospedado (browserbase / stagehand), o Lasso custa zero** — a busca tem planos grátis suficientes para o uso diário, e o Steel auto-hospedado também é grátis.

---

## Início em 60 Segundos

### 30 segundos · Instalação de uma linha (zero config)

```bash
claude mcp add lasso -- npx -y lasso-mcp
```

Reinicie o Claude Code → digite `/mcp` → veja `lasso ✓ Connected`. Pronto. **Sem keys no comando de instalação** — a configuração é uma etapa separada (próximo nível).

### 30 segundos · Sem nada configurado, você já consegue fazer tudo isso

Sem keys logo após instalar (este é o **Nível 1: zero config**):

- Extrair o texto de qualquer **página web pública**, convertido em markdown limpo
- **Screenshots de página inteira** e **salvar como PDF**, retornando um caminho de arquivo
- Ver **quais rastreadores de terceiros uma página carrega**
- Buscar bytes brutos diretamente de uma JSON API ou arquivo
- Controlar apps nativos do macOS (Finder / Mail / System Settings, etc. — exige uma marcação única em System Settings)

> 💡 **A busca também pode funcionar com zero config**: se o `~/.claude.json` da sua máquina já tem o MCP `web-search-prime` da Zhipu configurado, o Lasso detecta e reutiliza na inicialização — sem precisar configurar um `ZHIPU_API_KEY` separado, a busca simplesmente funciona. Rode `lasso doctor` e veja se `#36 machine_search_mcp` está `pass`.

Seu primeiro resultado — basta dizer ao Claude:

> "Pegue o texto de example.com e transforme em markdown"

### Quer mais? Adicione no arquivo de config (Nível 2)

- **Busca** → execute `lasso config init` para criar `~/.lasso/config.json`, depois preencha uma key da Zhipu (veja [Configuração](#configuração))
- **Extrair páginas com login** (Jira / GitHub privado / intranet da empresa) → execute `lasso launch-chrome` uma vez
- **Controlar o desktop do macOS** → execute `lasso doctor` uma vez para ser guiado pela autorização

Como obter cada key, quais planos grátis existem — veja o [**Guia de Configuração de Keys**](./doc/KEY-GUIDE.md).

---

## O Que Ele Pode Fazer por Você

Agrupado por **o que você quer fazer**, não pelo nome da ferramenta. Cada item é uma frase de entrada, uma frase de resultado.

### Busca

> Você: "Pesquise por X" → resultados estruturados de busca

Usa a Zhipu por padrão (forte em chinês); você pode adicionar Brave e Bing para múltiplas fontes. **Se uma fonte qualquer for limitada por taxa ou estiver fora do ar, ele alterna automaticamente para a próxima — você nem percebe.** Esgotar a cota grátis de um provedor não derruba o conjunto.

Para conteúdo **de atualidade — notícias, movimentos de versão**, basta dizer "pesquise o X da última semana / do último mês" — o filtro de temporalidade se aplica automaticamente (day / week / month / year, em todos os motores — só o Bing não tem granularidade de "ano" e a ignora, v1.11), sem escrever datas à mão na query.

### Extrair Páginas Públicas (sem login)

> Você: "Pegue o texto de example.com" → texto limpo do artigo, três granularidades disponíveis

Remove automaticamente barras de navegação, anúncios, barras laterais e outras sujeiras — **economiza 30–70% em tokens** (e dinheiro). GitHub / Reddit / Hacker News / Wikipedia / Substack / Medium e outros **mais de 20 sites de alto tráfego usam extratores dedicados**, e estruturas como tabelas e fórmulas matemáticas não se perdem (v1.12) — os links no corpo do texto viram endereços absolutos completos e clicáveis. Precisa de marcadores de citação (ótimo para pesquisa, alimentar RAG)? Uma frase troca o modo.

> **A partir da v1.5, o `browse_headless` tem antidetecção ligada por padrão** (UA falsificado / `navigator.webdriver` removido / webgl, plugins e codecs forjados — mais de uma dúzia de camadas). **Zero config — automático.** Muitos sites "detectores de headless" agora podem ser extraídos diretamente (a v1.8 corrigiu um defeito que desativava silenciosamente a injeção — agora funciona de verdade, e falhas de injeção são honestamente reportadas no log). A partir da v1.11 a antidetecção vale **já no lançamento do navegador**: UA, viewport e idioma descem unificados pelo perfil — o cabeçalho HTTP da camada de rede e o JS da página veem os mesmos valores, sem contradição; a partir da v1.12, no macOS a impressão digital padrão **se alinha com o seu sistema** (acabou o "UA diz Windows, as características da máquina entregam macOS"). Só proteção pesada de nível Cloudflare precisa do navegador na nuvem (veja "Bypass Anti-Bot" abaixo). Quer verificar a antidetecção? Rode `lasso doctor --stealth-check` para uma comparação via creepjs.

### Extrair Páginas com Login (mesmo com 2FA)

> Você: "Mostre minhas tarefas do Jira" → snapshot da página com login

Reutiliza **seu Chrome já logado localmente** — você resolve o 2FA uma vez; o Lasso cuida do resto. Funciona para repositórios privados do GitHub, intranets de empresas, conteúdo de assinatura paga, etc.

> 🔴 **Linha vermelha**: o Lasso **nunca resolve 2FA / códigos SMS / CAPTCHA / magic links por você**. Você precisa passar por eles manualmente uma vez no seu Chrome local.

### Buscar Bytes Brutos (mais rápido, mais barato)

> Você: "Faça GET neste JSON endpoint" → bytes brutos

Quando você não precisa renderizar uma página inteira, HTTP direto é **~4× mais rápido e ~4× mais barato** do que passar por um navegador. Detecta automaticamente o tipo de conteúdo (JSON / texto / binário).

### Screenshot / Arquivo

> Você: "Tire um screenshot de página inteira" / "Salve como PDF" → caminho do arquivo no disco

Todas as imagens e PDFs são **salvos no disco e um caminho é retornado** — nada de blob gigante despejado no seu chat desperdiçando contexto. Saídas de texto muito grandes (fetch_url / network etc.) acima de 48 KiB também vão automaticamente para o disco, retornando prévia + handle de paginação `@oN` — continue lendo página por página com a ferramenta `read_text` (chamável diretamente via MCP desde a v1.8).

### Veja o Que uma Página Carrega

> Você: "Quais rastreadores de terceiros esta página carregou?" → lista de recursos com contagem por domínio de rastreador

Identifica automaticamente todo recurso que a página carrega, agrupado por domínio de terceiros — útil para detectar risco de privacidade e gargalos de desempenho. Desde a v1.11 a coleta de recursos usa a camada de rede nativa do motor do navegador — **completa mesmo em ambiente de proxy / rede TUN**, e cada recurso vem com método de requisição e código de status.

### Controlar Apps Nativos do Desktop

> Você: "Desligue o dark mode" / "Leia o primeiro item da minha caixa do Mail" → ação automatizada (com verificação)

No macOS você controla Finder / Mail / Safari / Notes / System Settings e qualquer app nativo. **Windows e Linux também funcionam** (veja a fronteira honesta abaixo). Cada ação é verificada — ele confirma "realmente aconteceu", nunca falso sucesso.

> **Fronteira honesta**: o macOS é verificado em hardware real; Windows / Linux passam por autoverificações em tempo de compilação e a nível de contrato, mas o teste manual completo em máquina real ainda está em andamento. **Não fingimos "totalmente verificado em Win/Linux".**

### Agendamento Unificado entre Web e Desktop

> Você: "Liste tudo que eu posso controlar agora" → uma lista unificada

Páginas web e janelas do desktop compartilham uma lista — você não precisa distinguir "isto está no navegador" vs "isto está no desktop". O Claude escolhe sobre o que agir, e tudo flui a partir daí.

### Reviver Links Mortos

> Você: "Este link dá 404" → o snapshot mais recente da Internet Archive

Recorre à Internet Archive (Wayback Machine) para encontrar a última cópia arquivada daquela URL. **Nunca trata um link vivo como morto** — só procura quando você diz "isto sumiu".

### Bypass Anti-Bot (desativado por padrão)

> Você: "Este site tem Cloudflare, não consigo extrair" → anti-bot do Chrome na nuvem

**Completamente desativado por padrão.** Só ativa quando você liga explicitamente E configurou um navegador na nuvem (Steel auto-hospedado ou browserbase / stagehand hospedados). Anti-bot leve já é resolvido pela antidetecção embutida do `browse_headless` — **só proteção pesada de nível Cloudflare precisa do navegador na nuvem**.

- **Steel auto-hospedado (recomendado · grátis)**: rode um navegador na nuvem open source em Docker local — custo zero por sessão, cookies que não saem da sua máquina. Uma linha de comando para ativar, veja o [Guia de Keys · Steel](./doc/KEY-GUIDE.md#steel_endpoint--自托管云浏览器v16-新推荐免费).
- **browserbase (hospedado · pago)**: paga por uso após o trial; a alternativa quando você não quer rodar Docker você mesmo.
- **stagehand (hospedado · pago)**: ⚠️ canal experimental programático — configurar a key só monta o canal interno, **sem entrada de ferramenta MCP** (contrato REST não verificado; o `lasso doctor` #39 `stagehand_rest_contract_probe` testa exatamente isso).

---

## Instalação

**Versão atual v1.13.0** (changelog no bloco recolhido no fim desta seção).

Pré-requisitos: Node.js ≥ 20 + Claude Code (ou qualquer cliente compatível com MCP).

```bash
claude mcp add lasso -- npx -y lasso-mcp
```

Reinicie o Claude Code → `/mcp` → `lasso ✓ Connected`. **É só essa linha, sem nenhuma key** — extração de páginas / screenshots / PDF / controle do desktop funcionam logo depois de instalar; só a busca admite uma key opcional (veja [Configuração](#configuração)).

**Controle do desktop no macOS**: rode `lasso doctor` uma vez e siga as instruções para marcar `lasso-rust-helper` em "Accessibility" e "Screen Recording" — o `doctor` guia você passo a passo.

<details>
<summary>📋 Changelog (v1.8 → v1.13, clique para ver o que mudou em cada versão)</summary>

- **v1.13**: consistência da impressão de idioma do navegador headless (o cabeçalho HTTP `Accept-Language` segue o perfil, eliminando a contradição "cabeçalho zh-CN ↔ página en-US"); correção do ponto de impacto das capturas VLM com região; `desktop find` rejeita queries puramente por ref; liberação de sessão Steel ganha teto de 3 segundos (um Steel parado não trava mais a saída por 5 minutos).
- **v1.12**: dupla ativação da extração markdown (extratores dedicados defuddle em 20+ sites + fidelidade de tabelas / fórmulas); impressão digital padrão alinhada ao sistema host no macOS; honestização do fim da cadeia desktop (VLM não mente sobre sucesso / expect exige dois acertos consecutivos / sinal `truncated:true`); degradação automática de type em campos de entrada Electron; drag-and-drop interpolado fica utilizável; limpeza imediata na saída anormal do CC.
- **v1.11**: o desktop passa de "enxergar" para "clicar" (click / type / scroll realmente implementados + mouse por coordenadas + poda `skeleton`); camada de driver atualizada para chrome-devtools-mcp 1.7.0 (antidetecção em nível de lançamento, telemetria desligada por padrão); filtro de tempo `freshness` na busca; fallback sem key para queries em inglês trocado para DuckDuckGo; novo `LASSO_PROXY`, proxy de saída.
- **v1.10**: navegador silencioso por padrão + fecha ao acabar (`launch-chrome` inicia sem janela, fecha automaticamente em ~60 s, `--mode visible` para voltar).
- **v1.9**: fim de vida do navegador (headless reciclado automaticamente após 5 minutos ocioso, `lasso chrome-stop`, `tab_restore` restaura a lista original de abas).
- **v1.8**: corrigiu os 24 defeitos expostos pelo teste completo (adaptação ao contrato upstream, screenshots realmente salvos em disco, paginação `read_text` etc.) — lista completa em [doc/17-功能测试清单.md](doc/17-功能测试清单.md), seção "v1.8 修复记录".

</details>

---

## Configuração

**Só a busca precisa de key — todo o resto funciona assim que você instala.** Consulte pela sua necessidade:

| O que você quer fazer | O que configurar |
|---|---|
| Extrair páginas públicas / screenshots / PDF / ver rastreadores / bytes brutos / controlar desktop | **Nada** |
| Buscar | Uma key da Zhipu (grátis para solicitar; se a máquina já tem o MCP da Zhipu, nem isso) |
| Busca quase sem falhas | Adicionar keys da Brave / Bing (ambas com planos grátis) |
| Extrair páginas com login | Executar `lasso launch-chrome` uma vez |
| Controlar o desktop do macOS | Executar `lasso doctor` uma vez para autorizar |
| Extrair sites com Cloudflare | Interruptor master + Steel (auto-hospedado grátis) / browserbase (pago) |

Abaixo, cada um dos quatro módulos com a configuração "mínima que funciona"; os detalhes estão em blocos recolhidos.

### 1. Busca (✅ Grátis · o único módulo que precisa de key)

**Veja primeiro se precisa configurar**: se a sua máquina já tem o MCP `web-search-prime` da Zhipu configurado, **o Lasso detecta e reutiliza automaticamente a key dele** — nada a preencher. Rode `lasso doctor` e veja se `#36 machine_search_mcp` está `pass` — é esse o caso.

**Se precisar configurar, são três passos**:

```bash
lasso config init        # cria ~/.lasso/config.json
```

```json
{ "ZHIPU_API_KEY": "your_zhipu_key" }
```

Salve e já vale. **Quer mais robustez**: adicione Brave e Bing (ambas têm planos grátis; se uma cair, alterna automaticamente — você nem percebe; várias keys separadas por vírgula = N× a cota com rotação automática):

```json
{
  "ZHIPU_API_KEY": "your_zhipu_key",
  "BRAVE_API_KEYS": "bravekey1,bravekey2",
  "BING_API_KEYS": "bingkey1"
}
```

> Ordem de fallback: reuso do MCP da máquina → Zhipu → Brave → Bing → fallback `browse_headless`. O primeiro que falha passa para o próximo.

Como solicitar keys, cotas dos planos grátis → [Guia de Configuração de Keys · Busca](./doc/KEY-GUIDE.md#a-搜索). Comandos úteis: `lasso --version` / `lasso --help` (desde a v1.8, comando desconhecido imprime o uso e sai com código não zero — não trava mais em silêncio).

### 2. Extrair Páginas com Login (✅ Grátis · um comando, sem key)

```bash
lasso launch-chrome
```

Faça login nas suas contas uma primeira vez nessa janela (2FA por sua conta), **e o login fica reutilizado para sempre**. Depois, basta dizer "abra meu Jira logado" ao Claude.

- Por padrão trabalha **silencioso, sem janela**, sem roubar o foco, sempre mudo; para vê-lo trabalhar, adicione `--mode visible`
- **Fecha sozinho ~60 s depois do último uso** — nada para lembrar de fechar; fechamento manual a qualquer momento com `lasso chrome-stop`
- As abas que ele abre no seu Chrome: ao fim da tarefa, diga `admin {action:"tab_restore", reason:"concluído"}` para restaurar a lista original (também acontece automaticamente na saída do servidor)

> 🔴 **Linha vermelha**: 2FA / códigos SMS / CAPTCHA — o Lasso não resolve por você; passe por eles manualmente uma vez na janela.

<details>
<summary>Detalhes: reuso de profile / porta ocupada / ajuste de parâmetros / fronteira do silêncio</summary>

- Desde a v1.8, usa por padrão um profile dedicado do Lasso (o Chrome 136+ não permite porta de debug no perfil padrão — o método antigo fechava na hora); para reutilizar um profile existente: `lasso launch-chrome --profile <diretório>`.
- Depois de iniciar, o Lasso sonda a porta de debug: Chrome não subiu / porta ocupada → erro explícito, sem falso sucesso.
- Limiar de fechamento automático: `LASSO_LAUNCH_IDLE_MS` (padrão 60000; `300000` volta para 5 minutos; `0` desativa). Tarefa longa pontual: `--idle-ms 3600000`.
- O navegador headless é reciclado automaticamente após 5 minutos sem uso (`LASSO_HEADLESS_IDLE_MS` ajustável / desativável).
- Fronteira honesta: rodar `lasso launch-chrome` sozinho (sem o servidor) não tem fechamento idle automático — a saída continua sendo `chrome-stop`; o `browse_logged_in` conectado ao **seu Chrome visível aberto por você** é "pouco intrusivo, não zero intrusão" (limitação da plataforma macOS — algumas ações podem roubar o foco uma vez) — para silêncio puro, use o modo hidden ou o `browse_headless`; o canal `desktop` simula teclado / mouse reais, por design ocupa o teclado e o mouse físicos — não existe forma silenciosa.
- O chrome-stop só fecha os Chromes que o próprio Lasso abriu, com propriedade verificada — nunca os seus navegadores abertos à mão.

</details>

**Detalhes** → [Guia de Configuração de Keys · Navegação com Login](./doc/KEY-GUIDE.md#b-登录态浏览命令行配置无-key).

### 3. Controlar o Desktop (✅ Grátis · autorize uma vez, sem key)

- **macOS**: rode `lasso doctor` e siga as instruções para marcar `lasso-rust-helper` em **Accessibility** + **Screen Recording**
- **Windows**: na primeira ação de desktop, o sistema exibe um prompt de autorização — clique em "Allow"
- **Linux**: instale a interface de acessibilidade (GNOME / MATE têm por padrão; se não tiver, `sudo apt install at-spi2-core`)

> Fronteira honesta: o macOS é verificado em hardware real; Windows / Linux passam por autoverificações em tempo de compilação e a nível de contrato, mas o teste manual completo em máquina real está em andamento — não fingimos "totalmente verificado".

**Detalhes** → [Guia de Configuração de Keys · Controle do Desktop](./doc/KEY-GUIDE.md#c-桌面控制系统授权无-key).

### 4. Navegador na Nuvem (desativado por padrão · só para anti-bot pesado)

Anti-bot leve já passa com a antidetecção embutida do `browse_headless` — **se não precisa, não configure**. Para atravessar anti-bot de nível Cloudflare, é preciso o interruptor master + um canal ao mesmo tempo:

```json
{
  "LASSO_ALLOW_CLOUD_BROWSER": true,
  "STEEL_ENDPOINT": "http://localhost:3000"
}
```

- **Steel auto-hospedado (recomendado · grátis)**: sobe com um comando Docker `docker run -p 3000:3000 -p 9223:9223 ghcr.io/steel-dev/steel-browser` — custo zero por sessão, cookies que não saem da sua máquina
- **browserbase hospedado (pago)**: troque para `"BROWSERBASE_API_KEY": "your_key"` — a alternativa sem Docker
- ⚠️ stagehand: canal experimental programático, sem entrada de ferramenta MCP — não conte com ele para extrair páginas

**Como solicitar keys, passos completos para ativar o Steel** → [Guia de Configuração de Keys · Navegador na Nuvem](./doc/KEY-GUIDE.md#d-云浏览器反爬默认关双重解锁)。

<details>
<summary><b>Ajuste avançado (opcional — usuários comuns podem pular)</b></summary>

Você pode **ignorar completamente** o que vem a seguir no uso diário. Estas são apenas para cenários especiais, e a maioria pode ser definida via `lasso config init` em `~/.lasso/config.json` ou sobrescrita via variáveis de ambiente (env vars têm precedência sobre o arquivo de config, útil para trocas temporárias):

- Mudar a porta de debug do Chrome com login (quando a padrão `9222` estiver ocupada)
- Mover os arquivos de cache / estado para outro local
- Restringir só a fontes de busca grátis
- Permitir intranet da empresa / faixas especiais de proxy
- Definir sua própria passphrase para criptografar cookies de login (se não definir, o macOS Keychain é usado)
- Salvar snapshots dos resultados de busca no disco (para testes de regressão)
- Ajustar o tempo de reciclagem automática do navegador headless (`LASSO_HEADLESS_IDLE_MS`, padrão 5 minutos; `0` desativa)
- Ajustar o tempo de "fechar depois do uso" do Chrome do launch-chrome (`LASSO_LAUNCH_IDLE_MS`, padrão 60 segundos; `300000` para 5 minutos, `0` desativa) ou voltar ao lançamento visível (`LASSO_LAUNCH_MODE=visible`)
- Configurar um proxy de saída para os navegadores (`LASSO_PROXY`, ex.: `http://127.0.0.1:7890`; **só afeta os navegadores headless e o Steel na nuvem — a saída do Chrome logado fica sempre como está** — v1.11)
- Definir o endpoint do navegador na nuvem Steel auto-hospedado (`STEEL_ENDPOINT`, ex.: `http://localhost:3000`; precisa também de `LASSO_ALLOW_CLOUD_BROWSER=true` para ativar)

Lista completa de variáveis e padrões: [Guia de Configuração de Keys · Ajuste Avançado](./doc/KEY-GUIDE.md#e-高级调优可选全不配). **Redes proxy TUN do Surge / Clash (fake-ip, `198.18.0.0/15`) e `127.0.0.1` (porta de debug CDP do Chrome local) já são permitidas out of the box**, sem config extra — comportamento de design, não config faltando.

> **Compatível com versões anteriores**: se você instalou antes com `claude mcp add -e KEY=VAL`, essas env variables **continuam funcionando** e **sobrescrevem** o arquivo de config. O arquivo de config é só um caminho adicional, mais amigável — não substitui as env vars.

</details>

---

## Privacidade e Segurança

Seus dados são seus.

- **Cookies de login nunca são exportados**, a menos que você dê opt-in explícito e os tenha criptografado no disco. O Lasso nunca envia seu estado de login para lugar algum às escondidas.
- **Logs de ações no desktop ficam locais** — zero relatório remoto. O Lasso não reporta para casa sobre o que você faz.
- **O navegador na nuvem é desativado por padrão** — exige sua **confirmação dupla explícita** (interruptor master + key) para ativar. Sem isso, a capacidade efetivamente não existe.
- **Sem resolução de 2FA / CAPTCHA / código de verificação** (linha vermelha). Esses sempre exigem você, em pessoa, para passar uma vez no seu navegador local.
- **Estranhos não cutucam seus serviços internos** — acesso à rede interna é negado por padrão; redes proxy TUN do Surge / Clash já são permitidas out of the box, sem config extra.
- **Resultados de busca não são gravados no disco por padrão** — só se você ativar explicitamente o modo de gravação (para testes de regressão).

---

## Solução de Problemas

**Para qualquer problema, o primeiro passo é sempre `lasso doctor`.** Ele faz autoverificação e te diz o que está mal configurado.

| Sintoma | O que fazer |
|---|---|
| Controle do desktop no macOS não funciona | Marque `lasso-rust-helper` em "System Settings → Privacy & Security → Accessibility / Screen Recording" (o `lasso doctor` te guia) |
| Extração de página com login falha | Faça login uma vez manualmente no seu Chrome local (resolva o 2FA também), depois diga "abra meu X logado" |
| Salvar como PDF falha | Diga "tire um screenshot de página inteira desta página" no lugar |
| Busca insiste em não retornar nada | Verifique se a key expirou / a cota se esgotou; adicionar vários provedores (Zhipu + Brave + Bing) reduz drasticamente a taxa de falha |
| Um link não abre | Diga "este link está morto, ache um archive" para consultar a Internet Archive |
| Aviso de que acesso à rede interna foi bloqueado | Confira a URL; redes proxy TUN são permitidas por padrão, outras redes internas precisam de permissão explícita |
| Quer verificar a antidetecção | Rode `lasso doctor --stealth-check` — ele dirige a página de detecção creepjs e compara com a baseline (opcional, não afeta o uso diário) |

FAQ completo e dicas de debug em [`doc/TROUBLESHOOTING.md`](./doc/TROUBLESHOOTING.md).

---

## Para Quem É / Para Quem Não É

**Para quem é**

- **Usuários intensivos do Claude Code** — pesquisam, extraem e controlam o desktop toda semana, e não querem instalar um MCP separado para cada tarefa
- **Pesquisadores / redatores de relatórios / pessoal de dados** — buscam, extraem texto limpo, revivem links mortos, ponta a ponta
- **Quem constrói RAG / bases de conhecimento** — páginas web em markdown limpo, com marcadores de citação, economizando tokens e dinheiro
- **Pessoal de automação / DevOps** — controlam apps nativos do macOS, extraem dashboards internos com login
- **Qualquer um que extrai páginas com login com frequência** — reutiliza a sessão do Chrome local, sem precisar rearmazenar credenciais na config

**Para quem não é**

- **Quem não usa Claude Code ou outro cliente MCP** — o Lasso é um serviço MCP e precisa de um cliente MCP para conduzi-lo
- **Quem só precisa de uma única capacidade e já tem uma solução dedicada** — o tudo-em-um pode ser redundante
- **Quem quer dar bypass em 2FA / CAPTCHA** — linha vermelha; não fazemos, e não faremos.

---

## Apoie o Autor

Se o Lasso te ajuda, pague um café ☕ para o autor

<div align="center">

WeChat | Alipay
:-: | :-:
<img src="doc/support-wechat.jpg" height="200" alt="WeChat sponsor QR"> | <img src="doc/support-alipay.jpg" height="200" alt="Alipay sponsor QR">

</div>

Ou ⭐ [deixe uma Star neste repo](../../stargazers), [abra uma Issue](../../issues), ou [envie um PR](../../pulls) — cada um deles encoraja o autor.

---

## Mais Documentos

- Quer a arquitetura profunda? Veja [Arquitetura de Funcionalidades](doc/08-media-interact-功能架构.md)
- Quer o roteiro de versões? Veja [Cronograma de Implementação](doc/09-media-interact-实施排期.md)
- Quer a obtenção de keys? Veja [Guia de Configuração de Keys](doc/KEY-GUIDE.md)

## Licença

**MIT** © wangdong233. O processo helper do desktop e as dependências do motor do navegador são todos MIT / Apache-2.0 — seguro para uso empresarial.

> Quer a arquitetura interna, os princípios de design, as fronteiras entre plataformas e os comandos de dev? Veja [ARCHITECTURE.md](./ARCHITECTURE.md) e [`doc/TROUBLESHOOTING.md`](./doc/TROUBLESHOOTING.md).

<p align="center">
  <sub>Feito para todos que preferem <strong>falar</strong> em vez de <strong>escrever script</strong>.</sub><br>
  <sub>Instale uma vez — pesquise, extraia, extraia com login, controle o desktop, tudo numa única frase.</sub>
</p>
