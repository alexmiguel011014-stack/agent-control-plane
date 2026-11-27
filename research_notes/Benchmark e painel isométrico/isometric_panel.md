# Painel isométrico operacional para a empresa de IAs

## Referências visuais e linguagem de operação

### Takeaway

O painel pode usar uma vista 2D isométrica para comunicar simultaneamente fluxo, ocupação e saúde do sistema, mas deve copiar somente princípios de composição e hierarquia das referências — nunca sprites, nomes, mapas ou interface de jogos. A referência mais direta para a metáfora de “empresa em operação” é um escritório em salas; a mais importante para não perder a função operacional é manter uma camada textual de status e detalhes fora do mapa.

### Cited Findings

- [OpenTTD: screenshots oficiais](https://www.openttd.org/screenshots) e seu [manual de interface](https://wiki.openttd.org/en/Manual/Game%20interface) mostram um mundo descrito pelo próprio projeto como projeção isométrica/dimétrica, dividido em tiles e combinado com barra de ferramentas, mensagens e janelas. **Lição a adaptar:** o mapa é o panorama; os comandos e detalhes vivem em UI textual previsível, não dentro dos sprites.
- [Project Hospital no Steam](https://store.steampowered.com/app/868360/Project_Hospital/) publica screenshots de um simulador de gestão hospitalar em que departamentos/ambientes são facilmente separáveis no mapa. **Lição a adaptar:** salas delimitadas por função tornam visível onde há gargalo, desde que o painel revele o estado exato ao selecionar a área.
- [Mad Games Tycoon 2 no Steam](https://store.steampowered.com/app/1342330/Mad_Games_Tycoon_2/) se apresenta como gestão de estúdio que inclui escritórios, produção e salas de servidores. **Lição a adaptar:** um layout de empresa pode transformar domínios técnicos em lugares reconhecíveis; para o produto proposto, “sala de servidores” deve significar telemetria real e não uma decoração que simule capacidade inexistente.
- [Software Inc. no Steam](https://store.steampowered.com/app/362620/Software_Inc/) descreve construção de prédios, contratação e gestão de pessoas para entregar software; sua página traz screenshots desse cenário. **Lição a adaptar:** use personagens para dar escala humana a uma fila de trabalho, mas associe cada personagem somente a uma execução/estado de agente que exista no control plane.
- [Project Highrise no Steam](https://store.steampowered.com/app/423580/Project_Highrise/) se identifica como simulador de construção/gestão 2D e mostra os andares como unidades operacionais. **Lição a adaptar:** uma seção/andar pode resumir capacidade e alertas; o painel deve abrir a lista de itens ao clicar, em vez de tentar escrever métricas minúsculas sobre os ambientes.
- A documentação do [Tiled](https://doc.mapeditor.org/en/stable/manual/introduction.html) explica que mapas isométricos criam aparência 3D com tiles em losango, mas que os tiles continuam em grade e a projeção não transforma a arte automaticamente. **Lição a adaptar:** o efeito “2D disfarçado de 3D” pode ser composto com polígonos/tiles simples e coordenadas, sem engine 3D nem ativos artísticos externos.

### Inferences

- Proposta estética: uma pequena sede em diagonal, com base clara, paredes de duas faces e sombras discretas; não pixel-art por obrigação. O primeiro protótipo pode usar formas SVG geométricas e poucos personagens abstratos, evitando custo de produção de sprites e risco de cópia de arte protegida.
- O mapa é uma lente de observabilidade, não uma simulação de empresa. Toda informação que determine uma decisão deve continuar disponível como texto selecionável, pesquisável e navegável por teclado.
- Convenção visual recomendada: verde/amarelo/vermelho somente como reforço de um texto/ícone; nunca como o único sinal. Nenhuma animação deve significar “seguro para executar”.

### Gaps

- Nenhuma das referências prova que uma metáfora de escritório reduz tempo de diagnóstico de um sistema de agentes. Isso deve ser medido em teste de usabilidade com cenários reais, não presumido por parecer intuitivo.
- Ainda não existe uma identidade de marca, conjunto de ícones ou paleta definidos para este projeto; criar arte final antes de validar os estados operacionais seria especulativo.

## Tecnologia, acessibilidade e estratégia de implementação

### Takeaway

Para o hardware e orçamento atuais, o menor risco é **HTML semântico + SVG nativo + CSS**, acompanhado por uma lista/tabela operacional convencional. Canvas e PixiJS são opções posteriores se a área visual realmente crescer; Phaser é desnecessário para o MVP, pois resolve problemas de jogo que o control plane não tem.

### Cited Findings

- SVG expõe elementos e atributos pelo DOM, inclusive valores animáveis, segundo a [documentação SVG da MDN](https://developer.mozilla.org/en-US/docs/Web/API/SVG_API); elementos SVG podem receber foco com [`SVGElement.focus()`](https://developer.mozilla.org/en-US/docs/Web/API/SVGElement/focus). Isso favorece salas como elementos selecionáveis e inspecionáveis com ferramentas normais do navegador.
- A [MDN recomenda CSS para animações DOM simples](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Performance/CSS), alerta que quantidade/tamanho de animações aumenta processamento e recomenda evitar propriedades que causem reflow/repaint. Isso sustenta limitar o mapa a transform/opacidade e pausá-lo quando não é necessário.
- O [`requestAnimationFrame`](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame) acompanha os repaints e costuma ser pausado em abas em segundo plano; a [Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API) permite reagir quando a página fica oculta. Isso é suficiente para pequenos ciclos de personagens, se algum movimento não couber em CSS.
- A [MDN documenta](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Basic_usage) que canvas exige conteúdo alternativo/sub-DOM para não se tornar inacessível; portanto, um canvas interativo não deve ser a única representação de fila, alertas e ações.
- O [PixiJS](https://pixijs.com/guides/components/renderers/) renderiza a cena em canvas por WebGL/WebGL2 ou WebGPU e recomenda WebGL para produção; seu [módulo de acessibilidade](https://pixijs.com/8.x/guides/components/accessibility) é opt-in e cria sobreposição DOM para foco, leitor de tela e eventos. Ele é tecnicamente possível, mas adiciona uma camada que SVG/HTML já têm por padrão no escopo inicial.
- O [Phaser](https://docs.phaser.io/phaser/getting-started/what-is-phaser) é um framework HTML5 de jogos que oferece renderização WebGL e Canvas; seus objetos exigem habilitação explícita para input, conforme a [documentação de input](https://docs.phaser.io/phaser/concepts/input). É gratuito sob [licença MIT](https://phaser.io/download/license), mas o custo relevante aqui seria complexidade, não preço.
- Usuários podem solicitar redução de movimento pelo sistema; a [MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40media/prefers-reduced-motion) define `prefers-reduced-motion` como sinal para reduzir/remover animações não essenciais. O painel precisa respeitar essa preferência e ter também um botão próprio “Pausar animações”.

### Inferences

| Opção | Para o painel pequeno | Acessibilidade | Animação/desempenho | Veredito |
| --- | --- | --- | --- | --- |
| HTML + SVG + CSS | Salas, conectores, indicadores, clique/teclado e zoom simples; sem dependência | Semântica HTML e foco nativos; SVG com `title`/rótulo; tabela lateral é fonte acessível | CSS para pulsos/transições; `requestAnimationFrame` só para caminhada curta; baixo custo se houver poucos elementos | **Escolha do MVP** |
| Canvas 2D nativo + HTML | Desenho livre de muitos tiles/sprites, mas exige hit-testing e sincronização manual | Deve manter controles/descrição alternativos fora do canvas | Bom para cenário compacto; redesenho e interação passam a ser responsabilidade própria | Adiar até SVG ficar comprovadamente limitado |
| PixiJS | Muitos sprites, zoom/pan suave ou centenas de objetos; renderer GPU | Plugin de overlay DOM existe, mas precisa ser implementado e testado | WebGL recomendado pelo projeto; mais bundle e ciclo de cena | Reserva para fase em que métricas provem necessidade |
| Phaser | Jogo completo com cenas, física, mapas e input de game | Possível, porém modelo de Game Objects não é uma UI operacional sem trabalho adicional | Robusto para jogo, excessivo para observabilidade | **Rejeitar no MVP** |

- Arquitetura de interface proposta, sem nova dependência:

```text
eventos auditáveis do control plane
              │
              ├── API local somente leitura / stream de eventos
              │              │
              │              ├── tabela/fila acessível (fonte de verdade visual)
              │              └── SVG isométrico (projeção e navegação)
              │                       │
              │                       └── seleção abre painel lateral textual
              │
              └── ações críticas continuam em diálogo/fluxo textual com confirmação
```

- Componentes iniciais: `OperationalQueue` (tabela), `IsometricOfficeMap` (SVG), `RoomButton` (sala focável), `StatusLegend`, `DetailsDrawer` e um único adaptador de eventos tipados. O SVG recebe dados normalizados; não interpreta logs nem muda a máquina de estados.
- Fórmula/grade: cada sala ocupa coordenadas lógicas `(coluna, linha)` e é projetada como losango (ex.: `x=(coluna-linha)*largura/2`, `y=(coluna+linha)*altura/2`). Paredes e sombra são polígonos SVG derivados dessa grade. Isto produz perspectiva diagonal sem WebGL, câmera 3D ou editor de tiles.
- Prova de baixo risco (uma semana de implementação, depois de existir a API local): seis salas estáticas, até oito marcadores de trabalho, seleção por mouse/Tab/Enter, drawer com eventos reais/simulados tipados, alternância de movimento e layout responsivo. Sem pan livre, zoom livre, drag-and-drop, spritesheet ou geração de arte.
- Critérios de aceitação: (1) toda ação/alerta visível no mapa também aparece na fila textual; (2) Tab chega a cada sala e Enter abre detalhes; (3) `prefers-reduced-motion` e botão de pausa removem ciclos decorativos; (4) 30 minutos de atualização de eventos não causam erro nem perda de leitura; (5) ação de aprovar/cancelar nunca é disparada por clicar em um personagem.

### Gaps

- Não há métrica de volume de eventos, navegador-alvo nem framework da futura UI. Portanto não é responsável cravar FPS, bundle size ou limite numérico de sprites antes de um protótipo instrumentado.
- PixiJS e Phaser não devem ser adicionados apenas por serem gratuitos; uma comparação prática só faz sentido quando o SVG tiver um gargalo reprodutível (por exemplo, muitos objetos móveis simultâneos).

## Mapa de informação, escopo e decisões de produto

### Takeaway

O painel deve representar o fluxo de trabalho do control plane — não inventar departamentos empresariais. Cada sala tem uma fonte de dados, um estado explícito e um único destino de clique. Movimento é decoração somente quando não altera o significado ou esconde atraso/falha.

### Cited Findings

- A [MDN recomenda](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/CSS_and_JavaScript) semântica apropriada e animação sutil com controle para desligá-la; isto é especialmente importante quando a estética de jogo compete com um painel de operação.
- A [MDN alerta](https://developer.mozilla.org/en-US/docs/Web/Accessibility/Guides/Seizure_disorders) que texto em movimento prejudica a experiência e recomenda que o usuário possa parar animações. Portanto métricas, alertas, nomes de tarefas e estados não devem se mover.

### Inferences

Mapa mental proposto:

```text
                        EMPRESA DE IAs (painel local)
                                      │
          ┌───────────────control plane: estados auditáveis───────────────┐
          │                 │                    │                        │
     Entrada/fila       Execução local       Verificação             Aprovação humana
          │                 │                    │                        │
      Recepção         Oficina de agentes     Laboratório             Mesa do engenheiro
      backlog           tarefa/agente          testes/diff              decisão pendente
          │                 │                    │                        │
          └───────────────┴───────────┬────────┴────────────────────────┘
                                       │
                         Arquivo e cofre de orçamento
                         log, artefato, worktree, custo=R$0
```

| Sala / personagem | Dado que representa | Estado visual acionável | Clique/teclado abre | Decoração permitida |
| --- | --- | --- | --- | --- |
| Recepção / mensageiro | tarefas aguardando roteiro/execução | contador `queued`, idade da mais antiga, prioridade | fila filtrada | mensageiro anda uma vez entre chegada e fila; sem andar em loop se houver atraso |
| Oficina de agentes / operador | execução atual por executor local | `running`, etapa, início, timeout e recurso local usado | detalhe da execução e log resumido | operador digita/parado; deslocamento curto apenas na transição de estado |
| Laboratório / verificador | testes, lint, build e diff | `passed`/`failed`/`blocked`, comando e última linha relevante | resultados e artefatos | luz suave acesa enquanto executa; sem “festa” para sucesso |
| Mesa do engenheiro / responsável | aprovações e perguntas reais pendentes | tipo de decisão, impacto, prazo e estado `awaiting_human` | diálogo textual de decisão | envelope aparece; personagem não “aprova” sozinho |
| Cofre / medidor | orçamento e recursos: CPU/RAM/GPU, uso remoto futuro se autorizado | valor medido, limite e bloqueio | telemetria/histórico | ponteiro discreto; não use dinheiro voando ou barra sem número |
| Arquivo / bibliotecário | log imutável, worktree e artefatos | último evento, retenção, integridade | trilha de auditoria | páginas viram lentamente somente se animações estão ligadas |
| Portão de rede (opcional) | política de rede/segredos | `locked`, `requires_approval` ou sessão autorizada | política e justificativa | portão fecha/abre apenas após mudança real de política |

- Separação que deve ser codificada: `operationalState` controla texto, ícone, cor, `aria-label`, ordem da fila e drawer; `ambientAnimation` recebe somente estado derivado e pode ser desligada sem alterar nenhum valor operacional. A UI não deve inferir execução por contagem de frames ou posição do personagem.
- Sequência de entrega recomendada:
  1. Consolidar estados e eventos do orquestrador em contrato tipado e criar tabela textual, sem mapa.
  2. Desenhar wireframe SVG com seis salas e dados mockados determinísticos; validar que cada sala tem pergunta operacional clara.
  3. Ligar o SVG aos mesmos seletores da tabela; adicionar navegação de teclado, drawer e redução de movimento.
  4. Conectar stream local de eventos, testar reconexão e gravar tempos de atualização/erros.
  5. Só então experimentar personagens, iluminação e microanimações; remover qualquer efeito que prejudique leitura.

- Abordagens rejeitadas agora: engine 3D/WebGL como requisito; usar arte/sprites extraídos de jogos; controlar tarefas por drag-and-drop no mapa; esconder logs/erros atrás de animações; inventar “agentes trabalhando” quando o executor está ocioso; usar Phaser/PixiJS antes de medir limitação de SVG; reproduzir telas de jogos em vez de desenhar uma linguagem própria.
- Pergunta de autoverificação para cada recurso: “se eu desabilitar todo movimento, consigo identificar em menos de 10 segundos a tarefa em execução, a falha mais crítica, a decisão humana pendente e onde abrir os detalhes?” Se não, a arquitetura visual está interferindo na operação e deve ser simplificada.

### Gaps

- O modelo definitivo de estados ainda depende da decisão de arquitetura do control plane. Os nomes de salas podem mudar, mas cada uma só deve existir depois que sua fonte de dados e ação de inspeção forem definidas.
- A aceitação estética precisa de referência do usuário (por exemplo: pixel-art nostálgico, low-poly vetorial ou diorama limpo). Sem essa escolha, o documento recomenda deliberadamente wireframe funcional e não direciona produção de arte final.
