# Integração Claude em uma orquestração local customizada

## Quais caminhos existem e qual deles oferece controle programático?

### Takeaway
Para um orquestrador próprio, o único caminho Claude desenhado para controle programático direto do loop agente é o **Claude Agent SDK** (TypeScript ou Python), que executa o binário Claude Code em processo controlado pela nossa aplicação. O Claude Code CLI pode ser encapsulado como subprocesso com JSON; Claude Cowork é uma superfície de produto operada pela pessoa, não uma API de orquestração. MCP é interface de ferramentas/contexto, não controle sobre o agente Claude.

### Cited Findings
- A documentação diferencia o Agent SDK como biblioteca para embutir o agente Claude Code em um processo operado pela própria aplicação; CLI é para uso interativo/one-off, Client SDK é chamada direta à API cujo loop de ferramentas cabe ao desenvolvedor, e Managed Agents é hospedado pela Anthropic. [Source](https://code.claude.com/docs/en/agent-sdk/overview)
- O Agent SDK expõe ferramentas integradas de leitura, escrita, edição, comandos e busca; além de hooks, subagentes, MCP e permissões. [Source](https://code.claude.com/docs/en/agent-sdk/overview)
- Uma sessão do Agent SDK aceita `cwd`, `model`, `allowedTools` e `maxTurns`; portanto o adaptador pode fixar diretório, limitar rodadas e pré-aprovar apenas ferramentas explicitamente permitidas. [Source](https://code.claude.com/docs/en/agent-sdk/configuration)
- O CLI suporta modo não interativo com `claude -p`, saída `json` ou `stream-json`, limite de turnos e lista de ferramentas permitidas/proibidas; a própria referência aponta esse modo para uso programático. [Source](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- Cowork é disponibilizado somente em planos pagos e é apresentado como interface visual para delegar tarefas, sem terminal; a documentação descreve a execução e o ciclo de tarefas como controlados pela sessão do produto. [Source](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)
- MCP é um padrão aberto para conectar agentes a ferramentas e dados externos; servidores podem ser processos locais, HTTP ou executados dentro da aplicação SDK. Essa definição não concede a um servidor MCP o controle do loop ou do modelo que Claude escolhe. [Source](https://code.claude.com/docs/en/agent-sdk/mcp)

### Inferences
- A arquitetura deve tratar `ClaudeAgentAdapter` como adaptador opcional de execução remota, com contrato próprio de entrada/saída/auditoria. Não deve tentar automatizar a interface Cowork nem depender de APIs privadas. Isso preserva a possibilidade de trocar Agent SDK por CLI sem alterar o núcleo. [Source](https://code.claude.com/docs/en/agent-sdk/overview)
- MCP deve entrar depois como uma fronteira de capacidades: o orquestrador pode expor ferramentas locais estritamente limitadas para Claude, mas não deve delegar para MCP a decisão de orçamento, fila, política ou aprovação. [Source](https://code.claude.com/docs/en/agent-sdk/mcp)

### Gaps
- Não há na documentação pública uma API suportada para criar, dirigir, observar ou encerrar sessões Cowork a partir de um orquestrador local. Portanto esse caminho não deve constar no MVP como integração automatizável; ele pode continuar sendo uma ferramenta humana separada. [Source](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)

## Quais limites de permissão, sistema de arquivos e controle um orquestrador local realmente tem?

### Takeaway
Com o Agent SDK, o host pode bloquear, aprovar ou transformar chamadas de ferramenta e restringir o diretório de trabalho; isso é controle útil, mas não é um sandbox de segurança suficiente por si só. A garantia de segurança do MVP precisa continuar no núcleo local: allowlist de diretórios, negação de rede por padrão, execução em cópia/worktree e aprovação humana para escrita ou processos perigosos.

### Cited Findings
- Por padrão, o quickstart informa que o SDK pode acessar os arquivos do diretório em que é iniciado e de seus subdiretórios. [Source](https://code.claude.com/docs/en/agent-sdk/quickstart)
- As permissões são avaliadas em ordem: hooks, regras de negação, regras que exigem pergunta e, por último, modo de permissão; regras de negação ainda bloqueiam chamadas mesmo em `bypassPermissions`. [Source](https://code.claude.com/docs/en/agent-sdk/permissions)
- Em modo `plan`, operações de escrita em arquivos e shell são enviadas ao callback de aprovação; em `dontAsk`, ações que exigem interação são negadas em vez de abrir prompt. [Source](https://code.claude.com/docs/en/agent-sdk/permissions)
- Hooks podem bloquear operações perigosas, registrar chamadas, transformar entradas/saídas, exigir aprovação humana e acompanhar o ciclo da sessão. [Source](https://code.claude.com/docs/en/agent-sdk/hooks)
- O SDK pode desabilitar a carga de configurações de usuário/projeto/local ao passar `settingSources: []`; assim o host evita herdar automaticamente permissões, comandos e instruções de arquivos locais. [Source](https://code.claude.com/docs/en/agent-sdk/configuration)
- Claude Code em Windows é suportado por WSL ou Git Bash, e exige conexão com a internet para autenticação e processamento de IA. [Source](https://docs.anthropic.com/en/docs/claude-code/getting-started)
- Uma sessão Cowork em nuvem processa inclusive os arquivos locais acessados por meio do Desktop nos servidores Anthropic; o acesso ao dispositivo ocorre apenas pelos diretórios conectados e enquanto o aplicativo está on-line. [Source](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview)

### Inferences
- Para o computador atual e gasto zero, o adaptador Claude deve nascer **desligado** e com perfil somente leitura: `cwd` aponta para uma cópia/worktree descartável, `settingSources: []`, ferramentas limitadas a `Read`, `Glob` e `Grep`, e sem MCP remoto. [Source](https://code.claude.com/docs/en/agent-sdk/configuration)
- Permissões do SDK reduzem risco de chamada de ferramenta, mas não eliminam a necessidade de isolamento do sistema operacional; o orquestrador não deve considerar `allowedTools`/hooks como autorização para operar o repositório real sem confirmação humana. [Source](https://code.claude.com/docs/en/agent-sdk/permissions)
- Um MCP local deve receber somente um token de capacidade efêmero e operações declaradas (por exemplo, `read_task_manifest`); nunca deve receber credenciais ou um shell amplo. Os servidores MCP podem executar como processos locais, portanto a política de processo continua sob nossa responsabilidade. [Source](https://code.claude.com/docs/en/agent-sdk/mcp)

### Gaps
- Não encontrei na documentação pública uma garantia de sandbox do sistema operacional para o Agent SDK equivalente a uma VM local controlada pelo nosso orquestrador. Antes de qualquer modo com escrita, seria necessário validar empiricamente o comportamento do binário e complementar com isolamento do lado local. [Source](https://code.claude.com/docs/en/agent-sdk/overview)

## Há uma prova significativa possível sem gasto de API ou assinatura?

### Takeaway
É possível provar sem custo recorrente o **contrato do adaptador**, o roteamento, a auditoria, a política de permissões e um servidor MCP local com um executor falso. Não é possível provar uma chamada real a Claude Code/Agent SDK sem credencial e acesso pago ou créditos promocionais, porque o SDK pede chave de API e Claude Code requer cobrança ativa no Console ou plano Pro/Max.

### Cited Findings
- O quickstart do Agent SDK requer conta Anthropic e instruções para configurar `ANTHROPIC_API_KEY`; o SDK lê a chave do ambiente e não carrega `.env` automaticamente. [Source](https://code.claude.com/docs/en/agent-sdk/quickstart)
- A instalação do Claude Code lista como autenticação padrão o Console com cobrança ativa, ou uma assinatura Claude Pro/Max; também cita plataformas corporativas AWS/GCP como alternativas. [Source](https://docs.anthropic.com/en/docs/claude-code/getting-started)
- A página de preço afirma que novos usuários recebem uma pequena quantidade de créditos gratuitos para testar a API, mas não define um valor, duração ou garantia para planejamento do MVP. [Source](https://docs.anthropic.com/en/docs/about-claude/pricing)
- O SDK informa uso de tokens e estimativa de custo, mas a própria documentação alerta que `total_cost_usd`/`costUSD` são estimativas locais e que dados autoritativos vêm da Usage and Cost API ou Console. [Source](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
- Cowork também é destinado apenas a planos pagos. [Source](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)

### Inferences
- O MVP de custo recorrente zero não pode ter Claude como dependência funcional. A prova inicial deve usar `FakeClaudeAdapter` que reproduza eventos JSON (resultado, pedido de aprovação, erro, consumo estimado) e permita testes determinísticos sem credenciais. O encaixe do adaptador real fica demonstrado por teste de protocolo, não por inferência de qualidade do modelo. [Source](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- Se o proprietário já tiver uma assinatura Pro/Max ou receber créditos promocionais, qualquer ensaio real deve ser manual, com um teto de uma tarefa somente leitura, `maxTurns` pequeno, registro do gasto reportado e autorização explícita. Créditos promocionais não devem entrar na previsão financeira. [Source](https://code.claude.com/docs/en/agent-sdk/configuration)

### Gaps
- Não há fonte oficial que prometa franquia permanente gratuita para a API ou Claude Code. Logo, não é honesto desenhar a integração Claude como uma capacidade gratuita contínua. [Source](https://docs.anthropic.com/en/docs/about-claude/pricing)

## Qual é o adaptador Claude mínimo seguro e ele deve ser adiado?

### Takeaway
Sim: o adaptador Claude deve ser **adiado como implementação real**, mas seu contrato deve entrar já no desenho do núcleo. O mínimo seguro posterior é um único executor Agent SDK em TypeScript, opt-in, somente leitura, diretório descartável, sem configurações herdadas, sem MCP remoto, limite de turnos e aprovação do orquestrador para toda capacidade fora da allowlist.

### Cited Findings
- O Agent SDK suporta Python e TypeScript, e a documentação recomenda encapsular CLI como subprocesso JSON apenas para linguagens fora desses dois ecossistemas. [Source](https://code.claude.com/docs/en/agent-sdk/overview)
- O SDK traz binário Claude Code na maior parte das instalações TypeScript/Python; casos sem binário incluído precisam do Claude Code instalado e localizado pelo PATH ou configurado explicitamente. [Source](https://code.claude.com/docs/en/agent-sdk/quickstart)
- O Agent SDK permite definir ferramentas pré-aprovadas, limite de turnos e diretório de trabalho por sessão. [Source](https://code.claude.com/docs/en/agent-sdk/configuration)
- As ferramentas MCP podem ser permitidas por nome/wildcard, e o SDK aceita servidor MCP local `stdio`, HTTP/SSE ou servidor em processo. [Source](https://code.claude.com/docs/en/agent-sdk/mcp)

### Inferences
- Implementação futura proposta, em ordem: (1) criar a interface neutra `AgentAdapter.execute(TaskEnvelope) -> EventStream`; (2) completar e testar `FakeClaudeAdapter`; (3) implementar `ClaudeAgentSdkAdapter` em TypeScript; (4) introduzir uma única tarefa real de leitura após existir credencial autorizada e orçamento; (5) só então avaliar escrita em worktree e MCP local. A ordem evita transformar a disponibilidade de uma conta paga em bloqueio do núcleo. [Source](https://code.claude.com/docs/en/agent-sdk/overview)
- Não usar Cowork como backend nem automação de UI. Ele permanece uma estação de trabalho humana opcional, pois a integração suportada para aplicação própria é o Agent SDK/CLI/API, enquanto Cowork requer plano pago e opera suas próprias sessões. [Source](https://code.claude.com/docs/en/agent-sdk/overview)
- Não iniciar com a Client SDK/REST Messages API: ela dá mais liberdade, mas transfere para nós o loop agente e a execução de ferramentas, duplicando justamente o que o Agent SDK já oferece. [Source](https://code.claude.com/docs/en/agent-sdk/overview)

### Gaps
- A escolha futura entre Agent SDK TypeScript e CLI subprocesso depende da linguagem do núcleo que ainda não foi decidida. Se o núcleo for TypeScript, Agent SDK reduz tradução e oferece hooks/permissões; se for outra linguagem, o CLI JSON é a integração suportada a comparar em um experimento controlado. [Source](https://code.claude.com/docs/en/agent-sdk/overview)
