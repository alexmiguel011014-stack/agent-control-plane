# Política de benchmark remoto opcional — Codex e Claude

Pesquisa em 23 de outubro de 2026. Esta nota usa somente documentação oficial da OpenAI e da Anthropic para afirmações sobre provedores. Planos, modelos, limites, telas de uso e ofertas podem mudar; a política deve ser revalidada antes de cada marco de benchmark.

## Observabilidade e controles de custo: o que existe e o que não existe

### Takeaway

Há observabilidade humana suficiente para um experimento voluntário, mas não há um limite monetário programável e universal para assinaturas pessoais. O Control Plane não deve alegar conhecer nem controlar o saldo real de uma assinatura; ele só pode impor seus próprios limites de processo e exigir conferência humana no produto oficial.

### Cited Findings

- No Codex autenticado com ChatGPT, o uso conta para a franquia do plano; a franquia é compartilhada entre Work e Codex, depende de modelo, tarefa e configuração, e a tela **Settings > Usage** mostra saldo e reinícios. A OpenAI afirma que os intervalos de mensagens são estimativas, não garantias; uso de API é cobrado separadamente. — [OpenAI: Managing usage with GPT-6 Astra in Work and Codex](https://help.openai.com/en/articles/20001516-managing-usage-with-gpt-6-astra-in-work-and-codex)
- A OpenAI separa explicitamente a autenticação de Codex com ChatGPT (uso e faturamento do plano) do uso por chave de API (preço de API). — [OpenAI: ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex)
- Créditos do ChatGPT podem continuar um pedido depois da franquia e o recarregamento automático pode comprar créditos com a forma de pagamento padrão. Portanto, uma assinatura já existente não equivale, sozinha, a teto de R$0 por experimento. — [OpenAI: Using Credits for Flexible Usage in ChatGPT](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-personal-plans)
- A OpenAI permite limites semanais por aplicativo apenas para aplicativos comerciais participantes que suportem o compartilhamento de plano; o limite é percentual da franquia total, não uma reserva, e créditos só são usados se a pessoa os autorizar. Não há evidência nesta fonte de que um Control Plane local customizado seja um participante elegível. — [OpenAI: Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)
- Claude possui limites de sessão (cinco horas) e semanais compartilhados entre claude.ai, Claude Desktop e Claude Code; consumo varia com conversa, modelo, recursos e esforço, e a tela **Settings > Usage** mostra a próxima reposição. — [Anthropic: How do usage and length limits work?](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work)
- Em Claude, **Usage credits** são um adicional pay-as-you-go separado da assinatura: exigem habilitação, meio de pagamento e pré-pagamento; podem ser desabilitados. — [Anthropic: Manage usage credits for paid Claude plans](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)
- Para Claude Code com assinatura, a Anthropic suporta login com plano Pro ou Max. Ela também alerta que a presença de `ANTHROPIC_API_KEY` faz Claude Code usar API e gerar cobrança, em vez da franquia da assinatura. — [Anthropic: Use Claude Code with your Pro or Max plan](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)

### Inferences

- O painel pode guardar apenas observações declaradas pelo operador — por exemplo, “franquia suficiente observada” e horário de reset — e nunca um suposto preço por tarefa de assinatura. Isso é rastreabilidade operacional, não medição de custo financeiro.
- Há duas camadas honestas: o produto oficial mantém a franquia e possíveis opções de cobrança; o Control Plane limita o seu processo (turnos, tempo, concorrência, escopo de arquivos) e falha fechado quando o operador não confirma o preflight.
- Não usar API, créditos, recarga automática, reset pago ou reset promocional no benchmark inicial preserva a regra de não criar gasto. Isso também evita confundir “economia” com consumo de franquia já paga.

### Gaps

- As fontes oficiais não publicam uma API pessoal estável para ler programaticamente a franquia restante, preço efetivo por tarefa ou reset de Codex/Claude. Logo, não se deve implementar polling, scraping ou prometer bloqueio automático por saldo.
- Não foi confirmado que o Control Plane local seja um aplicativo elegível para compartilhar a franquia ChatGPT. Até haver confirmação oficial e integração aprovada, ele não pode consumir essa franquia como app customizado.

## O benchmark deve incluir Codex ou Claude?

### Takeaway

Não no benchmark-base. O baseline deve ser local, reprodutível e sem rede; Codex e Claude entram, no máximo, numa trilha comparativa opcional e manual, com resultados rotulados como “uso de franquia existente”, não como inferência gratuita nem como economia garantida.

### Cited Findings

- Codex faz parte de planos ChatGPT elegíveis e seus limites variam por plano, tamanho/complexidade da tarefa e superfície de execução; a própria OpenAI diz que tarefas longas e repositórios maiores podem gastar mais por mensagem. — [OpenAI: Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan%2525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252522525252528.pdf)
- Claude Code pode usar Pro/Max por uma assinatura unificada, mas requer internet para autenticação e processamento de IA. — [Anthropic: Set up Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started)
- A Anthropic afirma que o uso incluso em assinaturas destina-se ao uso comum dos aplicativos Anthropic nativos, incluindo Claude Code, e recomenda chave de API/Console ou provedor de nuvem para software/ferramentas de terceiros. — [Anthropic: Log in to your Claude account](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account)
- A própria documentação da Anthropic descreve gateways com rastreio e orçamento como configuração que recebe autenticação por token/chave e acesso a modelos de provedor; isso não oferece um caminho de R$0 sem credenciais e faturamento. — [Anthropic: LLM gateway configuration](https://docs.anthropic.com/en/docs/claude-code/llm-gateway)

### Inferences

- A unidade científica deve ser uma tarefa imutável: mesmo enunciado, mesmo commit inicial, mesma suíte de testes externa e mesma máquina. A trilha local deve executar primeiro e ser a única que sustenta a alegação “funciona com custo marginal de API R$0”.
- A trilha remota não é um adaptador automático do Control Plane. Ela exporta um **pacote de tarefa** (instruções, hash do commit, limite de escopo e comandos de validação); o engenheiro inicia manualmente a tarefa no cliente oficial Codex ou Claude Code e importa somente patch, log e resultado para avaliação.
- Para Claude, não se deve automatizar OAuth, extrair tokens, usar proxy/gateway, injetar variáveis de API ou transformar a assinatura pessoal em backend do produto. Isso respeita a orientação oficial para ferramentas de terceiros e evita cobrança indevida.
- Uma comparação remota serve para responder “o local é suficientemente útil nesta classe de tarefa?”; ela não mede preço por token nem prova que a assinatura existente tem custo zero.

### Gaps

- O benchmark não pode fornecer equivalência perfeita entre modelos: fornecedores podem mudar modelos, limites e ferramentas sem aviso. Resultados devem registrar data, cliente/versão, modelo efetivamente selecionado quando visível e estado do repositório, mas não afirmar paridade semântica.
- Sem uma decisão explícita do dono da conta, não é possível afirmar que a franquia existente pode ser usada para o experimento. A ausência de custo novo não autoriza consumo silencioso de uma franquia limitada.

## Quais limites não monetários são executáveis pelo Control Plane?

### Takeaway

O Control Plane consegue controlar o trabalho ao redor do provedor: uma execução por vez, prazo, turnos registrados, worktree descartável, allowlist de comandos e validação independente. Ele não consegue converter esses limites em garantia de consumo de franquia do fornecedor.

### Cited Findings

- A OpenAI informa que tarefas, modelos e configurações alteram quanto da franquia de Codex é usado; os números de mensagens não são garantidos. — [OpenAI: Managing usage with GPT-6 Astra in Work and Codex](https://help.openai.com/en/articles/20001516-managing-usage-with-gpt-6-astra-in-work-and-codex)
- A Anthropic informa que comprimento, complexidade, modelo, ferramentas e esforço afetam os limites de uso, e que pode aplicar limites adicionais de capacidade. — [Anthropic: What is the Pro plan?](https://support.claude.com/en/articles/8325606-what-is-the-pro-plan)
- Quando Claude Code usa API key, é pay-as-you-go; quando usa credenciais de plano/assento, chegar ao limite resulta em mensagem de reset. — [Anthropic: Models, usage, and limits in Claude Code](https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code)

### Inferences

- Limites obrigatórios no MVP: `concurrency=1`, uma tarefa por worktree, tempo de parede máximo (por exemplo, 20 minutos), máximo de 3 prompts/turnos humanos registrados, um patch final, repositório e caminhos em allowlist, comandos de teste predeterminados e sem rede pelo Control Plane.
- Limites obrigatórios de consentimento: aprovação explícita por `run_id`, provedor e tarefa; nenhuma repetição automática após limite/erro; nenhum push, deploy, compra de crédito, reset ou mudança de plano; nenhum segredo no pacote enviado.
- O wrapper deve abortar antes do envio se detectar configuração de API no processo de Claude Code (em especial `ANTHROPIC_API_KEY`) ou se o operador declarar créditos habilitados. Para Codex, o preflight deve exigir “sem API key” e “uso de créditos/recarga automática desabilitado”; a execução é então feita somente via login do cliente oficial.
- O contador de prompts do Control Plane controla quantas vezes ele produz um pacote/solicita retorno do operador, e não quantas chamadas internas o cliente remoto faz. O relatório deve nomear isto corretamente para não prometer uma limitação que não existe.

### Gaps

- Não há confirmação oficial, nas fontes consultadas, de um parâmetro de CLI de assinatura que imponha por tarefa um máximo de tokens, de franquia ou de dinheiro para Codex e Claude Code. Portanto, esses limites devem ser processuais e humanos, não tratados como um circuito financeiro.

## Política, evidência de aceitação e condições de adiamento

### Takeaway

O uso remoto só pode iniciar após preflight manual assinado no repositório local; qualquer rota para API, créditos ou automação da conta adia a trilha remota. A trilha local continua válida e completa mesmo que ambos provedores sejam adiados.

### Cited Findings

- Créditos do ChatGPT podem ser usados após o limite do plano e recarga automática pode comprar créditos; a configuração e saldo ficam em Usage/Usage & Billing. — [OpenAI: Using Credits for Flexible Usage in ChatGPT](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-personal-plans)
- A OpenAI informa que resets bancados/promocionais são discricionários, podem expirar, e alguns fluxos podem permitir ao assistente usá-los mediante confirmação; logo, eles não são uma base reprodutível de benchmark. — [OpenAI: How resets work in Codex](https://help.openai.com/en/articles/20001498-how-resets-work-in-codex)
- Usage credits de Claude são separadas da assinatura, cobradas à parte e podem ser desligadas em Settings > Usage. — [Anthropic: Manage usage credits for paid Claude plans](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)
- A Anthropic diz que `ANTHROPIC_API_KEY` seleciona API e gera cobrança no Claude Code, em vez do uso incluído da assinatura. — [Anthropic: Use Claude Code with your Pro or Max plan](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)

### Inferences

- Criar antes de qualquer adaptador `docs/remote-provider-policy.md` com a regra **LOCAL_FIRST / REMOTE_MANUAL / NO_PAID_FALLBACK**. Criar também `benchmarks/evidence/<run_id>/` para a evidência abaixo. Esses arquivos contêm metadados e hashes, nunca tokens, chaves, e-mails, capturas de tela ou conteúdo sensível.
- Preflight mínimo por execução: (1) `run_id`, commit e hash do pacote; (2) autorização humana datada dizendo “Codex” ou “Claude Code”, para esta tarefa; (3) observação manual de franquia e reset na UI do fornecedor; (4) confirmação de créditos/auto-reload desligados; (5) confirmação de ausência de API key no processo; (6) `concurrency=1`, limite de tempo e de turnos; (7) confirmação de que o pacote não contém segredos. O Control Plane deve recusar a trilha remota se algum campo estiver ausente.
- Evidência pós-execução: `result.json` com timestamps locais, exit codes, número de pacotes/turnos, hash do patch, hash do log, testes independentes aprovados/reprovados e motivo de parada; `operator-attestation.md` com “nenhuma compra, crédito, reset ou chave de API foi usado” e observação final da franquia/reset. A atestação mede conformidade; não é prova criptográfica de faturamento.
- Critério de aceitação comparativo: publicar cada tarefa com linhas separadas `local-only` e `remote-existing-allowance`; comparar taxa de testes, tempo de parede, tamanho do diff e intervenções humanas. Não somar franquia remota como custo R$0 e não deixar uma falha remota invalidar o baseline local.
- **Adiar Codex** se a única forma proposta for API key, créditos, reset ou app customizado não reconhecido como participante; se houver saldo/recarga de créditos ativos que o operador não consiga desligar; ou se não houver autorização por tarefa.
- **Adiar Claude** se estiver ativa `ANTHROPIC_API_KEY`, Console/API, gateway/proxy ou Usage credits; se o projeto tentar dirigir o Claude Code por automação de sessão/token; ou se o operador não puder usar manualmente o cliente oficial com plano existente.
- **Adiar ambos** se o repositório de teste não for descartável, se não houver testes externos imutáveis, se houver segredos/dados reais, se houver concorrência, ou se o usuário quiser executar em segundo plano sem confirmação. Nesses casos, continuar apenas no local-first.

### Gaps

- Esta política não substitui os termos de uso dos provedores nem prova que uma configuração específica de conta está correta. Antes de uma primeira execução, o dono da conta deve conferir as telas atuais e termos aplicáveis; se qualquer opção ou rótulo tiver mudado, registrar a divergência e adiar em vez de adivinhar.
