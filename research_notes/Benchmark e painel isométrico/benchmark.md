# Benchmark local, reprodutível e de custo recorrente zero

## Benchmarks e harnesses que inspiram o desenho

### Takeaway
Não há um benchmark público que deva ser executado integralmente neste computador como MVP. SWE-bench e Terminal-Bench são boas referências para o **formato** (tarefa, estado inicial, verificador, limite e trilha), mas a dependência de contêineres e de imagens grandes conflita com a meta local/Windows/zero recorrente. HumanEval, MBPP e EvalPlus ajudam a desenhar testes determinísticos pequenos, mas não medem a orquestração de um agente em repositório.

### Cited Findings
- SWE-bench foi proposto com 2.294 problemas extraídos de issues e PRs de 12 repositórios Python; sua documentação atual usa um harness Docker. — [SWE-bench paper](https://arxiv.org/abs/2310.06770); [quickstart oficial](https://www.swebench.com/SWE-bench/guides/quickstart/)
- A própria documentação de Docker do SWE-bench pede Docker/WSL 2 no Windows, recomenda 16 GB+ de RAM e 120 GB livres; o cache por instância pode chegar a aproximadamente 2 TB. — [guia Docker oficial](https://github.com/SWE-bench/SWE-bench/blob/main/docs/guides/docker_setup.md)
- O conjunto SWE-bench Verified tem 500 instâncias revisadas por humanos, mas a OpenAI informou em 2026 que o conjunto se tornou contaminado e encontrou problemas materiais de teste/descrição em 59,4% de 138 casos auditados. Logo, ele não deve ser usado como número de capacidade do nosso projeto. — [OpenAI: retirada do SWE-bench Verified](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)
- Terminal-Bench mede tarefas de terminal em ambientes Docker; sua publicação descreve cada tarefa como instrução, imagem Docker, testes, solução de exemplo e limite de tempo. — [paper](https://arxiv.org/abs/2601.11868); [anúncio do projeto](https://www.tbench.ai/news/announcement)
- HumanEval é um conjunto de conclusão de funções. O repositório alerta que executa código gerado não confiável e recomenda um sandbox robusto; o próprio `reliability_guard` afirma não ser sandbox de segurança. — [README](https://github.com/openai/human-eval/blob/master/README.md); [código de execução](https://github.com/openai/human-eval/blob/master/human_eval/execution.py)
- MBPP contém cerca de mil problemas Python de fundamentos, cada um com enunciado, solução e três testes; seu split oficial separa IDs de teste, validação e treino. — [README do MBPP](https://github.com/google-research/google-research/blob/master/mbpp/README.md)
- EvalPlus estende testes de HumanEval/MBPP e relata uma expansão de 80 vezes dos casos de teste do HumanEval, uma referência útil para não confiar em apenas um caso feliz. — [paper EvalPlus](https://arxiv.org/abs/2305.01210); [CLI do projeto](https://github.com/evalplus/evalplus/blob/master/docs/cli.md)

### Inferences
- Usar os projetos acima como **bibliografia de design**, não como dependência do MVP: copiar o modelo “baseline + enunciado + testes independentes + log” e escrever fixtures próprias, pequenas e versionadas. Isso evita Docker/WSL2, download de imagens e resultados contaminados.
- Não importar trechos de tarefa/solução sem checar a licença de cada fonte. Para o nosso corpus interno, tarefas autorais eliminam essa questão e permitem publicar a licença escolhida depois.
- O MVP deve ter duas modalidades explícitas: `patch-only` (o modelo só devolve um patch estruturado) e `controlled-run` (o controlador, e não o modelo, chama testes). Não implementar uma ferramenta genérica de shell no benchmark inicial.

### Gaps
- Nenhum benchmark público fornece uma estimativa válida para o desempenho de um modelo pequeno quantizado especificamente nesta GTX 1650 Super de 4 GB; isso terá de ser medido no corpus interno.
- O Windows instalado, espaço livre, versão do Node/Python, driver NVIDIA e capacidade de virtualização ainda não foram verificados. Eles condicionam a escolha posterior entre CPU, GPU parcial e um sandbox mais forte.

## Corpus interno de 20 tarefas e integridade da avaliação

### Takeaway
O corpus deve ser próprio, determinístico e deliberadamente menor que um benchmark acadêmico: 20 tarefas em quatro famílias, cada uma com commit-base, enunciado, testes públicos mínimos, oráculo oculto fora da cópia do agente e resultado serializado. Porém, há um limite importante: sem separação de privilégio ou VM, não existe “teste secreto inviolável” contra código hostil executado no mesmo usuário Windows; o MVP só pode alegar proteção contra a interface do agente, não sandbox de segurança.

### Cited Findings
- `git worktree` permite manter múltiplas árvores do mesmo repositório e documenta explicitamente o uso de uma árvore destacada (`--detach`) para alterações experimentais que não devem perturbar a árvore principal. — [documentação Git](https://git-scm.com/docs/git-worktree.html)
- `git diff --exit-code` termina com código 1 quando há diferenças e 0 quando não há, útil para verificar se caminhos proibidos foram modificados. — [documentação Git](https://git-scm.com/docs/git-diff/2.49.0.html)
- O runner de testes do Node pode ser chamado pela flag `--test`, e `unittest` do Python oferece execução por linha de comando. — [Node test runner](https://nodejs.org/download/release/latest-jod/docs/api/test.html); [Python unittest](https://docs.python.org/3/library/unittest.html)
- A orientação oficial do HumanEval de usar sandbox robusto para código gerado não confiável confirma que limitações de funções bloqueadas no processo não são isolamento de segurança. — [HumanEval README](https://github.com/openai/human-eval/blob/master/README.md)

### Inferences
- **Estrutura de cada fixture.** Criar um repositório Git local por família, um commit `base` com defeito intencional e um `task.json` com: `id`, `kind`, `prompt`, `base_commit`, `allowed_globs`, `public_test_command`, `timeout_s`, `max_changed_files` e `oracle_version`. O controlador cria uma worktree destacada para cada execução; o modelo recebe somente prompt, árvore permitida e saída de testes públicos.
- **Os 20 IDs iniciais (todos autorais, sem rede e sem dependências externas):**

  | Família | IDs e tarefa verificável |
  | --- | --- |
  | Função pura — 4 | `P01` limitar inteiro inclusive; `P02` converter duração `HH:MM` com rejeição estrita; `P03` ordenar registros estavelmente por dois campos; `P04` normalizar uma lista removendo duplicatas sem mutar a entrada. |
  | Correção localizada — 6 | `B01` corrigir limite inferior off-by-one; `B02` distinguir `0` de valor ausente; `B03` evitar divisão por zero e retornar erro documentado; `B04` preservar Unicode na validação; `B05` invalidar cache após atualização; `B06` impedir mutação acidental de configuração padrão. |
  | Integração pequena — 6 | `I01` precedência `CLI > arquivo > padrão`; `I02` serializar e restaurar `Date` ISO sem fuso implícito; `I03` parser CSV com aspas e vírgulas; `I04` propagar erro tipado através de dois módulos; `I05` fazer importação circular falhar com mensagem útil; `I06` comando CLI retornar código não-zero para configuração inválida. |
  | Segurança/política do controlador — 4 | `S01` recusar caminho fora da worktree; `S02` redigir padrão de segredo do log; `S03` negar comando fora de allowlist; `S04` recuperar execução interrompida sem aplicar patch parcial. |

- **Estratificação.** Executar primeiro `P01–P04` e `B01–B06`; somente se houver sinal útil, incluir `I01–I06`; manter `S01–S04` como testes do próprio controlador, nunca como tarefas dadas a um modelo com shell livre. Isso separa “o modelo escreveu uma função” de “o plano de controle aplicou uma política”.
- **Proteção pragmática.** A cópia do agente contém apenas `src/`, documentação, testes públicos e um adaptador de edição que recusa caminhos fora de `allowed_globs`. O diretório do oráculo fica fora da worktree, o processo de avaliação só recebe uma cópia do patch e executa os testes ocultos depois que a sessão termina. Comparar `git diff --name-only base` com a allowlist e marcar adulteração como falha antes de pontuar.
- **Limite que não devemos esconder.** Se o modelo puder invocar PowerShell/Node/Python arbitrariamente, ou se código candidato for executado como o mesmo usuário que guarda o oráculo, ele pode tentar ler/modificar outros arquivos; ACL no mesmo usuário não resolve isso. Portanto, nesta fase não chamar isso de sandbox nem executar tarefas fornecidas por terceiros. Para testar código potencialmente hostil será necessário um usuário Windows separado com ACLs e firewall, Windows Sandbox/VM ou contêiner — uma decisão técnica posterior, mesmo que sem custo recorrente.
- **Anti-vazamento e repetição.** Manter `manifest.lock.json` com hashes SHA-256 do enunciado, base commit, oráculo e versão do runner; nunca mostrar testes ocultos ou patch de referência à sessão; fixar seed/temperatura/contexto, versão do controlador, versão exata do modelo e parâmetros; guardar JSONL por execução. Toda mudança em fixture cria `suite_version` nova, não reescreve resultados antigos.

### Gaps
- A lista acima é uma especificação proposta, não uma suíte já implementada ou validada. Cada caso precisa de revisão humana: o patch de referência deve passar testes públicos e ocultos, e uma alteração nula deve falhar no oráculo.
- A proteção contra adulteração só será mensurável depois de definirmos a interface de ferramentas do agente. Se Codex/Claude receberem terminal direto, a política precisa deixar de prometer integridade forte.

## Protocolo de execução, métricas e portões de decisão

### Takeaway
O número útil não é “custo poupado de Claude/Codex”: esses custos/limites não são observáveis nem controláveis pelo benchmark local. Devemos medir resolução, integridade, tempo, estabilidade e esforço local; só declarar utilidade se o sistema resolver uma fração modesta mas repetível das tarefas fáceis sem violar a política.

### Cited Findings
- A documentação do Ollama informa suporte nativo ao Windows, aceleração NVIDIA/CPU e uma API local; também ressalta que modelos maiores podem ficar lentos sem GPU forte e que menos VRAM pode usar RAM do sistema, com possível perda de velocidade. — [Ollama para Windows](https://ollama.com/blog/windows-preview); [quickstart](https://github.com/ollama/ollama/blob/main/docs/quickstart.mdx)
- A OpenAI observou que resultados de scaffolds podem diferir do leaderboard mesmo com uma única seed e hiperparâmetros documentados; isso reforça registrar configuração completa e repetir execuções. — [nota metodológica do SWE-bench Verified](https://openai.com/index/introducing-swe-bench-verified/)

### Inferences
- **Ambiente reprodutível Windows, sem custo recorrente.** Fixar uma versão LTS de Node *ou* Python por suíte (não ambas na primeira rodada), Git e Ollama; registrar `systeminfo` resumido, `nvidia-smi`, versões, hash/model manifest, parâmetros de inferência, hash da suíte e `locale` em `run.json`. Fazer o primeiro corpus em TypeScript com `node --test` *ou* Python com `python -m unittest`; escolher um após verificar o que já está instalado. Não usar Docker, WSL, download durante a rodada ou paralelismo.
- **Protocolo.** Antes de cada rodada: restaurar `base_commit`, verificar hashes, limpar a worktree anterior, desabilitar rede na interface do controlador e iniciar um novo diretório de execução. Para cada tarefa: um único agente local, limite de 10 chamadas de ferramenta/8.000 tokens de saída/10 minutos, temperatura fixa, no máximo um patch final. O controlador valida a allowlist, roda testes públicos, copia o patch para o avaliador, roda o oráculo com timeout e grava `result.json`. Repetir cada tarefa três vezes com seeds 1/2/3 quando o backend permitir seed; se não permitir, repetir três execuções e registrar a limitação.
- **Métricas por execução.** `resolved_hidden` (oráculo passa), `public_pass`, `policy_clean`, `setup_ok`, `timeout`, `wall_seconds`, `tool_calls`, `changed_files`, `patch_lines`, `model_tokens_reported` e `runner_failure`. Reportar também taxa de resolução por família, mediana de tempo das resolvidas e intervalo min–máx das três repetições; não esconder timeouts como se fossem falhas funcionais comuns.
- **Portões propostos — são metas internas, não números publicados:**

  | Portão | Condição de aprovação |
  | --- | --- |
  | G0 — harness | 20/20 bases passam o oráculo; 20/20 patches nulos falham; 20/20 patches de referência passam; 0 arquivos fora da allowlist podem ser aceitos. |
  | G1 — execução | 20/20 tarefas iniciam e produzem log completo; ≤ 5% falhas do runner; 0 execução com rede ou shell genérico na interface do agente. |
  | G2 — utilidade local inicial | Em três rodadas, média de ≥ 50% em `P+B` (5 de 10 por rodada), ≥ 90% `policy_clean`, e mediana ≤ 10 min apenas nas resolvidas. |
  | G3 — integração | Depois de G2, média de ≥ 30% em `I` (2 de 6 por rodada), sem regressão abaixo de 50% em `P+B`. |
  | G4 — parar/reprojetar | Se a média em `P+B` for < 30% (menos de 3/10) em três rodadas, ou qualquer violação de política, não ampliar agentes/memória: revisar ferramenta, prompt, modelo e isolamento primeiro. |

- Os limiares G2/G3 são conservadores por deliberadamente medirem modelos pequenos em tarefas autorais e não equivalem a SWE-bench. O propósito é decidir se o executor local reduz trabalho manual em microtarefas; não é comparar-se a modelos de fronteira.
- **Contabilidade honesta.** Relatar: tempo de parede, energia apenas se houver medidor/telemetria confiável, tamanho do download inicial, uso de RAM/VRAM e tokens locais reportados. Não relatar “R$ economizados”, créditos de assinatura poupados, custo por token de Codex/Claude ou ganho de produtividade sem uma fonte observável e um grupo de comparação definido.

### Gaps
- Não há ainda modelo local, quantização ou backend escolhido; portanto não há previsão honesta de latência, taxa de resolução, VRAM ou energia.
- Os limites de 10 chamadas, 8.000 tokens e 10 minutos são controles iniciais propostos. Eles devem ser ajustados somente após uma rodada piloto de G0/G1, mantendo uma mudança por vez.
