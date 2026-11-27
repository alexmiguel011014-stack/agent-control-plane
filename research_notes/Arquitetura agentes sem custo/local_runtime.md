# Runtime local, limites e avaliação

## Qual é a pilha local mínima realmente viável neste computador?

### Takeaway
O MVP deve ser **um orquestrador próprio, de um processo por vez, com Ollama nativo no Windows e um modelo pequeno**, e não uma frota de agentes. Ollama reduz a fricção inicial no Windows e já expõe tool calling; `llama.cpp` deve ficar como alternativa de segunda fase se for necessário controlar diretamente o binário, a quantização GGUF ou o particionamento CPU/GPU.

### Cited Findings
- Ollama é uma aplicação nativa de Windows, suporta GPU NVIDIA e expõe sua API local em `http://localhost:11434`; exige Windows 10 22H2+ e driver NVIDIA 551.61+. — [Ollama Windows](https://docs.ollama.com/windows)
- Ollama suporta tool/function calling, com a aplicação cliente fornecendo a definição do instrumento e devolvendo o resultado ao modelo; portanto a ferramenta pode ser uma camada própria de `read_file`, `apply_patch` e `run_test`, sem depender de MCP no MVP. — [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling)
- A própria documentação do Ollama mostra `ollama ps` para distinguir modelo 100% GPU, 100% CPU ou carregamento dividido CPU/GPU. — [Ollama FAQ](https://docs.ollama.com/faq)
- Os artefatos publicados pelo Ollama para `qwen2.5-coder` são aproximadamente 986 MB (1,5B), 1,9 GB (3B) e 4,7 GB (7B). — [Catálogo Qwen2.5-Coder](https://ollama.com/library/qwen2.5-coder)
- `llama.cpp` disponibiliza um servidor local para modelos quantizados em GPU e CPU, com rotas compatíveis com OpenAI e Anthropic; documenta tool calling por `--jinja`. — [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- O servidor `llama.cpp` também alerta que servidores MCP em `stdio` são subprocessos com os mesmos privilégios do servidor; isto confirma que MCP não é uma fronteira de segurança. — [llama.cpp MCP server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)

### Inferences
- Com 4 GB de VRAM, o artefato de 7B (4,7 GB) já excede a VRAM antes de considerar cache de contexto, buffers e o Windows; ele **não é candidato a execução integral na GPU**. Pode iniciar de forma parcial CPU/GPU ou CPU-only, mas desempenho e estabilidade têm de ser medidos, nunca presumidos.
- Qwen2.5-Coder 1,5B é o ponto de partida mais seguro para testar o encanamento e 3B é o teto prático inicial para uma única execução, com contexto deliberadamente curto (por exemplo, 4k tokens). Esses tamanhos cabem nominalmente no armazenamento/RAM e deixam margem de VRAM; a qualidade para corrigir repositórios reais ainda é uma hipótese a ser falsificada pelo benchmark.
- O modelo pequeno não deve receber shell irrestrito. O loop proposto é: modelo pede uma ação estruturada -> orquestrador valida -> executor limitado devolve resultado -> modelo decide o próximo passo. O orquestrador é o produto; o modelo é apenas um componente intercambiável.
- Recomenda-se começar por Ollama por velocidade de instalação e instrumentação. Só migrar/duplicar para `llama.cpp` se o ensaio mostrar necessidade de parâmetros de inferência que Ollama não ofereça, ou se for preciso carregar GGUF específico; manter ambos no primeiro MVP duplicaria superfície de falha.
- “R$0” só é verdadeiro como **nenhuma nova cobrança, API paga ou assinatura**. A máquina consome eletricidade e tempo de engenharia; esses custos devem ser registrados separadamente, não apagados de uma alegação de economia.
- Inspirações, não dependências: a divisão evento/estado, loop raciocínio-ação, ferramentas, contexto e validação de segurança aparece explicitamente no OpenHands; use o desenho como referência, sem importar o SDK ou seu runtime no MVP. — [Arquitetura do agente OpenHands](https://github.com/OpenHands/docs/blob/main/sdk/arch/agent.mdx)

### Gaps
- Não há medição nesta pesquisa de tokens/s, VRAM, RAM nem taxa de correção no Ryzen 5 5600/GTX 1650 Super. A primeira execução controlada deve registrar esses quatro dados para 1,5B e 3B.
- Ainda não foi confirmado o driver NVIDIA, versão do Windows, espaço livre em disco e se há outra carga concorrendo por RAM/VRAM. Estes são pré-requisitos de aceitação, não detalhes cosméticos.

## Que isolamento e controles de segurança cabem no Windows sem pagar?

### Takeaway
Um `git worktree` descartável, allowlist de comandos, timeout e limite de processo são controles úteis de **redução de risco**, mas não isolam um processo malicioso que executa sob o usuário atual. O MVP deve começar seguro por design (sem rede, sem segredos, sem comandos arbitrários), e deixar isolamento forte por AppContainer/Windows Sandbox como um marco explícito, não como uma promessa implícita.

### Cited Findings
- `git worktree` permite múltiplas árvores de trabalho associadas ao mesmo repositório, inclusive em branches distintos. — [Git worktree](https://git-scm.com/docs/git-worktree.html)
- Job Objects do Windows permitem gerenciar uma árvore de processos como unidade, aplicar limites de memória/prioridade/tempo e encerrar todos os processos associados. — [Microsoft: Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- AppContainer oferece isolamento de credenciais, dispositivos, arquivos, rede, processos e janelas; acesso além do mínimo é concedido por capacidade. — [Microsoft: AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)
- As APIs modernas `CreateProcessInSandbox` documentam AppContainer com nível de integridade baixo, diretórios de leitura/escrita explícitos e capacidades de rede; `internetClient` é a capacidade de saída para a Internet. — [Microsoft: Create Process in Sandbox](https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox)
- Windows Sandbox elimina software, arquivos e estado ao fechar, mas não suporta Windows Home; exige Pro, Enterprise ou Education. — [Microsoft: Windows Sandbox](https://learn.microsoft.com/en-in/windows/security/application-security/application-isolation/windows-sandbox/)
- Docker Desktop em Windows usa WSL 2/Hyper-V/Docker VMM; seus requisitos incluem WSL 2.1.5+, virtualização habilitada e pelo menos 8 GB de RAM. — [Docker Desktop para Windows](https://docs.docker.com/desktop/setup/install/windows-install/)

### Inferences
- Implementação do executor inicial (sem Docker): criar worktree em uma pasta própria de execuções; copiar somente o contrato da tarefa; expor ferramentas fixas `read_text` (raiz permitida), `list_files` (sem `.git`, `.env`, `node_modules`), `apply_unified_diff` (somente paths permitidos), `run_test` (scripts declarados) e `git_diff`; negar `powershell`, `cmd`, `curl`, instaladores, rede, exclusões e qualquer comando não mapeado.
- O processo de teste deve ser filho de um Job Object com `KILL_ON_JOB_CLOSE`, limite de tempo e de memória. Isso contém travamentos e processos-filhos ordinários, mas não substitui uma fronteira de privilégios.
- “Sem rede por padrão” não pode ser alegado só porque a ferramenta não oferece `curl`: dependências ou binários iniciados podem usar a rede. Antes de tarefas não confiáveis, ou se houver segredos no computador, a arquitetura precisa de AppContainer sem `internetClient` ou Windows Sandbox/VM; até então, aceitar somente repositórios descartáveis, sem `.env`, chaves SSH, tokens ou dados pessoais.
- Docker é viável como etapa posterior de reprodutibilidade, porém não é necessário ao primeiro MVP e dividir 24 GB de RAM entre Windows, modelo local e WSL/Docker aumentará risco de paginação. Não adotar como requisito de inferência nem como primeira camada de isolamento.
- Windows Sandbox pode ser um laboratório manual se a edição permitir, mas não serve como executor automatizado inicial: é uma única instância e exige preparar ferramentas/modelos dentro dela. A decisão depende de edição do Windows e virtualização, ainda não verificadas.

### Gaps
- Não se sabe se o Windows do computador é Home, Pro, Enterprise ou Education; isso decide se Windows Sandbox está disponível.
- AppContainer/`CreateProcessInSandbox` é uma rota tecnicamente forte, mas sua integração com runtime Python/Node e ferramentas de build precisa de um spike separado. Não deve bloquear o benchmark do MVP, mas deve bloquear execução em repositórios ou dados sensíveis.

## Como provar ou refutar utilidade e economia sem chamadas pagas?

### Takeaway
O benchmark deve tentar derrubar a hipótese: um modelo local só é “útil” se resolver, dentro de limite definido, uma proporção combinada de tarefas reais sem violar política nem alterar o avaliador. Não se pode declarar economia sobre Codex/Claude sem uma linha de base autorizada; inicialmente a alegação verificável é somente “execução sem chamada paga por tarefa”.

### Cited Findings
- SWE-bench disponibiliza datasets de problemas reais de engenharia de software e usa contêineres Docker para ambientes de avaliação consistentes; sua própria documentação permite validar o harness executando patches de referência. — [SWE-bench quick start](https://github.com/SWE-bench/SWE-bench/blob/main/docs/guides/quickstart.md)
- O catálogo SWE-bench inclui uma variante Lite menor, apropriada para avaliação mais rápida. — [SWE-bench harness](https://github.com/SWE-bench/SWE-bench/blob/main/docs/reference/harness.md)
- O repositório `simple-evals` da OpenAI mantém a implementação de referência de HumanEval e declara o conjunto como referência para correção funcional de código, embora o repositório esteja descontinuado para novos resultados. — [OpenAI simple-evals](https://github.com/openai/simple-evals)
- LangGraph se apresenta como uma referência de agentes resilientes; é uma inspiração possível para persistência explícita de estado, não uma justificativa para introduzi-lo como dependência. — [LangGraph](https://github.com/langchain-ai/langgraph)

### Inferences
- Construir primeiro um conjunto interno de 20 tarefas fechadas, versionadas e pequenas, extraídas de dois ou três repositórios descartáveis: 8 correções unitárias, 6 mudanças de função envolvendo mais de um arquivo, 4 falhas de build/lint e 2 tarefas de investigação que devem terminar em “não há evidência suficiente”. Cada tarefa define `base_commit`, paths editáveis, comando de avaliação, timeout e patch humano de referência, mantido fora do contexto do modelo.
- O avaliador roda fora do processo do agente, em cópia limpa do `base_commit`; recusa alteração de testes/lockfiles/configuração do avaliador salvo quando a própria tarefa permitir; calcula hash dos testes antes/depois; roda testes de regressão e os testes ocultos. A saída é `PASS`, `FAIL`, `POLICY_VIOLATION`, `TIMEOUT` ou `CRASH`, nunca apenas “parece correto”.
- Medir por execução: modelo/tag e hash, prompt, seed/temperatura, contexto máximo, quantização, CPU/RAM/VRAM de pico, tempo até primeiro token, duração, número de ferramentas, comandos negados, diff, resultado do avaliador e causa de parada. Rodar cada tarefa pelo menos três vezes se a configuração for estocástica.
- Critério de parada inicial sugerido: interromper a trilha “agente executor local” se, depois de 20 tarefas e duas configurações de modelo, não houver ao menos uma taxa de PASS acima do baseline “nenhuma mudança” e nenhuma tarefa multiarquivo completa em até 20 minutos sem violação. Isso não prova inutilidade geral, mas falsifica o valor para o escopo atual.
- Usar HumanEval apenas como teste rápido de geração de função e SWE-bench Lite apenas depois de o executor estar estável. Ambos são insumos públicos, não substitutos das tarefas internas; SWE-bench requer Docker para sua avaliação oficial, logo não é o primeiro benchmark sob a restrição atual.
- Para comparação futura com Codex/Claude, usar exatamente as mesmas tarefas, avaliador externo e orçamento de tempo; somente então relatar “custo por PASS”. Se não houver uso autorizado e mensurável de um provedor remoto, a coluna remota fica como `N/A`, não estimada.

### Gaps
- Não existe baseline remoto, preço, cota ou autorização para testar Codex/Claude nesta fase; qualquer número de “economia” contra eles seria especulação.
- O conjunto interno ainda não foi criado nem validado por patch humano. Também não há prova de que o ambiente atual consiga reproduzir builds das linguagens-alvo sem baixar dependências; isso deve ser descoberto antes de congelar o benchmark.
