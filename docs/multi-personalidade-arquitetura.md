# Arquitetura inicial — multi-personalidade no MCP WhatsApp

Visão geral
- Partimos de um repositório operacional `whatsapp-hermes` em `D:\Programas\Whatsapp` com Baileys + MCP stdio.
- Objetivo: permitir múltiplas personalidades/agentes por contato, grupo ou fluxo,
  usando **uma única conta Baileys**, sem quebrar o funcionamento atual.
- Problema atual observado: loops com `code=440` em `connection.update`,
  indicando desconexões frequentes do Baileys. A causa mais provável é
  reconciliação de estado/credenciais, não aplicações paralelas concorrentes.

---

## 1. Pontos de extensão no repositório atual

### 1.1 Entrypoint e ciclo de vida — `src/index.js`
- Caminho natural para injetar o Personality Router antes de levantar o MCP.
- Hoje: `start()` → `startMcpServer(wa)`.
- Depois: `createPersonalityEngine(wa)` → `startMcpServer(wa, engine)`.

### 1.2 Cliente WhatsApp — `src/whatsapp.js`
- Estado **monolítico** atual:
  - 1 socket Baileys
  - 1 buffer de entrada (`this.buffer`)
  - 1 mapa de chats (`this.chats`)
  - 1 allow-list (`this.allowed`)
- Ideal para extensão:
  - separar "camada WhatsApp" de "camada personalidade";
  - manter o buffer como **canal único de eventos**, mas rotear para
    personalidades downstream;
  - evitar tocar em `makeWASocket` para não corromper a sessão em `wa_auth/`.

### 1.3 MCP server — `src/mcp.js`
- Tools hoje são singletons (`whatsapp_send`, `whatsapp_get_messages`).
- Devem permanecer como API estável; a multi-personalidade será invisível
  para chamadas tradicionais por padrão, usando a personalidade ativa/implícita.
- Ideal para adicionar tools auxiliares de gestão sem breaking changes:
  - `whatsapp_personalities_list`
  - `whatsapp_personality_get`
  - `whatsapp_personality_upsert`
  - `whatsapp_session_reset`

### 1.4 Logger — `src/logger.js`
- Já está corretamente isolado para stderr.
- Pode ser estendido com `child({ personalityId })` sem quebrar o protocolo MCP.

## 2. Modelo de dados para perfis de personalidade

Arquivo sugerido: `config/personalities.json`

```
personalities:
  - id: atendimento
    nome: "Atendimento"
    descricao: "Perfil para atendimento ao cliente"
    systemPrompt: |
      Você é o atendente da marca X. Seja educado, objetivo...
    allowedContacts: ["5511...", "5512..."]
    allowedGroups: ["120363...@g.us"]
    routing:
      mode: contact  # contact | group | regex | keyword | chatId
      match:
        contact: ["5511900000001"]
        group: ["120363...@g.us"]
        contains: ["preço", "orçamento"]
    stateDir: wa_personality_state/atendimento
    mcpToolsEnabled:
      - whatsapp_send
      - whatsapp_get_messages
      - whatsapp_list_chats
    metadata:
      owner: ricardo
      created_at: "2026-07-..."
```

Campos mínimos:
- `id`, `nome`, `systemPrompt`
- `routing.mode` e regras de matching
- `allowedContacts`/`allowedGroups` opcionais
- `stateDir` para memória separada

## 3. Separação de sessões e estado

- **Estado WhatsApp global**: único, imutável para as personalidades.
  - Socket, credenciais `wa_auth/`, buffer de eventos.
- **Estado por personalidade**: isolado por diretório.
  - Caminho: `wa_personality_state/<personalityId>/`
  - Conteúdo sugerido:
    - `memory.json` — contexto curto (últimas N interações)
    - `seen_message_ids.json` — evita reprocessamento quando necessário
    - `flags.json` flags transitórias (ex.: esperando confirmação)
- **Roteamento síncrono**:
  - toda mensagem ingerida em `whatsapp.js` passa por um único listener;
  - esse listener delega ao Personality Engine, que aplica regras e
    persiste no stateDir correspondente.
- **Compatibilidade**:
  - se nenhuma personalidade corresponder, usar a personalidade `default`
  - ou expor a mensagem no buffer global como hoje.

## 4. Riscos e limitações do Baileys para múltiplas personalidades

- **1 conta = 1 dispositivo Baileys**: `makeWASocket` representa uma única
  sessão Web. Abrir múltiplos sockets com as mesmas credenciais em `wa_auth/`
  causa conflito de identidade e pode disparar logout/código 440.
- **Conclusão**: não use múltiplas instâncias Baileys na mesma conta.
  A multi-personalidade deve ser construída **acima** do socket.
- **Rate limiting e banimento**: perfis automatizados aumentam volume.
  Limites por número e grupo devem ser respeitados.
- **Reconexão frequente**: loops code=440 costumam estar ligados a
  credenciais corrompidas, versionamento instável ou rede intermitente.
  A solução não é criar mais conexões.
- **Estado compartilhado inevitável**:
  - lista de chats (`this.chats`)
  - buffer de mensagens
  Isso implica que personalidades veem a mesma realidade bruta; a aplicação
  de filtros por personalidade deve ocorrer no roteamento, não no Baileys.

## 5. Mudanças mínimas recomendadas

### Fase 1 — sem breaking changes
- Criar `config/personalities.json` vazio/com perfil default.
- Criar `src/personalities.js`:
  - carrega perfis
  - expõe `matchPersonality(chatId, from, text)`
- Adicionar tool `whatsapp_personalities_list` em `src/mcp.js`.

### Fase 2 — roteamento
- Criar `src/router.js`:
  - recebe evento do `messages.upsert`
  - aplica `matchPersonality`
  - anexa um campo de routing na entrada do buffer ou cria buffers virtuais
- Modificar `src/mcp.js`: `whatsapp_get_messages` e `whatsapp_list_chats`
  aceitam `personalityId` opcional.
  - Sem parâmetro: comportamento atual preservado.
  - Com parâmetro: filtra por personalidade + chat.

### Fase 3 — memória por personalidade
- Criar `src/personality_state.js`:
  - lê/grava memória curta no diretório da personalidade
  - oferece snapshot para alimentar `systemPrompt` dinâmico ou contexto do agente.
- Criar tool `whatsapp_session_reset` para limpar memória de uma personalidade.

### Fase 4 — estabilidade / anti-loop 440
- Auditar `fetchLatestBaileysVersion` e `creds.update`.
- Fixar versionamento do Baileys quando possível, em vez de usar versão mais
  recente a cada boot; flutuações de protocolo aumentam incompatibilidades e
  códigos de desconexão.
- Persistir estado com `useMultiFileAuthState` sem limpar `wa_auth/` entre
  restarts; garantir que `saveCreds` seja sempre chamado.

---

## 6. Arquitetura alvo

```
src/
├── index.js              # boot global: WaClient -> Router -> MCP
├── whatsapp.js           # Baileys socket + buffer global + eventos
├── mcp.js                # tools MCP (estáveis + novas)
├── router.js             # roteia mensagens para personalidade ativa
├── personalities.js      # perfis: carregamento e matching
├── personality_state.js  # memória por personalidade
└── logger.js             # já adequado

config/
└── personalities.json    # perfis editáveis

wa_personality_state/
├── atendimento/
│   └── memory.json
└── pesquisa-preco/
    └── memory.json
```

 Sequência de leitura recomendada da base atual
- `src/whatsapp.js` para entender onde a ingestão acontece e como o buffer e os chats são atualizados.
- `src/mcp.js` para ver onde encaixar as novas tools sem quebrar as existentes.
- `src/index.js` para planejar a ordem de inicialização.

## 7. Decisões arquiteturais recomendadas

- **Uma conta Baileys, N personalidades Lógicas**.
- **Buffer global + routing downstream**.
- **Tools existentes inalteradas como padrão**.
- **Personalities como JSON/YAML versionáveis**.
- **Estado separado por `personalityId`** para memória curta.
- **Proibir múltiplas conexões Baileys simultâneas** na mesma conta.
