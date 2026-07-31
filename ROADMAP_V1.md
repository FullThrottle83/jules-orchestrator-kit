# Road to 1.0 (Stabilisering & Integration)

Denna roadmap är avsedd att visualisera vägen till v1.0. 
**Zero Dependencies** är en *produktegenskap* för detta projekt, inte en vana. Eventuella externa databaser (utöver framtida inbyggda moduler) och komplexa ramverk undviks för kärnkomponenterna. 

För en jämförelse med relaterade projekt i ekosystemet (som inspirerat oss), se [PRIOR_ART.md](./PRIOR_ART.md).

## Kriterier för v1.0 Release

Innan vi stämplar v1.0 ska systemet bevisa sin stabilitet, snarare än att bara lägga till funktioner. 
När 1.0 är släppt lovar vi att strukturen för `.agent/jules.yml` och exit codes (0–7) är **låsta och stabila** under hela major-versionen.

- [x] **En Linter i CI:** ESLint configurerad med `no-undef` och `no-unused-vars` och integrerad i GitHub Actions (jules-audit.yml).
- [ ] **Integrationstester:** Ett end-to-end testfall som faktiskt kör `runSelfAudit` mot ett temporärt git-repo för att testa OODA-buggar och exit-vägar i praktiken.
- [ ] **Skarpa Körningar (Proof of Concept):** Dokumenterade bevis på att hela orkestreringskedjan har kört framgångsrikt mot riktiga Jules-instanser.
- [ ] **Dokumenterade Mönster (71 mönster):** Tydlig dokumentation av de interna processerna och specifikt felsöknings-guider för varje exit code (så en användare som möter exit 3 ska veta precis varför).
- [ ] **Stabilitetslöfte formulerat:** `.agent/jules.yml` schemat och exitkoderna formaliseras i dokumentationen.

## Enda Featuren före v1.0: MCP Server Integration
Detta är den enskilt mest värdefulla uppdateringen för distribution.
- [ ] Bygg en **zero-dependency stdio MCP-server wrapper** (`src/mcp-server.mjs`).
- [ ] Exponera `jules-orchestrator-kit` som ett standard MCP-verktyg (`dispatch_jules_task`).
- [ ] Detta gör orkestratorn användbar rakt inifrån verktyg som Claude, Cursor och Antigravity utan överbyggnad.

---

# Post-1.0 Funktionalitet

Funktioner som rör storskalighet och komplexa visualiseringar ligger här, med kravet att de måste kunna byggas antingen genom *inbyggda moduler* (t.ex. `node:http`) eller exkluderas från kitets core.

- **Databas-drivet Kösystem (SQLite):** Avvaktar tills `node:sqlite` blir en stabil default i nyare Node.js LTS, eller så införs Node 22.5+ som krav för just databasdelen. Tills dess räcker flatfils-kön väl för dagsbudgeten på 300 sessioner.
- **Dashboard GUI (Localhost Web UI):** För att visualisera Jules tasks. Om detta byggs förblir det strikt beroendefritt (serverrenderad HTML från `node:http`) för att inte bryta vår Zero Dependency-regel.
- **Node.js SDK & Webhooks:** Fullständigt programmatiskt API via `index.mjs` så externa system kan lyssna på dispatch-events i realtid.
- **Human Escalation Bridge & Slack/Discord-bryggor:** Tillåter asynkron eskalering från `AWAITING_USER_FEEDBACK`. Detta kräver att Jules API först exponerar feedback-tillståndet publikt.
- **Local CI Verification Container Runner:** Integrera script för att isolera bygget (t.ex. Nektos Act) före verifiering.
