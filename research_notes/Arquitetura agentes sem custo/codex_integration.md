# Integração Codex oficial sem custo recorrente

## Quais são as interfaces oficiais e seus limites de controle?

### Takeaway
A arquitetura pode integrar o Codex local oficialmente sem API key por meio do Codex CLI e do SDK TypeScript oficial que o encapsula. Para um MVP local, o SDK/CLI é mais simples que o app-server: o controlador externo cria e retoma threads, recebe eventos estruturados e decide se inicia uma nova execução; o modelo continua decidindo quais ferramentas usar dentro de cada turno.

### Cited Findings
- O Codex CLI, o app-server e o Codex SDK são componentes open source; a camada aberta é o *harness*/superfície de integração, enquanto o acesso a modelos e serviços gerenciados permanece separado. — [OpenAI: Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform)
- O SDK oficial TypeScript encapsula o CLI, inicia-o como processo filho e troca eventos JSONL por stdin/stdout; requer Node.js 18+. — [README do SDK oficial](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- O SDK permite manter contexto ao chamar `run()` repetidamente na mesma `Thread`, transmitir eventos intermediários com `runStreamed()` e solicitar saída compatível com JSON Schema por turno. — [README do SDK oficial](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- Threads do SDK são persistidas em `~/.codex/sessions` e podem ser reconstruídas com `resumeThread()`. — [README do SDK oficial](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- O SDK permite limitar o ambiente herdado pelo CLI por `env`, e passar configurações do CLI; isso é útil para um controlador que não quer entregar ao agente todas as variáveis do processo. — [README do SDK oficial](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- O `codex exec` aceita fluxo JSONL e o CLI oferece execução não interativa; o próprio SDK atualmente o invoca com `exec --experimental-json`. — [código do SDK oficial](https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts)
- O app-server é a alternativa de menor nível: comunica-se por JSONL, cria/retoma threads, inicia turnos, emite eventos e requer que o cliente avalie `turn.status` ao final. — [documentação oficial do app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- O Codex pode consumir servidores MCP configurados no cliente local; a documentação oficial mostra `codex mcp add ... --url ...` e a entrada equivalente em `~/.codex/config.toml`. — [OpenAI Docs MCP](https://developers.openai.com/learn/docs-mcp)
- Plugins podem empacotar skills, MCP e hooks; MCP local por stdio é suportado para execução desktop, mas a publicação pública de plugins com MCP local requer parceiro aprovado. Isso não impede um protótipo privado local, apenas exclui a hipótese de publicação pública gratuita imediata. — [plugins desktop-only](https://developers.openai.com/plugins/deploy/desktop-only)

### Inferences
- **Camada recomendada para a primeira versão:** um controlador próprio em Node/TypeScript, usando `@openai/codex-sdk` somente como adaptador do executor Codex. O controlador deve possuir `Run`, `Task`, `PolicyDecision`, `Artifact` e um diário de eventos próprio (JSONL append-only ou SQLite), em vez de tratar os arquivos de sessão do Codex como banco de dados do produto.
- **MCP deve ser ferramenta, não orquestrador.** Um MCP local pode expor somente operações determinísticas do controlador, por exemplo `task_status`, `read_artifact`, `propose_plan` e `request_transition`. Ele entrega contexto/ações ao Codex, mas não é uma barreira suficiente para impor orçamento, aprovação ou recuperação: o processo controlador precisa validar cada transição antes de criar o próximo turno.
- **App-server fica para a segunda fase.** Ele é o caminho certo se for necessário uma UI própria com conversa persistente, streaming fino e tratamento de pedidos de aprovação. A primeira prova não deve depender do fluxo OAuth próprio descrito para apps, nem de detalhes de protocolo que evoluem mais rapidamente que o SDK.
- **Limite de ferramenta:** o controlador pode compelir sua própria agenda (não iniciar mais de um executor, não iniciar turno de escrita sem aprovação, cancelar/expirar um processo, recusar uma transição), mas não há, nas interfaces SDK/CLI pesquisadas, uma chamada pública que obrigue o modelo dentro de um turno a delegar uma subtarefa específica. Ele pode instruir, habilitar ou desabilitar capacidades; garantia operacional exige o controlador criar processos/threads separados para tarefas separadas.

### Gaps
- A documentação pesquisada não apresenta contrato de estabilidade/versionamento para todos os eventos internos do CLI/SDK. O MVP deve registrar a versão do `codex` e ter testes de contrato contra poucos tipos de evento que realmente consome.
- Não foi localizada documentação oficial que torne o Codex CLI um servidor MCP para outro agente; a própria retrospectiva oficial informa que o servidor MCP do Codex foi removido em setembro de 2026. Não projetar o sistema supondo que Claude ou outro orquestrador chamará o Codex como ferramenta MCP. — [retrospectiva OpenAI 2025](https://developers.openai.com/blog/openai-for-developers-2025)

## Delegação, permissões, estado e recuperação

### Takeaway
O controlador consegue impor limites fora do turno e construir auditoria/recovery confiáveis; aprovação granular de cada comando/edição é uma capacidade a validar com app-server, não uma promessa do primeiro MVP. O modo multiagente gerenciado da Responses/Agents API não satisfaz gasto recorrente zero.

### Cited Findings
- A documentação recomenda `codex exec` para jobs limitados, SDK para fluxos programáticos e app-server para conversas persistentes, eventos transmitidos e tratamento de aprovações. — [OpenAI: Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform)
- O app-server documenta a criação e retomada de thread, início de turno e a necessidade de renovar token e reiniciar/reassumir a thread após troca do token. — [documentação oficial do app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- A API Responses oferece multiagente como beta; ativa-se com `multi_agent.enabled`, e a raiz fica **elegível** a criar subagentes, que compartilham modelo e ferramentas. — [guia oficial Multi-agent](https://developers.openai.com/api/docs/guides/responses-multi-agent)
- A mesma API descreve que subagentes aumentam consumo de tokens e recomenda começar com três concorrentes; o recurso usa o SDK beta/endpoint Responses. — [guia oficial Multi-agent](https://developers.openai.com/api/docs/guides/responses-multi-agent)
- A Agents API executa harness gerenciado, persistência/recovery e delegação, mas cobra uso do modelo pelas tarifas de API e cobra as ferramentas/sandboxes aplicáveis. — [visão geral oficial Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview)
- MCP remoto é uma superfície de risco: o modelo pode decidir chamar ferramentas e a documentação recomenda `allowed_tools` e aprovação para ações sensíveis. — [guia oficial de MCP](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)

### Inferences
- **Máquina de estados mínima e executável:** `DRAFT -> CLASSIFIED -> WAITING_APPROVAL | QUEUED -> RUNNING -> VERIFYING -> SUCCEEDED | FAILED | CANCELLED`. Somente o controlador grava transições; cada uma recebe `run_id`, `parent_task_id`, versão de política, hash do prompt/contexto, executor/modelo escolhido, timestamps, resultado e hashes de artefatos.
- **Gate de segurança viável no MVP:** todo turno começa `read-only`. Uma alteração em workspace só pode ser solicitada por uma tarefa cujo estado seja `WAITING_APPROVAL`; depois da aprovação humana gravada, o controlador cria um turno separado com permissão de escrita e escopo de diretório explícito. É uma aprovação por turno/tarefa, não por comando.
- **Gate granular posterior:** antes de alegar aprovação de cada comando ou cada edição, construir um teste de protocolo com app-server no Windows que provoque uma solicitação de aprovação e confirme as ações de aprovar, negar, timeout e reinício. Se falhar, manter o gate por turno; não tentar emular permissões interceptando stdout do agente.
- **Recuperação:** ao iniciar, o controlador relê o diário e marca `RUNNING` sem evento terminal como `INTERRUPTED`. Ele pode retomar uma thread conhecida via SDK; se não houver confirmação de que a escrita terminou, a tarefa volta a `WAITING_APPROVAL`/`VERIFYING`, nunca diretamente a `SUCCEEDED`.
- **Delegação real sem API:** o roteador decompõe somente tarefas independentes e lança, no máximo, uma thread/processo Codex por tarefa. Com o PC atual e orçamento zero, fixar concorrência remota em `1`; a palavra “multiagente” descreve o grafo de tarefas, não simultaneidade obrigatória. Cada tarefa de escrita recebe worktree próprio ou é serializada.
- **Fora de escopo inicial:** Agents API/Responses API multiagente, sandbox hospedado e qualquer SDK `openai` que faça chamadas à API. Eles são tecnicamente capazes, mas contradizem a restrição de não acrescentar cobrança de API.

### Gaps
- A documentação pública pesquisada não permite concluir que app-server tem uma semântica estável e suficiente para responder a toda aprovação granular em todas as versões Windows. Esta é a principal hipótese a provar antes de adotá-lo como barreira de segurança.
- MCP não elimina prompt injection nem dá autoridade ao controlador sobre o raciocínio/roteamento do modelo. Sua política deve aceitar somente dados estruturados e ignorar instruções recebidas de ferramentas/documentos que tentem alterar a máquina de estados.

## Custo, observabilidade e experimento mínimo

### Takeaway
“Sem custo recorrente” é viável apenas no sentido de não criar consumo de API nem infraestrutura paga: o Codex autenticado em ChatGPT continua consumindo a franquia/créditos do plano já existente. O orçamento inicial deve ser por número de turnos, concorrência e tempo, não por reais ou tokens exatos.

### Cited Findings
- O CLI pode autenticar com uma conta ChatGPT; a documentação recomenda esse caminho para uso dentro do plano ChatGPT, enquanto uso por API key exige configuração adicional. — [README oficial do Codex](https://github.com/openai/codex/blob/main/README.md)
- O uso do Codex via plano ChatGPT conta para limites normais e créditos/faturamento aplicáveis; o usuário pode ver limite/créditos/reset no dashboard e usar `/status` numa sessão CLI. — [Central de ajuda: uso do plano](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- O uso depende de modelo, complexidade, contexto, raciocínio, velocidade e ferramentas; uma tarefa longa pode consumir muito mais que uma curta. — [Central de ajuda: uso do plano](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- A visão de consumo por chat pode ser estimativa incompleta: pode omitir subagentes, tarefas separadas, algumas ferramentas e atividade em segundo plano. — [Central de ajuda: Usage & billing](https://help.openai.com/en/articles/20001478-reviewing-work-and-codex-usage-and-using-personal-analytics-in-chatgpt-desktop)
- Endpoints de Usage/Costs documentados pertencem à organização da API e retornam dados de custo/uso de API; eles não são documentados como medidor da franquia pessoal de um plano ChatGPT. — [referência oficial Organization Costs](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs)

### Inferences
- **Política de custo para v0:** `max_remote_turns_per_run=2`, `max_concurrent_remote=1`, timeout externo por turno, tamanho máximo de contexto anexado e teto de tentativas de recuperação. Ao atingir um teto, o estado é `WAITING_BUDGET` e só o humano cria uma nova execução. Isso controla exposição, embora não prometa equivalência exata em créditos.
- **Telemetria honesta:** guardar eventos do SDK, duração, contagem de turnos, modelo informado, tamanho de entrada de responsabilidade do controlador e resultado; mostrar “créditos/tokens reais: indisponíveis para controle programático pessoal”. Antes de uma execução grande, a checagem humana é `/status`/Usage & billing, não scraping de UI nem API privada.
- **Experimento E0 (sem API paga, 30–60 min, repositório descartável):**
  1. Criar um repositório Git vazio de teste e um diretório de logs fora do código.
  2. Usar o CLI já autenticado com ChatGPT (sem `OPENAI_API_KEY`) e executar uma tarefa estritamente de leitura com `codex exec --json`; capturar JSONL bruto, versão do CLI, tempo e código de saída.
  3. Exigir saída JSON Schema com `status`, `evidence` e `next_state`; o controlador aceita apenas JSON válido e grava o evento terminal.
  4. Interromper deliberadamente uma segunda execução, reiniciar o controlador e confirmar que ela vira `INTERRUPTED`; então testar `resumeThread()`/equivalente apenas para uma tarefa de leitura.
  5. Propor uma alteração simples, parar em `WAITING_APPROVAL` e provar que nenhum turno com escrita é iniciado antes da aprovação registrada. Após aprovação, executar um único turno de escrita com escopo de workspace e rodar uma verificação local determinística.
- **Critérios de aprovação E0:** nenhum uso de API key; nenhum acesso de escrita antes do gate; diário reproduz a sequência completa; reinício não marca trabalho incompleto como concluído; e o usuário consegue explicar, a partir do log, qual turno consumiu a franquia. Se qualquer critério falhar, parar e corrigir o controlador antes de MCP, interface gráfica ou execução paralela.

### Gaps
- Não há fonte oficial encontrada para uma API pública de leitura da franquia de um usuário individual de ChatGPT que um controlador local possa consultar e usar como corte duro. Não prometer um limite automático em reais/créditos para esse tipo de login.
- O experimento depende de uma conta ChatGPT com Codex disponível e de que a franquia existente tenha saldo; isso precisa ser confirmado localmente pelo usuário, sem inserir nem expor credenciais no projeto.
