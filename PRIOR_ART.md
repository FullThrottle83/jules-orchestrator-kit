# Prior Art & Inspirations

Denna dokumentation listar de projekt inom AI-agent-ekosystemet som inspirerat utvecklingen av `jules-orchestrator-kit`, samt vad detta kit gör annorlunda.

## Inspirationskällor

### jules-supervisor
- **Inspiration:** Konceptet kring "Human Escalation Bridge" via chattkanaler (som Telegram eller Slack). Hantering av tillstånd där agenter fastnar i `AWAITING_USER_FEEDBACK` och väntar på asynkron mänsklig input.
- **Vår skillnad:** Vi bygger in den asynkrona eskaleringen i den centrala `jules-queue-runner.mjs` så att det blir en inbyggd state-hantering, utan att kräva ett externt supervisor-verktyg som snurrar bredvid.

### google-labs-code/jules-skills
- **Inspiration:** Lokal CI Verification Container Runner (t.ex. via Nektos Act). Att förpacka exekveringen i isolerade miljöer innan PR skapas för att säkerställa att en agent inte introducerar miljö-specifika buggar.
- **Vår skillnad:** Vi fokuserar just nu på `npm test` i värdmiljön för att hålla dependencies på noll (enligt vår strikta Zero Dependencies-policy), men sneglar på hur de orkestrerar säkra sandlådor.

### jules-mcp-server
- **Inspiration:** Att exponera Jules funktionalitet via Model Context Protocol (MCP), särskilt över HTTP-strömmar (Streamable MCP Bridge) för verktyg som n8n och Hermes Agent.
- **Vår skillnad:** Vi planerar att bygga en **0-dependency stdio MCP server** (`src/mcp-server.mjs`) istället för en fullfjädrad HTTP/Express-server, för att möjliggöra direkt inbäddning inuti Claude Desktop, Cursor och Antigravity utan portkonflikter och onödig överbyggnad.

### antigravity-jules-orchestration
- **Inspiration:** Cloud Build Auto-Fix Webhooks. Ett mönster där webhook-endpoints tar emot misslyckade deployment-byggen från Vercel/Cloudflare och automatiskt skickar ut Jules på en "fix-session".
- **Vår skillnad:** Vårt kit exponerar OODA-loopen i CLI:t, vilket gör det möjligt att bygga samma logik lokalt eller via bash-skript, innan en HTTP-server ens behöver vara inblandad.

---

## Sammanfattning av differentiering

Det ärliga svaret på vad *detta* kit gör som de andra inte gör är **grinden**:
- **Verifiering & OODA-loop:** Automatiska reparationer med testkörningar (upp till 3 försök) innan den ger upp.
- **Scope-kontroll (Agent Scope Guard):** Hård kontroll över att Jules inte kan ändra kommandofiler (`package.json`, `.github/`) om inte explicit tillåtet.
- **Hemlighetsskanning:** Inbyggd redigering av AWS, GitHub och npm-nycklar (både med hög och låg konfidens) direkt i loggflödet, *innan* det sparas på disk.
- **Atomic Budgeting:** Ett lokalt ledger-system (`.agent/state/sessions/YYYY-MM-DD.jsonl`) som hanterar dagliga sessionsbudgetar och blockerar runaway loops (t.ex. att Jules bränner din token-budget av misstag).

Dessa mekanismer är kärnan i `jules-orchestrator-kit` och anledningen till att vi kan leverera stabilitet.
