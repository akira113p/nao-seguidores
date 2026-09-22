# Não Seguidores

Extensão de navegador (Chromium / Chrome / Opera / Edge) para revisar quem você segue no Instagram: descobre quem **não te segue de volta**, separa os perfis por tamanho de conta, e dá uma tela de triagem em que você assiste um reel por perfil e decide manter ou deixar de seguir.

Manifest V3. Sem dependências, sem build, sem servidor — cinco arquivos e três ícones.

---

## O que ela faz

| Aba | Conteúdo |
|---|---|
| **Pessoas** | Quem não te segue de volta, com menos de 3.000 seguidores |
| **Contas** | Quem não te segue de volta, com 3.000 ou mais |
| **Amigos** | Quem você segue **e** também te segue (calculado sob demanda) |
| **Scroll** | Triagem: um reel por conta, decisão por teclado |
| **Stories** | A barra de stories separada em Pessoas/Contas e visto/não visto |

Passar o mouse (ou segurar o dedo e arrastar) sobre qualquer linha abre um cartão com foto, seguidores, publicações e bio.

### Triagem no Scroll

Abre a página de reels do perfil numa aba ao lado e espera sua decisão:

| Tecla | Ação |
|---|---|
| `↓` / `S` | mantém seguindo, próxima conta |
| `→` / `D` | deixa de seguir, próxima conta |
| `←` / `A` | outro reel da mesma conta |
| `M` | liga/desliga o som |

As teclas funcionam nas duas abas — a de reels e a do painel. O progresso é gravado, e o filtro "Não revisados" permite continuar de onde parou.

---

## Instalação

Não está publicada em loja nenhuma. Carregue sem compactar:

1. Baixe ou clone este repositório
2. Abra `chrome://extensions` (ou `opera://extensions`, `edge://extensions`)
3. Ative o **modo desenvolvedor**
4. **Carregar sem compactação** → selecione a pasta do projeto
5. Clique no ícone da extensão — ela abre o Instagram e injeta o painel

Você precisa estar logado no Instagram na aba que abrir.

---

## Como funciona por dentro

A parte interessante deste projeto é que quase toda API privada do Instagram que serviria para isso está fechada. O que existe aqui é uma sequência de contornos.

### Descobrir quem não te segue

O caminho ideal seria `friendships/show_many/`, que responde `followed_by` para 100 IDs numa requisição — dispensaria baixar a lista de seguidores inteira. Ele é tentado em três hosts e **falha em todos**:

| Endpoint | Resposta |
|---|---|
| `i.instagram.com/api/v1/friendships/show_many/` | JSON `{status: "fail"}` — existe, mas exige assinatura que só o app gera |
| `www.instagram.com/api/v1/friendships/show_many/` | HTML de 640 KB — a rota não existe nesse host |
| `www.instagram.com/web/friendships/show_many/` | 404 |

Então o código cai sozinho para o método clássico: baixa as duas listas paginadas e compara com um `Set` (busca O(1) em vez de percorrer array). A falha fica memorizada por 24h para não desperdiçar três requisições em toda varredura.

### Dois controladores de ritmo

Requisições de leitura e de escrita têm riscos diferentes, então têm ritmos separados. Ambos serializam o **intervalo**, não as requisições — assim N conexões paralelas escondem a latência da rede sem multiplicar a taxa:

- **Varredura** (`pace`): ~900 ms entre páginas, micro-pausas de 3,5–9 s a cada 12–20 requisições, jitter em distribuição de sino em vez de `random()` plano.
- **Classificação** (`reader`): começa em 140 ms e **acelera sozinho** até 70 ms enquanto o Instagram não reclamar. Qualquer 429 triplica o intervalo na hora, e as 10 conexões desaceleram juntas.

Respostas HTTP 200 que na prática são bloqueio (`feedback_required`, `checkpoint_required`, `spam`) param tudo e avisam, em vez de insistir — insistir é o caminho mais curto para a conta ser marcada como automação.

Unfollows entram numa fila com espaçamento aleatório de 1,4–3,4 s e disparam um alerta a cada 15, sem travar.

### Cache com validade variável

O número de seguidores é guardado com prazo proporcional à distância do corte de 3.000:

| Seguidores | Revalida em |
|---|---|
| 80 · 450 | 45 dias |
| 1.500 · 4.800 | 10 dias |
| 2.900 · 3.100 | 3 dias |

Errar a contagem de uma conta com 80 seguidores não muda a classificação; uma com 2.900 pode cruzar o limite em dias. A segunda execução da separação fica praticamente instantânea.

### Reels sem API

Toda fonte de mídia está fechada (`clips/user` → 400, `feed/user` → HTML, `web_profile_info` → 429 persistente). A solução foi parar de pedir dados e passar a **carregar a página**: o service worker reaproveita uma única aba, troca a URL para `/usuario/reels/`, e um script injetado ali sorteia um thumbnail da grade e clica nele. Navegação comum não entra na cota de API.

Esse script também captura as teclas e devolve a decisão ao painel, porque com a aba de reels em foco o teclado não chega à aba do painel.

### Visto / não visto nos stories

O Instagram não expõe esse estado em atributo nenhum — ele desenha o anel num `<canvas>`, colorido quando há story novo e cinza quando já foi visto. O código lê os pixels do canvas e mede a **saturação**:

```
degradê do Instagram   sat 0.83  →  não visto
cinza (dark ou light)  sat 0.00  →  já visto
```

Cinza tem saturação zero por definição, o que dá uma separação limpa com folga do limiar de 0,35. O username completo sai do `alt` da imagem, porque o texto sob o avatar vem truncado.

---

## Limitações conhecidas

- **`friendships/show_many` está morto.** A varredura usa o método lento (baixa a lista de seguidores inteira), limitado a 10.000 seguidores.
- **A barra de stories só é lida na página inicial**, e pelo DOM só vem o que está renderizado — role a barra horizontalmente e recarregue para ver mais.
- **Seletores de DOM quebram.** O Instagram muda a estrutura com frequência; a abertura automática do reel e a leitura da barra de stories são os pontos frágeis.
- **URLs de foto de perfil expiram** em algumas horas.
- Testada em Opera e Chrome, no Instagram em português.

---

## Aviso

Automatizar ações no Instagram vai contra os Termos de Uso da plataforma, e contas podem ser limitadas ou bloqueadas. Todo o cuidado com ritmo e pausas descrito acima reduz o risco, mas não elimina.

**Teste numa conta secundária antes de usar na principal.** Use por sua conta e risco.

Nada sai da sua máquina: não há servidor, telemetria nem envio de dados. As requisições vão direto do seu navegador para o Instagram, com a sua própria sessão, e o cache fica no `localStorage` do domínio.

---

## Origem

Começou a partir da extensão [Não Seguidores da invertexto](https://chromewebstore.google.com/detail/n%C3%A3o-seguidores/ficpdcopfgoclcbnkkiobonmgpjcmfef), da qual herdou a estrutura inicial, o manifest e parte do CSS. O `contentScript.js` foi reescrito por completo, e as abas Amigos, Scroll e Stories, os controladores de ritmo, o cache e a arquitetura de abas não existem no original.
