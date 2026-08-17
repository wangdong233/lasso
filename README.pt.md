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

**Versão atual v1.13.0** (v1.13: 7 ajustes da camada de implementação (3ª rodada de revisão de otimalidade): **consistência da impressão de idioma do navegador headless** — o cabeçalho HTTP `Accept-Language` agora segue o perfil stealth (antes era enviado o valor real do host: numa máquina chinesa com perfil inglês, aparecia a contradição "cabeçalho zh-CN ↔ página en-US"), e o `navigator.languages` também passa a seguir o perfil; **correção do ponto de impacto das capturas VLM com região** — no cenário `screenshot_region`, as coordenadas inferidas pelo VLM são convertidas de volta para coordenadas de tela cheia (antes havia desvio sistemático da origem da região, ainda relatando sucesso); **`desktop find` rejeita queries puramente por ref** — `where` só aceita text / role; query ref pura retorna honestamente invalid_params (antes degradava silenciosamente para casar a árvore inteira, explodindo tokens e fingindo sucesso); **saída mais rápida e estável** — a liberação de sessão Steel ganhou teto de 3 segundos (com um Steel auto-hospedado parado, a saída do CC não trava mais por até 5 minutos); quando falta a permissão de síntese de entrada do macOS no modo VLM, mensagem clara "autorização necessária" em vez de falha vaga; v1.12: 14 ajustes da camada de implementação (2ª rodada de revisão de otimalidade): **dupla ativação da extração markdown** — extratores dedicados por site do defuddle (HN / Reddit / GitHub / Wikipedia / Substack / Medium etc., mais de 20 sites) + conversão fiel de tabelas / fórmulas (tabelas GFM não perdem mais a estrutura; links relativos viram absolutos; a saída pode conter dialetos Obsidian como `==destaque==`, notas de rodapé `[^N]`); **impressão digital padrão do navegador headless alinhada ao sistema host** — no macOS, impressão macOS Chrome por padrão (elimina a contradição "UA diz Windows, client hints entregam macOS"; o doctor avisa sobre desvio de versão em relação ao Chrome instalado); **honestização do fim da cadeia desktop** — a inferência por captura VLM não mente mais sobre sucesso (executa de verdade quando dá, senão unknown honesto); `wait/expect` exige dois acertos consecutivos (elementos fugazes no carregamento não geram mais falso sucesso); `snapshot` marca `truncated:true` no topo quando trunca; `find` anexa aos nós encontrados a lista de ações executáveis; **correção de campos de entrada Electron** — controles que engolem AXSetValue (Slack / VSCode etc.) fazem o type degradar automaticamente para "foco + síntese de teclado" (ASCII); **drag-and-drop fica utilizável** — pressão de 200 ms + trajetória interpolada em 12 pontos + assentamento de 100 ms (sliders e ordenação por arrastar vão de provável fracasso a utilizáveis); **consistência de freshness ponta a ponta** — machine_mcp e o fallback DuckDuckGo não descartam mais silenciosamente o parâmetro de temporalidade; em saída anormal do CC, o processo Lasso faz a limpeza imediata (antes ficava pendurado até 1 hora); v1.11 fecha a dimensão de implementação da "alça de interação universal": **o desktop passa de "enxergar" para "clicar"** — click / type / scroll do `desktop` agora executam de verdade (clique semântico AXAPI + verificação escrever-e-ler-de-volta + erro honesto para referências vencidas), além de ações de mouse por coordenadas (arrastar / roda / mover, fallback canvas / Electron) e a poda de árvore `skeleton` (grande queda de tokens em apps densos); **camada de driver atualizada chrome-devtools-mcp 0.3.0 → 1.7.0** (11 meses e 57 releases de benefícios; antidetecção em nível de lançamento UA / viewport; telemetria upstream desligada por padrão); **search ganha filtro de tempo `freshness`** (day / week / month / year repassados a todos os motores — checar notícias / versões sem escrever datas na query); o fallback sem key para queries em inglês trocou de Baidu para DuckDuckGo; novo `LASSO_PROXY`, proxy de saída do navegador (só afeta navegadores headless / nuvem — a saída do Chrome logado fica intacta); v1.10 navegador silencioso por padrão + fecha ao acabar: `launch-chrome` inicia por padrão sem janela e sem incomodar (adaptado a macOS / Windows, `--mode visible` para voltar), sempre com antithrottling em segundo plano e mudo; durante a execução do servidor, fecha automaticamente ~60 s após o último uso (`LASSO_LAUNCH_IDLE_MS` ajustável; a semântica de 5 minutos fica disponível com 300000); v1.9 completa o fim de vida do navegador: headless reciclado automaticamente após 5 minutos ocioso, `lasso chrome-stop` fecha segundo o registro os Chromes que o Lasso abriu, `tab_restore` restaura sua lista original de abas — veja "Limpeza depois do uso" acima; v1.8 corrigiu os 24 defeitos expostos pelo teste completo: adaptação ao contrato do chrome-devtools-mcp@0.3.0 upstream, screenshots realmente salvos em disco, sonda de vida do launch-chrome, fiação da cota por chamada, ferramenta de paginação `read_text` etc. — lista completa em [doc/17-功能测试清单.md](doc/17-功能测试清单.md), seção "v1.8 修复记录".)

**Pré-requisitos**: Node.js ≥ 20; Claude Code (ou qualquer cliente compatível com MCP).

```bash
# Claude Code (recomendado)
claude mcp add lasso -- npx -y lasso-mcp
```

Reinicie o Claude Code → `/mcp` → `lasso ✓ Connected`. **É só isso — sem keys no comando de instalação.** Navegação / screenshots / PDF / controle do desktop funcionam imediatamente (busca é a única exceção — veja [Configuração](#configuração)).

**Usuários de macOS que querem controle do desktop**: execute `lasso doctor` uma vez e siga as instruções para marcar `lasso-rust-helper` em "System Settings → Privacy & Security", tanto em Accessibility quanto em Screen Recording (o `doctor` te guia — não precisa procurar o caminho sozinho).

---

## Configuração

**A instalação é zero config** — o comando de instalação acima já ativa navegação / fetch / screenshots / PDF / inspeção de recursos de terceiros / controle do desktop. **Só a busca precisa de key.**

### Consulte pelo que você quer fazer

| O que você quer | O que configurar | O que destrava |
|---|---|---|
| Extrair páginas públicas / screenshots / PDF / ver rastreadores / buscar bytes brutos / controlar desktop | **Nada** | Funciona logo após instalar |
| Busca | Uma key da Zhipu (grátis para solicitar) | A entrada principal de busca |
| Quase zero falhas na busca (múltiplas fontes) | Adicione keys da Brave / Bing (ambas têm planos grátis) | Faz fail-over automático se uma cair — você nem percebe |
| Extrair páginas com login | Execute `lasso launch-chrome` uma vez | Reutiliza sua sessão do Chrome local |
| Controlar o desktop do macOS | Execute `lasso doctor` uma vez | Controla apps nativos |
| Extrair sites protegidos por Cloudflare | Confirmação dupla + um canal de navegador na nuvem (Steel auto-hospedado grátis / hospedado pago) | Desativado por padrão; precisa do seu opt-in explícito |

Abaixo, cada um dos quatro módulos é detalhado com o caminho mais curto até "simplesmente funciona".

### 1. Busca (✅ Grátis · plano grátis; uma key para começar, três para quase zero falhas)

**O que faz**: Pesquisa qualquer coisa, retorna resultados estruturados (título, snippet, link).

**Precisa de key**: Sim — mas se a sua máquina já tem o MCP `web-search-prime` da Zhipu configurado (no `mcpServers` do `~/.claude.json` local, com type=http + Authorization), **o Lasso detecta na inicialização e reutiliza essa key como fonte preferida — sem precisar configurar um ZHIPU_API_KEY separado**. Se o MCP da máquina for limitado ou falhar, fallback automático para a key própria do Lasso (preencha abaixo). Rode `lasso doctor` e veja se `#36 machine_search_mcp` está `pass` (host=open.bigmodel.cn) ou `warn` (não detectado).

> Ordem de prioridade com zero config: reuso do MCP da máquina → `ZHIPU_API_KEY` do Lasso → Brave → Bing → fallback `browse_headless`. O primeiro que falha passa para o próximo — você nem percebe.

**Como configurar** (só se não tiver o MCP da máquina / quiser uma key independente):

```bash
lasso config init        # cria o template ~/.lasso/config.json
lasso --version          # mostra o número de versão (desde a v1.8)
lasso --help             # uso de todos os subcomandos
```

> Desde a v1.8 a linha de comando segue convenções normais: subcomando desconhecido / argumento desconhecido imprime o uso e sai com código não zero — não cai mais silenciosamente no modo servidor MCP esperando entrada.

Abra `~/.lasso/config.json` e preencha:

```json
{
  "ZHIPU_API_KEY": "your_zhipu_key"
}
```

**Quer mais robustez** (altamente recomendado): adicione Brave e Bing também — ambas têm planos grátis. Se uma fonte qualquer for limitada por taxa ou estiver fora do ar, ele alterna para a próxima e você nem percebe:

```json
{
  "ZHIPU_API_KEY": "your_zhipu_key",
  "BRAVE_API_KEYS": "bravekey1,bravekey2,bravekey3",
  "BING_API_KEYS": "bingkey1,bingkey2"
}
```

> Separe várias keys com vírgulas — N keys te dão N× a cota grátis, com rotação automática.

Os nomes das keys são iguais aos da tabela acima — basta preencher. Salve o arquivo; o Lasso pega na próxima inicialização.

**Como solicitar keys, cotas dos planos grátis, detalhes de rotação com várias keys** → veja o [Guia de Configuração de Keys · Busca](./doc/KEY-GUIDE.md#a-搜索).

### 2. Extrair Páginas com Login (✅ Grátis · sem key, execute um comando)

**O que faz**: Extrai páginas nas quais você está logado — tarefas do Jira, repositórios privados do GitHub, intranets de empresas, conteúdo de assinatura paga.

**Precisa de key**: Não.

**Como configurar**: Execute o comando abaixo uma vez. Ele encontra automaticamente seu Chrome local e o inicia com porta de debug. Desde a v1.8, usa por padrão um **perfil dedicado** do Lasso (o Chrome 136+ não permite porta de debug no perfil padrão — o método antigo fechava na hora); faça login nas suas contas uma primeira vez nessa janela (2FA por sua conta), e depois **o login desse perfil fica reutilizado para sempre**:

```bash
lasso launch-chrome
```

Depois de iniciar, o Lasso sonda a porta de debug (verificação nível `curl /json/version`): Chrome não subiu / porta ocupada → **erro explícito**, acabou o "retornou sucesso mas não conecta". Para reutilizar um diretório de perfil existente: `lasso launch-chrome --profile <diretório>`.

**Desde a v1.10, "trabalho silencioso" por padrão**: esse Chrome **inicia sem janela, sem roubar seu teclado / foco, sempre mudo** — você escreve código em primeiro plano enquanto ele extrai páginas atrás, sem um incomodar o outro (o único rastro perceptível é um ícone de Chrome a mais no Dock / barra de tarefas, impossível de remover no nível do SO). Para vê-lo trabalhar: `lasso launch-chrome --mode visible` (ou `"LASSO_LAUNCH_MODE": "visible"` no `~/.lasso/config.json`).

Depois disso, diga "abra meu Jira logado" ao Claude e ele se conecta automaticamente.

> 🔴 **Linha vermelha**: 2FA / códigos SMS / CAPTCHA / magic links — o Lasso nunca resolve isso por você. Você precisa passar por eles manualmente uma vez no seu Chrome local.

**Limpeza depois do uso (desde a v1.10, quase nada para gerenciar)**: com o servidor rodando, esse Chrome **se fecha automaticamente ~60 s depois do último uso** (terminou, fechou — sem esperar e sem lembrar de fechar). Para ajustar o limiar: `LASSO_LAUNCH_IDLE_MS=300000` volta para 5 minutos, `=1000` chega perto do instantâneo (ao custo de ~11 s de re-cold-start para operações espaçadas), `=0` desativa o fechamento automático. Para liberar uma tarefa longa pontual: `lasso launch-chrome --idle-ms 3600000`. Fechamento manual sempre possível (só os Chromes que o próprio Lasso abriu, com propriedade verificada — nunca os seus abertos à mão):

```bash
lasso chrome-stop          # fecha todos os Chromes abertos pelo Lasso (registro)
lasso chrome-stop --port 9222   # fecha só o da porta indicada
```

> Fronteira honesta: rodar `lasso launch-chrome` sozinho (sem o servidor) não tem fechamento idle automático — a saída continua sendo `chrome-stop`; o `browse_logged_in` conectado ao **seu Chrome visível aberto por você** é "pouco intrusivo, não zero intrusão" (limitação upstream da plataforma macOS — algumas ações podem roubar o foco uma vez) — para silêncio puro, use o modo hidden aberto pelo próprio lasso ou o `browse_headless`; o canal `desktop` simula teclado / mouse reais, **por design ocupa o teclado e o mouse físicos** — não existe forma silenciosa.

As abas que o `browse_logged_in` abre no seu Chrome: ao fim da tarefa, diga `admin {action:"tab_restore", reason:"tarefa concluída"}` — as abas abertas pelo Lasso fecham e sua lista original é restaurada (também acontece automaticamente na saída do servidor). O navegador headless, por padrão, é **reciclado automaticamente após 5 minutos sem uso** — não fica residente comendo memória; para economizar cold-start em uso intenso, `LASSO_HEADLESS_IDLE_MS=3600000` (1 hora); `0` desativa completamente.

**Detalhes** → [Guia de Configuração de Keys · Navegação com Login](./doc/KEY-GUIDE.md#b-登录态浏览命令行配置无-key).

### 3. Controlar o Desktop (✅ Grátis · sem key, autorize uma vez no seu SO)

**O que faz**: Controla apps nativos no macOS / Windows / Linux (clicar, digitar, ler conteúdos de janelas, executar atalhos de teclado).

**Precisa de key**: Não.

**Como configurar** (escolha seu SO):

- **macOS**: Execute `lasso doctor` uma vez e siga as instruções para marcar `lasso-rust-helper` em "System Settings → Privacy & Security", tanto em **Accessibility** quanto em **Screen Recording**. O `doctor` te guia — não precisa procurar o caminho.
- **Windows**: Na primeira vez que você pedir ao Claude para fazer uma ação no desktop, o sistema exibe um prompt de autorização — clique em "Allow" (equivalente ao Accessibility do macOS).
- **Linux**: Garanta que a interface de acessibilidade esteja instalada (a maioria dos desktops GNOME / MATE já tem por padrão; se não tiver, `sudo apt install at-spi2-core`).

> **Fronteira honesta**: o macOS é verificado em hardware real; Windows / Linux passam por autoverificações em tempo de compilação e a nível de contrato, mas o teste manual completo em máquina real ainda está em andamento. **Não fingimos "totalmente verificado em Win/Linux".**

**Detalhes** → [Guia de Configuração de Keys · Controle do Desktop](./doc/KEY-GUIDE.md#c-桌面控制系统授权无-key).

### 4. Navegador na Nuvem: Auto-Hospedado ou Hospedado (auto-hospedado grátis / hospedado pago, desativado por padrão · confirmação dupla para ligar)

**O que faz**: Extrai sites guardados por Cloudflare ou anti-bot pesado (anti-bot leve já passa com a antidetecção embutida do `browse_headless` — esta seção é só para o pesado).

**Precisa de key**: Depende do caminho. Três canais de nuvem à escolha — **só o caminho hospedado precisa de key**:

- **(a) Steel auto-hospedado (recomendado · grátis)**: rode um navegador na nuvem open source em Docker local — **custo zero por sessão + cookies que nunca saem da sua máquina**. Sem key para solicitar; basta rodar o Docker você mesmo.
- **(b) browserbase hospedado (pago)**: 100 minutos de trial, depois paga por uso.
- **(c) stagehand hospedado (pago)**: observação de página amigável a IA, mais para experimentar. ⚠️ **Canal experimental programático** — mesmo com a key configurada, **não há entrada de ferramenta MCP** (contrato REST não verificado em runtime; `lasso doctor` #39 testa exatamente isso); para realmente atravessar anti-bot, escolha Steel ou browserbase.

**Como configurar**: As duas condições ao mesmo tempo —

1. Interruptor master: defina `LASSO_ALLOW_CLOUD_BROWSER` como `true`
2. Pelo menos um canal de nuvem — Steel (defina `STEEL_ENDPOINT`) ou browserbase (a key correspondente); a key do stagehand só monta o canal experimental interno, sem expor ferramenta

**Config mínima · Steel auto-hospedado (grátis, recomendado)**:

```json
{
  "LASSO_ALLOW_CLOUD_BROWSER": true,
  "STEEL_ENDPOINT": "http://localhost:3000"
}
```

O Steel sobe com um comando Docker: `docker run -p 3000:3000 -p 9223:9223 ghcr.io/steel-dev/steel-browser`. Passos completos de ativação no [Guia de Keys · Steel](./doc/KEY-GUIDE.md#steel_endpoint--自托管云浏览器v16-新推荐免费).

**Config mínima · browserbase hospedado (pago)**:

```json
{
  "LASSO_ALLOW_CLOUD_BROWSER": true,
  "BROWSERBASE_API_KEY": "your_browserbase_key"
}
```

> Desativado por padrão — sem config, essa capacidade não existe. Você não precisa dela para páginas normais, **e ela só ativa com o seu opt-in explícito**. Anti-bot leve não precisa de navegador na nuvem — a antidetecção embutida do `browse_headless` resolve.

**Como solicitar keys hospedadas, como ativar o Steel Docker** → veja o [Guia de Configuração de Keys · Navegador na Nuvem](./doc/KEY-GUIDE.md#d-云浏览器反爬默认关双重解锁).

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
