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
| "Pegue o texto da homepage do github.com" | Texto limpo do artigo (barras de navegação / anúncios / sujeira removidos — economiza 30–70% em tokens) |
| "Abra meu Jira logado e mostre minhas tarefas" | Um snapshot da página com login (reutiliza seu Chrome local; você resolve o 2FA) |
| "Este link está morto, ache um archive" | O snapshot mais recente da Internet Archive |
| "Liste os arquivos da minha janela atual do Finder" | Uma lista de janelas e controles do desktop (uma árvore semântica, não um screenshot) |
| "Tire um screenshot de página inteira desta página" / "Salve como PDF" | Um caminho de arquivo no disco (nada de blob gigante de imagem despejado no chat) |
| "Quais rastreadores de terceiros esta página carregou?" | Uma lista de recursos com contagem por domínio de rastreador |
| "Liste tudo que eu posso controlar agora" | Uma lista unificada (páginas web e janelas do desktop, tudo nela) |
| "Desligue o dark mode" | Clique / digitação / hotkey automáticos (com verificação de resultado — ele confirma que realmente aconteceu) |
| "Só faz fetch deste JSON endpoint" | Bytes brutos (mais rápido, mais barato) |
| "Este site tem Cloudflare, não consigo extrair" | Bypass anti-bot do Chrome na nuvem (desativado por padrão; você dá opt-in explícito) |
| "O Lasso está configurado corretamente?" | Um relatório de health-check (te diz o que falta) |

> Você não precisa memorizar nenhum nome de capacidade. Basta dizer o que quer — o Claude escolhe o jeito certo de fazer.

---

## 💰 Custo num Relance

O Lasso em si é **completamente grátis + MIT open source**. Veja quanto cada capacidade custa de verdade:

| Capacidade | Custo | Observações |
|---|---|---|
| O próprio Lasso (servidor MCP + todas as capacidades principais) | ✅ Grátis | MIT open source, grátis para sempre |
| Busca (Zhipu + Brave + Bing) | ✅ Plano grátis disponível | Zhipu cobrado por token; Brave **2.000 consultas/mês grátis**, Bing **1.000 consultas/mês grátis** — usável sem pagar |
| Extrair páginas públicas / screenshots / PDF / auditoria de rede / bytes brutos | ✅ Grátis | Roda localmente, sem key, sem pagamento |
| Extrair páginas com login (reutiliza o Chrome local) | ✅ Grátis | Roda localmente, sem key, sem pagamento |
| Controlar o desktop (macOS / Windows / Linux) | ✅ Grátis | Construído e executado localmente, só precisa de autorização do SO; conta Apple Developer de \$99/ano **opcional** para autorização persistente assinada (também funciona sem assinar — basta autorizar de novo a cada vez) |
| Navegador na nuvem (browserbase / stagehand) | ⚠️ Pago, desativado por padrão | Pago após o trial; **não custa nada se você não configurar** — único item pago do Lasso |

> Em uma frase: **enquanto você não ligar o navegador na nuvem, o Lasso custa zero** — a busca tem planos grátis suficientes para o uso diário, e todo o resto é completamente grátis.

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

### Extrair Páginas Públicas (sem login)

> Você: "Pegue o texto de example.com" → texto limpo do artigo, três granularidades disponíveis

Remove automaticamente barras de navegação, anúncios, barras laterais e outras sujeiras — **economiza 30–70% em tokens** (e dinheiro). Precisa de marcadores de citação (ótimo para pesquisa, alimentar RAG)? Uma frase troca o modo.

### Extrair Páginas com Login (mesmo com 2FA)

> Você: "Mostre minhas tarefas do Jira" → snapshot da página com login

Reutiliza **seu Chrome já logado localmente** — você resolve o 2FA uma vez; o Lasso cuida do resto. Funciona para repositórios privados do GitHub, intranets de empresas, conteúdo de assinatura paga, etc.

> 🔴 **Linha vermelha**: o Lasso **nunca resolve 2FA / códigos SMS / CAPTCHA / magic links por você**. Você precisa passar por eles manualmente uma vez no seu Chrome local.

### Buscar Bytes Brutos (mais rápido, mais barato)

> Você: "Faça GET neste JSON endpoint" → bytes brutos

Quando você não precisa renderizar uma página inteira, HTTP direto é **~4× mais rápido e ~4× mais barato** do que passar por um navegador. Detecta automaticamente o tipo de conteúdo (JSON / texto / binário).

### Screenshot / Arquivo

> Você: "Tire um screenshot de página inteira" / "Salve como PDF" → caminho do arquivo no disco

Todas as imagens e PDFs são **salvos no disco e um caminho é retornado** — nada de blob gigante despejado no seu chat desperdiçando contexto.

### Veja o Que uma Página Carrega

> Você: "Quais rastreadores de terceiros esta página carregou?" → lista de recursos com contagem por domínio de rastreador

Identifica automaticamente todo recurso que a página carrega, agrupado por domínio de terceiros — útil para detectar risco de privacidade e gargalos de desempenho.

### Controlar Apps Nativos do Desktop

> Você: "Desligue o dark mode" / "Leia o primeiro item da minha caixa do Mail" → ação automatizada (com verificação)

No macOS você controla Finder / Mail / Safari / Notes / System Settings e qualquer app nativo. **Windows e Linux também funcionam** (veja a fronteira honesta abaixo). Cada ação é verificada — ele confirma "realmente aconteceu", nunca falso sucesso.

> **Fronteira honesta**: o macOS é verificado em hardware real; Windows / Linux passam por autoverificações em tempo de compilação e a nível de contrato, mas o teste manual completo em máquina real ainda está em andamento. **Não fingemos "totalmente verificado em Win/Linux".**

### Agendamento Unificado entre Web e Desktop

> Você: "Liste tudo que eu posso controlar agora" → uma lista unificada

Páginas web e janelas do desktop compartilham uma lista — você não precisa distinguir "isto está no navegador" vs "isto está no desktop". O Claude escolhe sobre o que agir, e tudo flui a partir daí.

### Reviver Links Mortos

> Você: "Este link dá 404" → o snapshot mais recente da Internet Archive

Recorre à Internet Archive (Wayback Machine) para encontrar a última cópia arquivada daquela URL. **Nunca trata um link vivo como morto** — só procura quando você diz "isto sumiu".

### Bypass Anti-Bot (desativado por padrão)

> Você: "Este site tem Cloudflare, não consigo extrair" → anti-bot do Chrome na nuvem

**Completamente desativado por padrão.** Só ativa quando você liga explicitamente E configurou uma key de navegador na nuvem. Você não precisa disso para páginas normais.

---

## Instalação

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
| Extrair sites protegidos por Cloudflare | Confirmação dupla + uma key de nuvem | Desativado por padrão; precisa do seu opt-in explícito |

Abaixo, cada um dos quatro módulos é detalhado com o caminho mais curto até "simplesmente funciona".

### 1. Busca (✅ Grátis · plano grátis; uma key para começar, três para quase zero falhas)

**O que faz**: Pesquisa qualquer coisa, retorna resultados estruturados (título, snippet, link).

**Precisa de key**: Sim — uma key da Zhipu (grátis para solicitar) já basta.

**Como configurar**:

```bash
lasso config init        # cria o template ~/.lasso/config.json
```

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

**Como configurar**: Execute o comando abaixo uma vez. Ele detecta automaticamente seu Chrome local e reutiliza todas as sessões nas quais você já está logado (inclusive aquelas em que você já passou o 2FA):

```bash
lasso launch-chrome
```

Depois disso, diga "abra meu Jira logado" ao Claude e ele se conecta automaticamente.

> 🔴 **Linha vermelha**: 2FA / códigos SMS / CAPTCHA / magic links — o Lasso nunca resolve isso por você. Você precisa passar por eles manualmente uma vez no seu Chrome local.

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

### 4. Anti-Bot na Nuvem (⚠️ Pago, desativado por padrão · exige confirmação dupla)

**O que faz**: Extrai sites protegidos por Cloudflare ou por proteção anti-bot pesada.

**Precisa de key**: Sim — e só ativa quando **você liga explicitamente**.

**Como configurar**: As duas condições abaixo precisam ser atendidas ao mesmo tempo:

1. Interruptor master: defina `LASSO_ALLOW_CLOUD_BROWSER` como `true`
2. Pelo menos uma key de nuvem (browserbase ou stagehand — escolha uma)

Escreva em `~/.lasso/config.json`:

```json
{
  "LASSO_ALLOW_CLOUD_BROWSER": true,
  "BROWSERBASE_API_KEY": "your_browserbase_key"
}
```

> Desativado por padrão — sem config, essa capacidade não existe. Você não precisa dela para páginas normais, **e só ativa quando você dá opt-in explícito**.

**Como solicitar keys de nuvem, cotas de trial** → veja o [Guia de Configuração de Keys · Navegador na Nuvem](./doc/KEY-GUIDE.md#d-云浏览器反爬默认关双重解锁).

<details>
<summary><b>Ajuste avançado (opcional — usuários comuns podem pular)</b></summary>

Você pode **ignorar completamente** o que vem a seguir no uso diário. Estas são apenas para cenários especiais, e a maioria pode ser definida via `lasso config init` em `~/.lasso/config.json` ou sobrescrita via variáveis de ambiente (env vars têm precedência sobre o arquivo de config, útil para trocas temporárias):

- Mudar a porta de debug do Chrome com login (quando a padrão `9222` estiver ocupada)
- Mover os arquivos de cache / estado para outro local
- Restringir só a fontes de busca grátis
- Permitir intranet da empresa / faixas especiais de proxy
- Definir sua própria passphrase para criptografar cookies de login (se não definir, o macOS Keychain é usado)
- Salvar snapshots dos resultados de busca no disco (para testes de regressão)

Lista completa de variáveis e padrões: [Guia de Configuração de Keys · Ajuste Avançado](./doc/KEY-GUIDE.md#e-高级调优可选全不配). **Redes proxy TUN do Surge / Clash (fake-ip) já são permitidas out of the box.**

> **Compatível com versões anteriores**: se você instalou antes com `claude mcp add -e KEY=VAL`, essas env variables **continuam funcionando** e **sobrescrevem** o arquivo de config. O arquivo de config é só um caminho adicional, mais amigável — não substitui as env vars.

</details>

---

## Privacidade e Segurança

Seus dados são seus.

- **Cookies de login nunca são exportados**, a menos que você dê opt-in explícito e os tenha criptografado no disco. O Lasso nunca envia seu estado de login para lugar algum às escondidas.
- **Logs de ações no desktop ficam locais** — zero relatório remoto. O Lasso não reporta para casa sobre o que você faz.
- **O navegador na nuvem é desativado por padrão** — exige sua **confirmação dupla explícita** (interruptor master + key) para ativar. Sem isso, a capacidade efetivamente não existe.
- **Sem resolução de 2FA / CAPTCHA / código de verificação** (linha vermelha). Esses sempre exigem você, em pessoa, para passar uma vez no seu navegador local.
- **Estranhos não cutucam seus serviços internos** — acesso à rede interna é negado por padrão; redes proxy TUN do Surge / Clash já são permitidas out of the box.
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

## Licença

**MIT** © wangdong233. O processo helper do desktop e as dependências do motor do navegador são todos MIT / Apache-2.0 — seguro para uso empresarial.

> Quer a arquitetura interna, os princípios de design, as fronteiras entre plataformas e os comandos de dev? Veja [ARCHITECTURE.md](./ARCHITECTURE.md) e [`doc/TROUBLESHOOTING.md`](./doc/TROUBLESHOOTING.md).

<p align="center">
  <sub>Feito para todos que preferem <strong>falar</strong> em vez de <strong>escrever script</strong>.</sub><br>
  <sub>Instale uma vez — pesquise, extraia, extraia com login, controle o desktop, tudo numa única frase.</sub>
</p>
