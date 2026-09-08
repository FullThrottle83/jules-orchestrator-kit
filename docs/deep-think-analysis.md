# Deep Think-Analys: Domänbredd, Stack-Universalitet, Discovery & Provider-Agnostik

**Datum:** 2026-09-08 · **Baslinje:** v0.72.2 (`c131705`) · **Omfattning:** 8 filer / 4 kluster som definierar kitets väg från "webb- och Jules-centrerat orkestreringsverktyg" till "universell agentkärna för vilken stack och vilken agent som helst".

> **Läsanvisning:** Varje kluster innehåller (1) en nulägesbeskrivning förankrad i faktisk kod med fil:rad-referenser, (2) funna defekter och läckor — flera är verifierade buggar, inte åsikter — och (3) ett konkret designförslag. Dokumentet avslutas med en prioriterad roadmap. Allt är avsett att kunna omvandlas direkt till GitHub-issues.

---

## Sammanfattning — de tio viktigaste fynden

| # | Fynd | Kluster | Allvarlighet |
|---|------|---------|--------------|
| 1 | `wizard-oracle.mjs:95`: `stack.includes("go")` matchar `"django"` → Django-repon får `go vet ./...` som typecheck-orakel | 2 | Bugg (P0) |
| 2 | `task-optimizer.mjs:405`: hårdkodad Node-guardrail `"Do NOT modify package.json, lockfiles…"` — exakt den defekt `buildGuardrailFooter` dokumenterades som fixad (`wizard-task.mjs:21–36`), men bara fixad på ett av två ställen | 2 | Bugg (P0) |
| 3 | `containerCmd`/`containerized` beräknas i `stack-detector.mjs:322–332` men konsumeras aldrig utanför sitt eget test — Docker-baserade testsviter är en död förmåga | 2 | Död kod (P1) |
| 4 | `detectPolyglotStack` returnerar **ett** stack-svar via precedence-waterfall → blandade backend/frontend-repon kör bara den ena halvans orakel | 2 | Arkitektur (P1) |
| 5 | `jules-scan-todos.mjs` läser **alla** filer (även binära, `target/`, `vendor/`, `.venv/`) som UTF-8 utan storleksgräns, matchar bara `TODO:`/`FIXME:` som substring, och `agentctl scan` skriver ut 10 rader och avslutar — ingen JSON, inga envelope-utkast | 3 | Grund för Discovery Engine (P1) |
| 6 | Kitet har redan en outnyttjad guldkluft för Cluster 3: kunskapen i templates (`agent-doc-drift`, `agent-dep-audit`, `agent-config-audit`) beskriver exakt de prober en Discovery Engine behöver — men den finns bara som *reparations*-prompter, inte som *detekterings*-logik | 3 | Möjlighet |
| 7 | `Alchemist.md` **är** redan en DBA/Schema-specialist — premissen i briefen är delvis fel; det verkliga rollgapet är DevOps/Infra, SRE/Observability och Data | 1 | Korrigering |
| 8 | Användare kan redan definiera egna **roller** utan att patcha källkod (`resolveRolePrompt` läser `.agent/prompts/*.md`) — men **templates** är hårdkodade i `web-templates.mjs`; mekanismen att kopiera finns redan i repot | 1 | Möjlighet |
| 9 | Provideradaptern är Jules-formad: `approvePlan` är en no-op för exec-providers (plangodkännande gate passerar tyst), session-pollning/retry/eskalering fungerar i praktiken bara för http-typ; anpassade providerobjekt i config stöds mekaniskt (`createProvider` accepterar objekt) men är odokumenterat (README dokumenterar bara fyra strängnycklar) | 4 | Arkitektur (P1) |
| 10 | Säkerhetskärnan (gate, tamper-scanning, lock manager) är redan provideroberoende — den inspekterar git-tillstånd, inte agenten. Det som behöver abstraheras är sessionslivscykeln och ansvarsfördelningen för PR/branch | 4 | Bekräftad styrka |

---

## Kluster 1: Domänbredd & Uppgiftssyntes

### 1.1 Nuläge: vad katalogen faktiskt innehåller

`src/web-templates.mjs` (964 rader, 21 templates) delar sig i tre familjer med mycket olika karaktär:

| Familj | Antal | Medlemmar | Karaktär |
|--------|-------|-----------|----------|
| `web-*` | 7 | `web-cwv`, `web-wcag`, `web-seo`, `web-playwright`, `web-flaky-heal`, `web-i18n`, `web-ai-access` | Äkta frontend-specialiseringar. Orakel är verktygskedjor (`lhci`, `axe-cli`, `playwright`) |
| `agent-*` | 10 | `agent-dead-code-audit`, `agent-qa-mutation`, `agent-ci-falsify`, `agent-service-isolate`, `agent-error-paths`, `agent-security-audit`, `agent-dep-audit`, `agent-doc-drift`, `agent-config-audit`, `agent-api-contract` | Meta-audits av agentens *eget arbete* + universaliserade underhållsaudits. Kommentarblocket vid rad 691–707 visar att en universaliseringspass redan gjorts: ingen stack nämns i prompten, `defaultVerifyCmd: "npm test"` är medvetet en placeholder som `planTaskCreate` (`wizard-task.mjs:144`) ersätter med `config.verify.test` |
| `deep-*` | 4 | `deep-debug`, `deep-feature`, `deep-optimize`, `deep-harden` | Generella ingenjörsprotokoll (racing-conditions, TDD, benchmark-gates, adversarial hardening) men skrivna med JS-idiom i kritikfokus ("unhandled promise rejections", `safeAtomicWrite`) |

**Observationer:**

1. **Namnet ljuger om innehållet.** Filen, funktionerna (`getWebTemplate`, `listWebTemplates`, `synthesizeWebEnvelope`) och MCP-toolnamnet (`get_web_task_template`, `src/mcp.mjs:532`) säger "web" men 14 av 21 templates är inte web. Det är inte kosmetiskt: det styr hur nya bidragsgivare kategoriserar kitet och vilka templates som skrivs nästa.

2. **Universaliseringsmönstret finns redan och är dokumenterat i koden.** Kommentaren vid `web-templates.mjs:691–707` ("names no specific package manager, framework or language in its prompt; defaults `defaultVerifyCmd` to the placeholder ONLY because `synthesizeWebEnvelope` lets the caller override it from `config.verify.test`") är exakt det kontrakt varje ny template ska hålla. Problemet är att det kontraktet bara lever i en kommentar — det finns ingen lint som enforcingar det (se förslag 1.4).

3. **De facto-gapen inom domänbredd** — det som faktiskt saknas mot briefens lista:

   - **Databasmigrationer** — finns som *roll* (Alchemist) men inte som *template*. Ingen `agent-migration-audit`.
   - **API-brytningar** — `agent-api-contract` täcker route/handler-paritet och validering, men inte brytande ändringar mot *befintliga konsumenter* (exportinventering, semver, deprecationspolicy).
   - **Containerisering** — ingen template alls. Inga Dockerfile-lint, ingen build-reproducibilitet, ingen healthcheck-orakel.
   - **DevOps/CI/IaC** — ingen template. `agent-ci-falsify` handlar om att verifiera att CI-oraklet kan bli rött, inte om att granska CI-konfigurationens egen kvalitet.
   - **Observability/SRE** — logg-schema, felkoder, metriktäckning: helt frånvarande.

### 1.2 Generalisering utan att tappa falsifierbarheten — orakeltaxonomi

Kitets kärnvärde är att varje uppgift har ett orakel som *kan bli rött*. Risken vid domänexpansion är att nya templates degraderar till "best practice"-checklistor utan lokalt exekverbart mål (exakt det `agent-dep-audit`'s kritikfokus rad 5 uttryckligen förbjuder: *"Do not fetch a CVE database… known-vulnerability triage is a separate human decision"*).

**Förslag: formalisera en orakeltaxonomi som varje template måste deklarera** — utöka templateobjektet med ett strukturerat oracle-fält istället för enbart `defaultVerifyCmd: string`:

```js
{
  id: "agent-migration-audit",
  oracle: {
    baseline: "{{VERIFY_TEST}}",              // måste vara grönt före
    redGreenInversion: "migrate down && migrate up",  // kördes baklänges utan dataförlust?
    measurableGates: [                        // hårda, lokalt kontrollerbara mål
      "migrate up körs två gånger → andra körningen är no-op (idempotens)",
      "schema-snapshotdiff före/efter == förväntad diff",
    ],
  },
  ...
}
```

Med den taxonomin blir de nya domänerna naturligt falsifierbara:

| Föreslagen template | Lokalt orakel (kräver ingen nätverkstjänst) | Falsifierbarhets-mekanism |
|---|---|---|
| `agent-migration-audit` | `migrate up && migrate down && migrate up` + snapshotdiff | Invertera: peta bort en `down()`-implementation → oraklet blir rött |
| `agent-api-breaking` | Export/routeinventering före↔efter diffad mot konsumentfixtures (mönstret från `agent-doc-drift`'s "paste the diff of the inventory") | Ta bort en export som en fixture konsumerar → rött |
| `agent-containerize` | `docker build && docker run <healthcheck>` + image-storleksbudget | Ändra healthcheck-URL till en som inte svarar → rött |
| `agent-ci-audit` | `actionlint`/YAML-lint + "tag-not-SHA"-probe (kitet varnar redan om detta i `ci-templates.mjs` HEADER — gör det till ett orakel) | Pina en action till en tag som pekar på fel commit → rött |
| `agent-log-contract` | Alla loggutskrifter parsar mot deklarerat JSON-schema (`verify.stages`-hook) | Skriv en ostrukturerad rad → rött |

**Nyckelprincipen att behålla:** varje ny template ska gå att *motbevisa* på utvecklarens maskin utan externa tjänster. Det är det som skiljer kitets templates från ett vanligt promptbibliotek.

### 1.3 Användardefinierade templates: `.agent/templates/*.yml`

**Nuläge:** templates kan bara komma från `WEB_TEMPLATES` i kitets källkod. Användaren kan inte lägga till en återanvändbar template utan att fork:a. *Men* — repot har redan båda nödvändiga byggstenarna:

1. **Roller laddas redan från användarens repo:** `resolveRolePrompt` (`src/role-resolver.mjs:44`) läser godtycklig `.md` från `.agent/prompts/` och hydrerar `{{VERIFY_TEST}}`-tokens från config (`ROLE_PROMPT_TOKENS`). En användare kan idag lägga `.agent/prompts/Dba.md` och köra `agentctl task create --role Dba` — utan att patcha.
2. **YAML-parser och interpolation finns:** `parseYaml` i `config.mjs`, `interpolateString`/`interpolateDeep` i `provider.mjs:155–186`.

**Förslag — minimal, kompatibel design:**

```
.agent/templates/
  migration-guard.yml
```

```yaml
id: migration-guard            # obligatoriskt, slug-validerat som taskId (wizard-task.mjs:195)
name: "Migration Guard"
description: "Reversible, idempotent DB migrations"
category: "Data"
oracle:
  baseline: "{{VERIFY_TEST}}"  # hydreras via samma mekanism som ROLE_PROMPT_TOKENS
  gates:
    - "migrate up; migrate up  # andra körningen = no-op"
criticFocus:
  - "En down()-implementation får inte vara en no-op om den inte är märkt irreversible."
params:
  migrationDir:
    default: "db/migrations"
prompt: |
  Granska och åtgärda migrationer i {{migrationDir}}…
```

**Resolutionsregler (viktiga designbeslut):**

- **Ingen shadowing av inbyggda id:n** — en användar-template med id `web-seo` avvisas med tydligt fel, eller namnrymdas `local/web-seo`. Shadowing skapar tyst divergens mellan vad README lovar och vad som körs.
- **Samma valideringsgrav som inbyggda:** `planTaskCreate`'s falsifierbarhetskontroll (`wizard-task.mjs:152–157`) gäller redan oavsett promptkälla — det är gratis säkerhet. Dessutom: `criticFocus` måste vara icke-tom, `prompt` måste innehålla minst ett `{{param}}`-substitut som löses.
- **`verifyCmd` från template får aldrig åsidosätta `config.verify.test`** — bevara den existerande precedence från `wizard-task.mjs:144`.
- **Ingen eval, inga skript i templates.** Templates är data. Orakelkommandon går igenom samma trivial-orakel-vägran (`TRIVIAL_ORACLES`) som allt annat.
- **CLI-integration:** `agentctl task template --list` visar inbyggda + lokala (märkta `[local]`), `task create --template migration-guard` fungerar identiskt. MCP-tool:et `get_web_task_template` byter till `get_task_template` med bakåtkompatibelt alias.
- **Distribution:** templates checkas in i repot = versionshanterade, granskade i PR, och `init` kan scaffolda en exempeltemplate. Detta är samma trust-modell som `.agent/prompts/` redan har.

**Renaming på köpet:** `web-templates.mjs` → `task-templates.mjs` med re-export från gamla namnet (noll brytande change för publika imports via `index.mjs`).

### 1.4 Rollgap-analys — med en korrigering av premissen

Briefen frågar om en `DBA/Schema`-specialist saknas. **Den finns:** `.agent/prompts/Alchemist.md` — *"Alchemist - Schema, Migration & Data-Integrity Specialist: Database and schema change guardian. Inspecting schema constraints, reviewing and generating migrations, and ensuring data integrity across destructive or backfill operations."* Den är välskriven (inspect-before-migrate, reversibilitetskrav, "No Silent Data Loss").

Faktisk balans i dagens roster (8 roller):

| Roll | Domän | Not |
|------|-------|-----|
| A11y | Web-tillgänglighet | webbspecifik |
| Alchemist | DBA/Schema/Data | ✅ täcker briefens exempel |
| Bolt | Prestanda/payload | generisk |
| Janitor | Teknisk skuld/död kod | generisk |
| Overseer | Arkitektur/audit | generisk |
| Scribe | Metadata/dokumentation | webblutande (canonical, OpenGraph, JSON-LD, sitemaps) |
| Sentinel | Säkerhet | generisk |
| Spectator | E2E/visuell regression | webbspecifik (Playwright, viewports) |

**Faktiska gap:**

1. **DevOps/Infra-specialist** (förslag: namn **Forge**) — CI-workflows, Dockerfile, IaC, runner-pinning, build-reproducibilitet. Kanske det tydligaste gapet med tanke på att kitet *själv* är ett CI-orchestreringsverktyg. Synergi: Forge-rollen + `ci-templates.mjs`-kunskapen + föreslagen `agent-ci-audit`-template.
2. **SRE/Observability-specialist** (förslag: **Beacon**) — loggkontrakt, felkodskatalog, metriknamngivning, alert-trösklar. Kopplar till `agent-log-contract`-förslaget ovan.
3. **Data-pipeline-specialist** — partiellt av Alchemist; kan vänta.
4. **Scribe är för webblutad för sitt uppdrag** — dok-drift är ett universellt problem (kitet har till och med `scripts/doc-sync-check.mjs` för sitt eget repo). Förslag: antingen bredda Scribe till allmän "dokumentations- och ytkonsistens" eller bryta ut en webb-metadaroll. Detta är exakt samma "två sanningar"-risk som guardrail-inkonsistensen i fynd #2.

**Viktig befintlig styrka att bevara:** eftersom `resolveRolePrompt` läser valfri `.md` i `.agent/prompts/` kan en användare redan idag skapa sin egen specialist — inklusive en egen Forge — utan att vänta på upstream. Dokumentera det som den officiella extensionsvägen medan de inbyggda rollerna fylls på.

---

## Kluster 2: Stack-Universalitet

### 2.1 Verifierade Node/JS-läckor

Detta är de konkreta fynden, i fallande allvarlighet:

**(a) Bugg: `"django".includes("go") === true`.**
`src/wizard-oracle.mjs:95`:

```js
if (stack.includes("go") || existsSync(join(root, "go.mod"))) {
  candidates.typecheckCmd = candidates.typecheckCmd || "go vet ./...";
```

`detectPolyglotStack` returnerar `"django"` för Django-repon (stack-detektor rad 447), och `"django"` innehåller substringen `"go"`. Eftersom Django-repon inte har `mypy`-typecheckCmd satt vid det laget sätts `typecheckCmd = "go vet ./..."` **för varje Django-projekt utan mypy**. `agentctl task optimize` föreslår alltså ett Go-verktyg i ett Python-projekt. Fix: `stack === "go"`. Syskonbugg: rad 105 `stack.includes("pytest")` är död kod (`detectPolyglotStack` returnerar aldrig `"pytest"`) — samma substring-mönster, samma rotorsak: stack-id jämförs som substring i stället för som identitet.

**(b) Bugg: guardrail-inkonsistens mellan `task create` och `task optimize`.**
`src/wizard-task.mjs:21–36` dokumenterar (i en utmärkt kommentar) att den hårdkodade raden "Do NOT modify package.json, pnpm-lock.yaml, tsconfig.json" ersattes med en härledd rad från `config.scope`. Men `src/task-optimizer.mjs:405` skriver fortfarande, i `optimizeTaskPrompt`'s "Standard Guardrails":

```js
lines.push("- Do NOT modify package.json, lockfiles, or .github/ infrastructure files.");
```

Ett Rust-repo som kör `agentctl task optimize` får alltså en guardrail som nämner `package.json` — och, värre, *inte* nämner `Cargo.toml` fast gate:n (`BUILTIN_PROTECT`) skyddar den. Det är exakt det "agent bränner en repair-turn på en avoidable violation"-scenario kommentaren i wizard-task beskriver. Fix: `optimizeTaskPrompt` ska anropa `buildGuardrailFooter(config)` i stället för att bygga sin egen footer.

**(c) Hårdkodat `"npm test"`-fallback.**
`src/task-optimizer.mjs:353`: `const verifyCmd = analysis.oracle.command || options.verifyCmd || "npm test";` — i ett repo utan detekterat orakel skriver den optimerade envelopen in `npm test` i tre sektioner trots att `analysis.oracle.command` var `null` och frågan redan flaggats `MISSING_ORACLE`. Rätt beteende: låt `(None)` stå kvar och lita på falsifierbarhetsvägran.

**(d) Oracle-divergens för Python.**
`oracleCandidates` (`stack-detector.mjs:295`) använder korrekt `pytestCmd(process.env, root)` — som löser `python3`/`py`/venv och `PYTHONPATH=src`. Men `detectStackOracles` (`wizard-oracle.mjs:106`) skriver bare `"pytest"` — vilket missar venv-layouter och src-layout. Samma sanning, två källor, två svar. Fix: importera och återanvänd `pytestCmd`.

**(e) Django-branchen hårdkodar `python`.**
`stack-detector.mjs:447`: `python manage.py test --keepdb` — på distributioner med bara `python3` (Ubuntu, de flesta containers) failar oraklet med command-not-found. `pythonBin()`-hjälparen finns redan tre rader upp i samma fil och används av python-branchen — Django-branchen glömde den.

**(f) `detectWebIntent`'s orakelförslag är npm-världen.** (`task-optimizer.mjs:98–110`: `npx lhci`, `npx axe-cli http://localhost:3000`, …). Försvarbart — det är webbintent — men `localhost:3000` och `npx` antyder en Node-servad dev-server. Lågt prioriterat: gör porten till en param och notera att förslaget förutsätter Node.

### 2.2 Blandade backend/frontend-repon: single-stack-waterfallet

`detectPolyglotStack` är trots namnet en *precedence-waterfall som returnerar ett enda stack-svar* (26 ekosystem, ett svar). Konsekvenser:

- **JS-monorepo med Python-tjänster:** `turbo.json` checkas först (rad ~332) → `stack: "turbo"`, `npx turbo run test`. Python-tjänsternas test upptäcks aldrig.
- **Go-API + React-frontend:** `go.mod` (rad ~411) slår `package.json` (rad ~528) → frontendens vitest/playwright kör aldrig som orakel.
- **Lösningen finns redan delvis:** `findSubprojectRoot` (rad 568) gör manifestbaserad subprojektsupplösning för 12 manifesttyper + `.csproj`, och `resolveWorkspaceBoundary` (rad 873) används av `verify.scope: affected`. Det som saknas är att *toppnivån* rapportera alla stackar.

**Förslag:** låt `detectPolyglotStack` behålla sin nuvarande form (bakåtkompatibelt: `stack`, `testCmd`) men lägga till:

```js
return {
  ...container,
  stack: "go", testCmd: "go test ./...",   // oförändrat: primär stack
  stacks: [                                // nytt: alla detekterade
    { stack: "go", testCmd: "go test ./...", scope: "services/api" },
    { stack: "node", testCmd: "npm test", scope: "web/" },
  ],
};
```

och låt `resolveVerify`/`buildProfileStages` expandera `verify.scope: affected` till per-stack-orakel när flera stackar berörs. `findSubprojectRoot`'s manifestlista återanvänds som detektor — ingen ny logik.

### 2.3 Docker-baserade testsviter: förmågan finns, är död

`stack-detector.mjs:322–332` detekterar `.devcontainer/devcontainer.json` och `docker-compose.yml` och härleder `containerCmd` (`devcontainer exec --workspace-folder .` / `docker compose exec -T app`). **Grep bekräftar: ingen enda konsument utanför `test/stack-detector.test.mjs`.** Fältet beräknas, returneras och ignoreras.

Detta är det gap i klustret som är lättast att åtgärda, eftersom compose-wrapping är exakt vad Docker-baserade testsviter behöver:

```js
// resolveVerify: när config.verify.container !== false && detector.containerized
const prefix = detected.containerized && config.verify.container !== false
  ? `${detected.containerCmd} ` : "";
test: prefix + (userVerify.test ?? detected.testCmd)
```

Med bevarad escape hatch (`verify.container: false`) för den som kör oraklet på värden. Kitets egen sandbox-filosofi (net-guard, preload-isolering) gäller oförändrat inuti containern — oraklet körs bara där koden lever. Testfall: compose-repo med `app`-service som har `pytest` → orakel blir `docker compose exec -T app pytest`.

### 2.4 Ovanligare byggsystem

Nuläge: Bazel/Buck2/Pants/Nix/just/meson/ninja/Taskfile detekteras inte och faller till `stack: "unknown"` med tomma orakel — vilket är *korrekt beteende* (tyst giltighet vore värre), och `verify.*` i config är den dokumenterade flyktvägen. Noterbart: kitet gör redan rätt för Make — `makefileHasTestTarget` (rad 85) kräver att `test`-target faktiskt deklareras innan `make test` görs till orakel, med en kommentar som förklarar varför (ett orakel som är rött dag ett stänger av användaren från gates).

**Förslag — probe-baserad orakelvalidering som generisk mekanism:** generalisera Make-mönstret till "torrkörnings-probe": för kandidatkommandon, kör en billig non-mutating probe (`bazel query //...`, `just --list`, `ninja -t targets`) och bekräfta att test-target existerar *innan* kommandot görs till orakel. Detta är samma falsifierbarhetsprincip kitet tillämpar överallt annars, tillämpad på sin egen detektor. `runVerificationProbe` i `wizard-oracle.mjs:160` är redan halva byggstenen.

### 2.5 CI-bootstrap: `wizard-oracle.mjs` + `ci-templates.mjs`

**Bedömning: detta är klustrets starkaste del.** `agentctl ci init [--target github|gitlab]`:

- Genererar en workflow med det detekterade verktygsschemat (`STACK_TOOLCHAINS` täcker 18 stackar med korrekta setup-actions/images), inte en kopia av kitets egen CI — kommentarshuvudet i `ci-templates.mjs` dokumenterar exakt det misstaget som rättats.
- Varnar om SHA-pinning och versionsmatchning.
- Respekterar `config.baseBranch`.
- `hasBinary`-probar innan lokala verktyg föreslås (t.ex. `golangci-lint`).

**Gap:**

1. `STACK_TOOLCHAINS` saknar `foundry`, `hardhat`, `react-native`, `turbo`, `pnpm`, `nx` — de faller till "Node only", vilket är korrekt för JS-varianterna men **foundry behöver `forge`-installation** (rpc/cache-steg) — en genererad foundry-CI är röd på första push.
2. GitLab-sidans `needsNode`-logik antar `node:20`-basimage när verktygskedjan saknas — fungerar, men Cargo på GitLab (`rust:latest`) tappar caching-mönster som `ghcr.io/actions-rs`-användare förväntar sig; lågt prioriterat.
3. Ingen `ci init` för Jenkins/Buildkite/Azure — rimligt att vänta; designen (target-enum + renderer) gör tillägg billigt.
4. **Oracle-proben kopplas inte ihop med CI-genereringen:** `ci init` genererar workflow men verifierar inte att det testkommando som skrivs in i workflown faktiskt passerar lokalt. Förslaget i 2.4 (torrkörningsprobe) kan återanvändas: `ci init --verify` kör `runVerificationProbe` på det kommando som genereras och varnar innan filen skrivs.

---

## Kluster 3: Discovery & Proaktivitet

### 3.1 Nuläge: `jules-scan-todos.mjs` (48 rader)

Konkreta begränsningar, verifierade i koden:

| Begränsning | Konsekvens |
|---|---|
| Endast ignore: `node_modules`, `.git` (rad 18) | Scannar `target/`, `dist/`, `vendor/`, `.venv/`, `coverage/`, `build/`, `.next/` — allt |
| `readFileSync(full, "utf-8")` på varje fil (rad 26) | Binärer (bilder, `.wasm`, lockfile-blobs) läses som text; minnes- och tidsmässigt obegränsat på stora repon |
| Substring-matchning `TODO:`/`FIXME:` (rad 30) | Missar `TODO` utan kolon, `@todo`, `HACK`, `XXX`, `BUG:`; matchar falskt i strängar och dokumentation som råkar innehålla "TODO:" |
| `agentctl scan` (CLI rad 2049) skriver ut 10 rader, `exit(0)`, inget `--json` | Ingen maskinell konsumtion; MCP och scripts kan inte använda den |
| Ingen koppling till envelopes | Resultatet kan bara nå task-wizarden via interaktiv `confirm`-prompt (`wizard-task.mjs:265–281`) |

### 3.2 Discovery Engine — designförslag

**Kärninsikten (fynd #6):** kitet har redan *reparationskunskapen* för flera av briefens prober — `agent-doc-drift` (kommando/flagg/exportinventering), `agent-dep-audit` (pinning/låsfilintegritet), `agent-config-audit` (env/dokumentationsparitet, `.env.example`), `agent-security-audit` (sårbarhetsmönster). En Discovery Engine är kunskapen *inverterad*: samma invariant, men körd passivt av kitet för att hitta var den är bruten, istället för att skickas till agenten för att åtgärda den.

**Arkitektur — prober som rena funktioner:**

```js
// src/discovery/engine.mjs
// En probe är: (ctx) => Finding[]  — deterministisk, offline, zero-dep.
const Finding = {
  probe: "doc-drift",              // vilken probe
  severity: "medium",              // low | medium | high
  evidence: "README:42 flaggar --force; bin/agentctl.mjs saknar den",
  location: { file: "README.md", line: 42 },
  suggestedTemplate: "agent-doc-drift",
  draftParams: { docScope: "README, docs/" },
  draftTitle: "[Docs] Ta bort flagga --force ur README",
};
```

**Probkatalog, fasindelad efter hur mycket som redan finns:**

| Fas | Probe | Källa till logiken | Ny kod som krävs |
|-----|-------|--------------------|-------------------|
| 1 | `todo-fixme` (härdat: extension-filter, binärskip via NUL-byte-check, ignores från `.gitignore`-kärnmängd, `HACK/XXX/BUG/@todo`) | befintlig scanner | liten |
| 1 | `stale-oracle` — detekterade stacks vars `testCmd` är tomt eller platshållare | `oracleCandidates` + `bootstrapZeroTestRepo` | liten |
| 1 | `ci-pinning` — workflows som refererar actions via tagg i stället för SHA | `ci-templates.mjs` HEADER-kunskap | liten |
| 2 | `doc-drift` — `.env.example` ↔ `process.env`/`os.environ`-läsningar; dokumenterade flaggor ↔ parser | generalisera kitets eget `scripts/doc-sync-check.mjs` + `command-resolver.mjs` | medel |
| 2 | `dep-hygiene` — flytande versioner, opinnade git/http-källor, manifest↔lockfile-mismatch | `agent-dep-audit`-kritikfokus, offline (nätverksbaserad CVE-sökning är medvetligt utesluten — se templatekritiken) | medel |
| 2 | `alt-text` — `<img>` utan `alt=` i HTML/JSX/TSX/Vue/Svelte | ny, trivial regex-probe (endast om webbstack detekterad — koppla till `detectPolyglotStack`) | liten |
| 3 | `security-patterns` — SQL-konkat, `eval`/`exec`, osanerad shell-interpolation | `src/security.mjs`'s mönsterbank (används redan på diffs) | medel |
| 3 | `flaky-recurrence` — tester som återkommer i flaky-ledgern | `src/flaky-ledger.mjs` | liten |

**Output-kontrakt och guardrails:**

```
agentctl scan                     # mänsklig tabell
agentctl scan --json              # Finding[] för MCP/scripts
agentctl scan --draft             # skriver queue-utkast (.agent/jules-queue/DRAFT-*.md) — skriver ALDRIG dispatch
agentctl scan --dispatch          # opt-in: dispatchar utkast som passerat scorePromptFalsifiability-tröskeln
```

Tre principer som gör detta kitet-värdigt och inte en billig lint-stack:

1. **Varje finding måste bära evidens** (fil:rad + citat) — samma "Evidence Before Claims"-direktiv som Scribe-rollen tvingar på agenten.
2. **Varje finding pekar på en template med förifyllda params** — discovery-svaret är inte "du har 14 problem" utan "här är 14 färdiga, falsifierbara uppgifter". Detta är skillnaden mot en vanlig lint-runner.
3. **Utkast passerar samma falsifierbarhetsgate som allt annat** — en probe-finding utan lokalt orakel blir ett *förslag till människan*, aldrig en dispatch.

**MCP-integration:** `scan_codebase` som tool med samma finding-format — Claude/Cursor-användaren får proaktivt "din README flaggar tre flaggor som inte finns, vill du dispatcha agent-doc-drift?".

### 3.3 `task-optimizer.mjs` — heuristikens kvalitet för en ovan användare

**Styrkor (ofta förbisedda):**

- **Sökvägsverifiering med Levenshtein-korrigering** (rad 227–247): en prompt som nämner `src/wizrd-task.mjs` får inte bara fel utan ett förslag på rätt fil. Detta är ovanligt bra och direkt användbart.
- **Scope-check av refererade sökvägar** mot `config.scope` (rad 200) — prompten varnar *före* dispatch om den ber agenten röja skyddade pathar.
- **Trivial-orakelvägran** (rad 279–285) — `true`/`echo` kan inte bli ett orakel.
- **Automatisk orakeldetektering** — någorlunda korrekt efter fixen som dokumenterats i kommentaren vid rad 268–274 (`.length` på objekt-bug:en).

**Svagheter för just målgruppen (novisen):**

1. **Buzzwordslistan är 8 termer** (`VAGUE_BUZZWORDS`, rad 120–129) och engelskexklusiv. "make it work", "should be nicer", "optimize", "fix the tests" (som kan betyda både fixa koden och weaka testerna!) saknas. Svenska/tyska/franska vaga formuleringar matchas överhuvudtaget inte.
2. **`hasSymbolRef` är lättspelad:** regexen `/\b[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+\b/` (rad 176) ger +10 för *valfri* token med prick — `fix bug in app.js` får samma bonus som `assertThat(invoice.total).equals(149.0)`. Bonusen borde vikta mot ankarreferenser (funktion med parentes, backticks, testnamn).
3. **`optimizeTaskPrompt` föreslår men omskriver inte:** den skriver ut "Consider defining Airtight Positive Enclosures" (rad 250–251) men konstruerar aldrig enclosure-raderna `"ONLY modify: <de detekterade sökvägarna>"` trots att `analysis.paths.found` redan innehåller exakt materialet. En kraftig, gratis förbättring: om `positiveScopeMatch` är falsk och paths hittade, *generera* enclosure-raden istället för att rekommendera den.
4. **Gränsen 65 för `isFalsifiable` är ovaliduerad** (rad 300) — ingen kalibrering mot "skapade den här prompten en PR som passerade gaten?". Kitet har redan en telemetry-ledger och PR-harvest (`src/ops/pr-harvest.mjs`); falsifierbarhetspoäng vid dispatch borde loggas och korreleras mot gate-utfall — då kan tröskeln sänkas/höjas på data i stället för känsla.
5. **Ingen koppling mellan intent-detektering och templates:** `detectWebIntent` finns (rad 82) men den stoppar vid "consider incorporating exploration budget". Med Kluster 1:s katalog borde varje detekterad intent föreslå den matchande templaten (`api`-ordförråd → `agent-api-contract`, `migration`-ordförråd → `agent-migration-audit`). Detta gör optimizer till en *router in i katalogen* — den viktigaste enkelriktade förbättringen för noviser.

**Förslag: "falsifiability coach" som tredje nivå.** `task optimize --coach` ställer tre frågor i tur och ordning (orakel? målsymboler? acceptanskriterium med siffra?) och väver svaren in i en positiv enclosure — med hela den interaktiva TUI-mekanik som `wizard-task.mjs` redan har (`select`, `input`, `confirm`, `spinner`).

---

## Kluster 4: Provider-Agnostik

### 4.1 Nuläge: Jules-formad adapter, fem namngivna nycklar

`src/provider.mjs` (1 250 rader) stöder två transporttyper (`http`, `exec`) och fem namn (`NAMED_PRESETS`: `jules`, `claude-code`, `codex`, `gemini-flash`, `gemini-cli`). `provider-readiness.mjs` gör rätt förarbehandling: readiness är en egenskap hos den *valda* providern (env-nycklar för http, PATH-binärer för exec) — och dokumenterar varför `needsRepoSource` bara gäller den hostade Jules.

**Vad som redan är provideroberoende (viktigt att slå fast):** gate:n (`engine.mjs` gate/verify — inspekterar git working tree/staged/committed, aldrig agenten), tamper-scannern (`security.mjs`), lock manager:n (`state.mjs:587` `acquireLock` — filbaserad, PID+expiry+paths-jämförelse, repo-lokal), queue:n, evidence-insamlingen och risk-tier:na. En lokal agent kan alltså inte komma förbi kitets säkerhetslager oavsett adapter — det är kitets starkaste arkitekturval.

### 4.2 Var abstraktionen läcker

**(a) `createProvider` accepterar objekt-specs — men det är en hemlig väg.** `createProvider(config.provider, config)` tar ett objekt med `{type, command, args, promptViaStdin}` eller `{type, url, headers, bodyTemplate}` och allt fungerar (det är så claude/codex/gemini-presets definieras, rad 79–106). YAML-objekt i `.agent/config.yml` flödar igenom (`config.mjs:786`: `provider: parsed.provider || DEFAULTS.provider`). Men README:270 dokumenterar bara fyra strängnycklar. En Aider-användare kan idag sätta:

```yaml
provider:
  name: aider
  type: exec
  command: aider
  args: ["--yes-always", "--no-auto-commits", "--message", "{prompt}"]
```

…och det kommer att fungera — men inget stödjer dem: `providers`-kommandot listar dem inte (`PROVIDER_DESCRIPTORS` är en hårdkodad konstant), ingen readiness-probe, ingen dokumentation. **Förslag: `provider.presets` i config** — namngivna användarpresets som registreras i både `createProvider` och `PROVIDER_DESCRIPTORS` (med binäry- och env-descriptor), så att `agentctl providers` och liveness-proben täcker dem. Detta är den minsta möjliga ändringen som gör Claude Code/Codex/Aider/Ollama-harnessar till förstaklassiga medborgare.

**(b) Exec-adapterns sessionslivscykel är en tyst degradation.** För `type: "exec"` kör `dispatch` agenten synkront via `spawnSync` (rad ~516–530) och returnerar `{status: "completed", output}`. Därefter: `approvePlan` → no-op `{approved: true}`; `listActivities` → `[]`; `listSessions` → `[]`. Konsekvenser:

- **Plangodkännande-gaten existerar inte för lokala agenter** — `requirePlanApproval`-flaggan sätts i envelopen men har ingen mekanism på andra sidan. Den som tror att en Claude Code-dispatch väntar på godkännande har ingen gate alls. Detta borde vara explicit: antingen en capability-flagga som gör att `task create --require-plan-approval` varnar hårt när providern inte stödjer det, eller en tty-brygga där kitet visar planen och frågar användaren.
- **Retry/eskalering/evidence-harvest** (`session-ops.mjs`'s trace-extraktion, `retry`-kommandot) läser fält http-API:et returnerar; för exec-providers finns ingen trace — kitet bör säga det istället för att tyst returnera tomma listor (samma princip som "A Loosened Run Says So", v0.71.0).
- **Gemini-presets `--approval-mode=yolo`** (rad 103) — en lokal agent med auto-approve ändrar working tree *innan* kitets gate ser den. Preflight-gaten i `runTaskCreateWizard` fångar redan existerande violationer vid dispatch-tid, och post-gaten fångar resultatet — men mellan dem har agenten full skrivåtkomst. Dokumentera hotmodellen explicit: för exec-providers är kitets garanti *detektion och blockering*, inte *prevention* (prevention är Jules sandbox eller agentens egna approval-flägar).

**(c) PR-ansvar för lokala agenter är odefinierat.** `automationMode: AUTO_CREATE_PR` är en Jules-body-parameter. En exec-agent committar (eller inte) lokalt; vem öppnar PR:n? Idag: agentens egna verktyg (claude/codex kan gh-anropa själva) — men kitet borde kunna erbjuda `agentctl pr` (kommandot finns redan, CLI rad 2390) som den deterministiska vägen: *agenten löser uppgiften, kitet öppnar PR efter grön gate*. Det är den renaste separationen: agent = arbete, kit = grindar och logistik.

**(d) Copilot Workspace / Ollama — realistisk bedömning.** Copilot Workspace är GitHub-hostat utan stabilt publikt API; när det får ett, är `http`-presets interpoleringsmekanism (`{token}` enbart i headers med token-i-URL-vägran vid rad 281–287, header-injection-vakter vid rad 357/587/712, `bodyTemplate`) tillräckligt generisk — ingen ny adapterkod krävs, bara en preset + descriptor. Ollama är inte en kodagent utan en modellserver: rätt integrationspunkt är *genom en agent-CLI-harness* (t.ex. `aider --model ollama/qwen2.5-coder` eller opencode) som en exec-preset — vilket förslag (a) redan möjliggör. Att skriva en egen "ollama-adapter" som loopar completions vore att återuppfinna en agent-runtime i kitet; avstå, dokumentera vägen via presets.

### 4.3 Formalisering: ProviderAdapter + capability-matris + conformance

Förslag på tre konkreta steg, i storleksordning:

1. **Capability-flaggor på varje preset/descriptor:**

```js
export const CLAUDE_PRESET = {
  ...,
  capabilities: {
    planApproval: false,     // approvePlan är no-op
    sessionLifecycle: false, // getSession/listActivities är statiska
    opensPRs: "agent-side",  // "provider" | "agent-side" | "kit"
    synchronous: true,       // dispatch blockerar
    needsRepoSource: false,  // kör i utcheckningen
  },
};
```

`engine.mjs`'s poll-loop, retry och `requirePlanApproval` kollar flaggorna i stället för att `providerSpec.name === "jules"`-grena — det sista är den typ av läckande kunskap som gör nya providers dyra.

2. **Conformance-suite via dry-run.** Kitet har redan perfekt testinfrastruktur för detta: varje adapter stödjer `ctx.dryRun` och returnerar kanoniska svar. En `test/provider-conformance.test.mjs` som kör ett standarduppgiftsflöde (create → dispatch → poll → approve → resume) mot varje preset i dry-run lägger fast kontraktet *innan* fler presets tillkommer. `test/api-surface.test.mjs` och `test/session-poll.test.mjs` är halva mallen redan.

3. **Dokumentera objekt-specen som publikt API** — sektionen "Custom providers" i README med Aider/Ollama-via-harness-exempel. Det är den enskilda billigaste åtgärden för "användbart för alla": mekanismen finns, den är bara osynlig.

---

## Prioriterad Roadmap

### P0 — buggfixar (dagar, var och en < 20 rader diff)

| # | Åtgärd | Plats |
|---|--------|-------|
| P0.1 | `stack.includes("go")` → `stack === "go"` (+ ta bort döda `stack.includes("pytest")`) | `src/wizard-oracle.mjs:95,105` |
| P0.2 | `optimizeTaskPrompt` använder `buildGuardrailFooter(config)` i stället för hårdkodad Node-guardrail | `src/task-optimizer.mjs:405` |
| P0.3 | Ta bort `"npm test"`-fallet i `optimizeTaskPrompt`'s verifyCmd | `src/task-optimizer.mjs:353` |
| P0.4 | `detectStackOracles` använder `pytestCmd()` | `src/wizard-oracle.mjs:106` |
| P0.5 | Django-branchen använder `pythonBin()` | `src/stack-detector.mjs:447` |

### P1 — strukturella förbättringar (1–2 releaser)

| # | Åtgärd | Syfte |
|---|--------|-------|
| P1.1 | Konsumera `containerCmd` som orakelprefix (`verify.container` opt-out) | Docker-testsviter (2.3) |
| P1.2 | Multi-stack-detektering (`stacks: []`) + affected-scope per stack | Blandade repon (2.2) |
| P1.3 | `.agent/templates/*.yml` med validering, namnrymd och CLI/MCP-integration | Användartemplates (1.3) |
| P1.4 | `provider.presets` i config + registrering i descriptors + dokumentation | Custom providers (4.2a) |
| P1.5 | `agentctl scan --json` + härdat TODO/FIXME-scannande (ignores, binärskip, fler taggar) | Discovery-grunden (3.1) |
| P1.6 | Capability-flaggor på presets; `requirePlanApproval` varnar när providern inte stödjer det | Provider-ärlighet (4.3.1) |
| P1.7 | `ci init --verify` (torrkörningsprobe av genererat orakel) + foundry i `STACK_TOOLCHAINS` | CI-bootstrap (2.5) |

### P2 — strategiska satsningar (v1-linjen)

| # | Åtgärning | Syfte |
|---|--------|-------|
| P2.1 | Discovery Engine fas 1–2 (todo/stale-oracle/ci-pinning/doc-drift/dep-hygiene/alt-text) med `--draft`/`--dispatch` och MCP-tool | Proaktivitet (3.2) |
| P2.2 | Orakeltaxonomi (`oracle.baseline/redGreenInversion/measurableGates`) som template-schema + 5 nya domäntemplates (migration, api-breaking, containerize, ci-audit, log-contract) | Domänbredd (1.2) |
| P2.3 | Forge (DevOps/Infra) + Beacon (SRE/Observability) roller; bredda Scribe | Rollgap (1.4) |
| P2.4 | `task optimize` → intent-router in i templatekatalogen + `--coach`-läge | Novisguidning (3.3) |
| P2.5 | Provider-conformance-suite (dry-run) + `agentctl pr` som kit-ansvarig PR-väg för lokala agenter | Provider-agnostik (4.3) |
| P2.6 | Falsifierbarhetspoäng loggas i telemetry och korreleras mot gate-utfall (kalibrera tröskel 65) | Datadriven heuristik (3.3.4) |
| P2.7 | `web-templates.mjs` → `task-templates.mjs` (re-export, MCP-tool-alias) | Namn ärligt mot innehåll (1.1) |

---

## Slutsats

Kitets arkitektoniska kompass — *falsifierbara orakel, evidens före påståenden, detektera inte anta* — är inte bara kompatibel med generaliseringen mot backend, DevOps, discovery och multi-provider; den är själva skälet generaliseringen lyckas om den görs på kitets villkor. De viktigaste fynden är inte att kitet är webb- och Jules-låst i grunden (det är det inte — säkerhetskärnan är redan stack- och provideroberoende), utan att universaliseringsarbetet är **halvgjort på flera ställen**: guardrailen fixades i `wizard-task` men inte i `task-optimizer`; containerdetekteringen byggdes men kopplades aldrig in; objekt-providers stöds men dokumenteras inte; doc-drift-kunskapen skrevs som reparationsprompt men aldrig som probe. Vägen framåt är därför mest *fullföljande* — koppla ihop de halva broarna — snarare än nybygge, och den börjar med de fem P0-fixarna.
