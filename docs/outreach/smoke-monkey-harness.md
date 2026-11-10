# Vad från jules-orchestrator-kit kan hjälpa smoke-monkey-harness

**Till:** Rajdeep ([RajdeepDevelopment/smoke-monkey-harness](https://github.com/RajdeepDevelopment/smoke-monkey-harness))
**Från:** jules-orchestrator-kit ([v0.76.3, `4b5e643`](https://github.com/FullThrottle83/jules-orchestrator-kit))
**Datum:** 2026-11-10 · Båda projekten är MIT.

---

## Kort version

Våra projekt attackerar samma problem från varsin sida. Smoke Monkey äger
**runtime** — loopen, verktygen, MCP, sessioner, kompaktering. jules-orchestrator-kit
äger **granskningsgränsen** — vad som får ändras, om testerna fortfarande betyder
något, och vad som faktiskt bevisades. Det som är värt att låna är därför inte
orkestreringen, utan fyra små moduler som sitter exakt på den gränsen:

| # | Modul | Storlek | Beroenden | Vad den löser hos er |
| :-- | :--- | :-- | :-- | :--- |
| 1 | [`src/test-tamper-guard.mjs`](../../src/test-tamper-guard.mjs) | 2173 rader | 1 (85-radig fil) | Agenten gör rött grönt genom att ändra testet |
| 2 | [`scripts/guard-reach-check.mjs`](../../scripts/guard-reach-check.mjs) + [`src/guard-policy.mjs`](../../src/guard-policy.mjs) | ~1500 rader | 0 | En vakt som tystnat ser grön ut |
| 3 | [`src/secret-scanner.mjs`](../../src/secret-scanner.mjs), [`src/bidi-guard.mjs`](../../src/bidi-guard.mjs), [`src/prompt-guard.mjs`](../../src/prompt-guard.mjs) | 545 + 211 + 279 | 0 / 1 / 2 | Hemligheter och osynlig text korsar verktygsgränsen |
| 4 | [`src/process-tree.mjs`](../../src/process-tree.mjs) | 342 rader | 0 | Timeout lämnar kvar orphanade processer |

Resten av kitet (providers, token-pool, router, swarm, kö) rekommenderar jag
**inte** — se [Vad ni inte ska ta](#vad-ni-inte-ska-ta).

En passande omständighet: kitets providerlager är bundet till Google Jules, som
läggs ner. Verifieringslagret är det som är provideragnostiskt — och det är
exakt det jag rekommenderar. Det är den delen som överlever sin namne.

---

## Vad jag faktiskt jämförde

Jag har läst er källkod på `main` (`5cb8877`), i första hand:

- `src/services/agent-guards.ts` — doom-loop, no-progress, fil-mutationsgränser
- `src/tools/terminal.tools.ts` — `run_command`/`run_test`, processgrupp och timeout
- `src/services/agent-loop.ts` — behörighetsflödet, inkl. `isSensitiveTarget`
- `src/lib/sanitize-assets.ts` — kontroll att `<file-SM-st>`-markören pekar på en riktig fil
- `src/services/artifact-store.ts` — `.smoke/runs`-artefakter

Och på kitets sida `src/test-tamper-guard.mjs`, `src/test-paths.mjs`,
`src/secret-scanner.mjs`, `src/bidi-guard.mjs`, `src/prompt-guard.mjs`,
`src/process-tree.mjs`, `src/evidence.mjs`, `src/guard-policy.mjs`,
`scripts/guard-reach-check.mjs`.

Allt jag påstår att modulerna gör nedan har jag kört, inte bara läst. Metoden var
att kopiera modulerna till en tom katalog och anropa dem med syntetiska diffar —
inga `node_modules`, ingen konfiguration, inget repo.

---

## 1. Test-tamper-guard — det största konkreta hålet

### Glappet

`run_test` beskriver sig själv korrekt: *"A failing test suite is reported as
data via the `[exit code: N]` marker — read the failure output and fix the
code."* Men ingenting hindrar modellen från att "fixa koden" genom att ändra
testet. `agent-guards.ts` räknar mutationer, upprepningar och misslyckade
verifieringar — den har inget begrepp om **vad** som ändrades. Behörigheter är
per verktygsanrop, inte per fil, så även `ask-default` tillåter att `edit_file`
skriver i `tests/`.

Det är den vanligaste och dyraste sortens gröna bygge: sviten går från röd till
grön, exitkoden är 0, och oraken är borta.

### Vad modulen gör

En ren funktion över en unified diff-sträng. Sju fyndtyper:

```
TEST_SKIP_INJECTION          it.skip, @pytest.mark.skip, t.Skip, #[ignore],
                             @Disabled, XCTSkip, { skip: true }, markTestSkipped …
VACUOUS_ASSERTION            assertTrue(true), expect(x).toBeDefined()
COMMENTED_ASSERTION          assertion kommenterad bort
ASSERTION_REMOVAL            assertion borta
ASSERTION_WEAKENED           == blir !=, toBe blir toBeTruthy
ASSERTION_EXPECTATION_CHANGED  förväntat värde skrivet om
TEST_DEREGISTERED            test avregistrerat ur sviten
```

Två detaljer som är värda att stjäla även om ni inte tar koden:

**Statusfältet.** `ok: true` från en kontroll som granskat noll filer är
byte-identiskt med `ok: true` från en kontroll som granskat allt. Modulen
returnerar därför `status: "PASS" | "FAIL" | "UNREADABLE" | "NOT_APPLICABLE"`.
Det är skillnaden mellan "kontrollerat och rent" och "inget kontrollerat".

**Satsen, inte raden, är enheten.** Den ursprungliga versionen jämförde fysiska
rader. Det fångade `assert.equal(add(1,2), 3)` → `-1`, men gick rakt igenom så
fort en formatterare radbröt anropet, eftersom värdet då hamnar på en rad utan
assertionsnyckelord. Varje formatterare gör det. Nu reassocieras rader till
satser innan jämförelsen.

### Verifierat

```js
import { checkTestTampering } from "./test-tamper-guard.mjs";

const diff = `--- a/tests/test_calc.py
+++ b/tests/test_calc.py
@@ -1,3 +1,3 @@
 def test_add():
-    assert add(1, 2) == 3
+    assert add(1, 2) == -1
`;

checkTestTampering(diff);
```

```json
{
  "ok": false,
  "violations": [{
    "file": "tests/test_calc.py",
    "line": 2,
    "type": "ASSERTION_EXPECTATION_CHANGED",
    "reason": "Test Tamper Guard: Expected value rewritten in tests/test_calc.py:2 — \"assert add(1, 2) == 3\" became \"assert add(1, 2) == -1\". …"
  }],
  "status": "FAIL"
}
```

Samma sak för `it(...)` → `it.skip(...)` gav `["TEST_SKIP_INJECTION"]`. Notera
att `.py`-fallet träffar trots att testvägen heter `tests/` och inte `test/` —
det var precis den buggen som en gång gjorde vakten helt tyst för pytest, Rust
och RSpec (se nästa avsnitt).

### Så kopplar ni in det

Modulen är beroendefri och läser ingen fil. Den behöver bara en diff. Naturlig
placering är där `run_test`/`run_command` redan har en `ToolContext` med
`workspaceDir`:

```ts
// efter en avslutad körning, inte per verktygsanrop
const diff = execSync(`git diff ${runStartSha}..HEAD -- '*test*' '*spec*'`, { cwd });
const { ok, violations, status } = checkTestTampering(diff);

if (status === "FAIL") {
  // två rimliga val, beroende på hur strikt ni vill vara:
  //  a) markera körningen 'needs_review' i stället för 'completed'
  //  b) returnera som data till modellen med orsaken, så den inte retryar blint
  guards.errorHistory.push(violations.map(v => v.reason).join("\n"));
}
```

Poängen med (b) är att `agent-guards.ts` redan har `errorHistory` — ett
tamper-fynd som hamnar där hindrar modellen från att upprepa samma manöver.
`isFinalReport()` i `agent-loop.ts` matchar `all checks (passed|green)` och
`TASK COMPLETE`; det är där ett grönt men ihåligt resultat tar sig ut. (Att den
är strukturell och kräver rubrik eller avslutsfras i radstart är bra design —
den gör att en modell som bara *nämner* orden inte avslutar i förtid.)

En ärlig nyans: modulen flaggar *förändrade förväntningar*, inte bara
försvagade. En legitim beteendeändring ser identisk ut i en diff. Därför finns
`allowTestChanges: ["expectation"]` — som tillåter exakt den kontrollen och
lämnar de sex andra aktiva. Det är rätt design, men det betyder att fyndet ska
till människa, inte automatiskt fälla allt.

---

## 2. Lärdomen bakom guard-reach-check — applicerbarhetsfällan

Det här är den mest värdefulla idén i kitet och den kostar inget att ta till sig
även om ni inte kopierar en rad.

### Vad som hände oss

Vår kontroll för testfiler matchade delsträngen `/test/`. Det förekommer inte i
`tests/test_calc.py`. Alltså var **hela tamper-vakten avstängd** för pytest,
Rust och RSpec — standardlayouterna. Allt som borde fångat det fungerade precis
som det skulle:

- enhetssviten återskapade samma distribution som implementationen skrevs från,
- doc-sync-gaten jämförde antal och versioner, och en vakt som vaktar ingenting
  bidrar ändå med gröna tester,
- nio-vägs CI-matris varierade OS och Node-version — ortogonalt mot felet,
- kodgranskning jämförde kod mot avsikt, och där var de ense; ögat levererar
  det inledande snedstrecket,
- release-gaten är en konjunktion över de fyra, och en signal som tystnar
  bidrar med `true`.

### Var ni har samma form

Samma risk finns i varje predikat som avgör om en kontroll **aktiveras**:

- `isSensitiveTarget()` i `agent-loop.ts` (avgör om hemlighetsfilen kräver OK)
- `IGNORE_DIRS` / `SEARCH_EXCLUDE_DIRS` i `ignores.ts`
- verktygsgruppsgating (`TOOL_GROUPS`, `options.tools`)
- er egen motsvarighet till `isTestPath` blir aktuell först när tamper-guarden är på plats

Om något av dem slutar matcha blir resultatet inte ett fel — det blir tyst.

### Metoden (tre steg, under en sekund, inga beroenden)

I [`scripts/guard-reach-check.mjs`](../../scripts/guard-reach-check.mjs):

1. **POLICY** — en handskriven vittnestabell i `guard-policy.mjs` som säger
   vilka sökvägar som *ska* klassas hur, med en `why` per rad. Kritisk detalj:
   tabellen härleds ur vad verktyget **utlovar**, aldrig ur de regexer som
   implementerar det. Annars blir implementationen sitt eget orakel, och en
   implementation som är sitt eget orakel kan inte ha fel.

   ```js
   export const TEST_PATH_CASES = [
     { path: "test/calc.test.js",  expected: true,  why: "node, conventional" },
     { path: "tests/test_calc.py", expected: true,  why: "pytest" },
     { path: "src/latest.js",      expected: false, why: "near-miss: 'test' as substring" },
   ];
   ```

2. **CANARIES** — varje känt-dåligt indata måste ge exakt det fynd den utlovar.
   En kanariefågel som kommer tillbaka ren är inte ett godkänt resultat; det är
   bevis på att regeln slutat nås.

3. **MUTANTER** — varje handskriven mutant av applicerbarhetspredikatet måste
   döda minst en kanariefågel. En överlevande mutant betyder att ingen
   kanariefågel någonsin krävde att vakten aktiverades — sviten skulle förbli
   grön om den slutade leta.

Ni kan köra samma sak på `isSensitiveTarget` genom att injicera predikatet
(er funktion tar redan `toolName, toolArgs, workspacePath`, så den är lätt att
byta ut i test). Det är ~100 rader test för att stänga en hel klass av tysta
fel.

Sidovinst: kitet har `ok: true`-ambiguiteten löst på samma sätt i
`flakyVerdict()`, som skiljer `HEALTHY` från `INSUFFICIENT_DATA` i stället för
att låta båda bli "grönt".

---

## 3. Hemligheter och osynlig text över verktygsgränsen

Tre små moduler, alla beroendefria eller nästan:

**`secret-scanner.mjs` (545 rader, 0 importer).** `redactSecrets()`,
`hasHighConfidenceSecret()`, entropiheuristik, `hasEncodedSecret()` för
base64-kodade hemligheter, `anonymizePii()`, samt en tabell över
förväxlingsbara tecken (`CONFUSABLE_TO_ASCII`). `scanDiff()`-varianter letar
bland tillagda rader, inte bara i hela texten.

```js
redactSecrets("key=AKIAIOSFODNN7EXAMPLE token=ghp_aaaa…");
// → "key=[REDACTED_BY_SECURITY_GATE] token=[REDACTED_BY_SECURITY_GATE]"
```

Tre ställen hos er där den gör nytta:

1. **Före modellen.** Verktygsutdata går rakt in i nästa tur. `run_command`
   kan skriva ut `.env`, en `git diff` kan innehålla en token, `read_file` kan
   träffa en nyckel. En redaktion vid den gränsen kostar en funktion.
2. **Före artefakten.** `artifact-store.ts` spiller trunkerad utdata till
   `.smoke/runs` som fil. Det som ligger där ligger kvar, och det är just den
   typen av fil någon råkar committa.
3. **Före loggen.** `logger.ts` och sessionens `run.json`.

**`bidi-guard.mjs` (211 rader).** Trojan Source (CVE-2021-42574), zero-width,
plane-14-taggar, blandade skript. Verifierat:

```js
checkUnicodeSecurity("const x = 1; // \u202Eevil");
// → { ok: false, violations: [{ type: "TROJAN_SOURCE_DETECTED",
//      reason: "…invisible directional control characters (CVE-2021-42574)." }] }
```

Er `sanitizeFileMarkers()` kontrollerar att en angiven sökväg **existerar** —
bra, och samma anda. Men den kontrollerar inte om innehållet som agenten skrev
bär osynlig text, och `apply_patch`/`edit_file` tar emot innehåll från modellen.
En bidi-override i en källfil ser ut som en kommentar för varje granskare och är
något annat för kompilatorn.

**`prompt-guard.mjs` (279 rader).** `sanitizeUntrustedData()` städar
zero-width, bidi, ANSI-escape, rollmarkörer (`<|im_start|>`, `[INST]`, `<<SYS>>`)
och kända injektionsfraser, och `buildAgentEnvelope()` lägger innehållet i
nonce-märkta UNTRUSTED-staket. Relevant eftersom er harness tar in PR-titlar,
issue-bodies och commit-meddelanden — text som någon annan skrivit och som
sedan hamnar i systemprompten.

---

## 4. process-tree — mindre, men verkligt

`terminal.tools.ts` gör redan det svåra rätt: `detached: true`, `kill(-pid)` mot
processgruppen, SIGTERM → SIGKILL med eskalering (ca rad 115–242). Bra. Två
luckor:

1. **Windows.** `taskkill /F /T /PID` saknas. `process-tree.mjs` (342 rader,
   noll importer) har den grenen plus en `pgrep -P`-nedstigning som fångar
   ättlingar även när barnet inte är gruppledare. Den exporterar också
   `normalizePid` med rimlighetskontroll.
2. **Bakgrundsprocesser.** Vid `background=true` rapporterar ni `PID` och
   instruerar `"To stop: run_command \"kill ${pid}\""` (~rad 741). Det är inte
   gruppkill, och en återanvänd PID är en giltig men fel process. En städning
   vid körningens slut — ni har redan `runId` och `.smoke/runs` — skulle stänga
   den.

---

## 5. Evidens: bind beviset till en commit

`evidence.mjs` gör en sak som är ovanligt nyttig och som `.smoke/runs` är
halvvägs till: den hashar **vad** som verifierades, inte bara **att** något
verifierades.

```
commitSha, branch, dirty   (getGitProvenance)
SHA-256 per fil + kataloghash + manifesthash (kedjad)
testkommando, exitkod, verdict
retention 200 manifest
```

För er: en `completed`-körning med `tool.completed`-händelser är en logg. En
manifestpost som säger *"den här commiten, dessa filer, detta testkommando,
denna exitkod, denna hash"* är något en granskare kan kontrollera i efterhand
utan att lita på loggen. `run_command` sparar redan trunkerad utdata till fil —
en hash över den filen är nästan gratis.

Och samma ärlighet som ni redan visar i er dokumentation gäller: kitets egen
`SECURITY.md` säger uttryckligen att hasharna **inte** är signaturer eller
attesteringar, och att den som kan skriva om posterna kan räkna om hasharna.
Skriv det i er README också, annars blir det en trovärdighetsrisk.

---

## Vad ni inte ska ta

Det här avsnittet är lika viktigt som de andra, annars är rekommendationen bara
artigt brus.

- **Dispatch, providers, token-pool, router, failover, kö, swarm, DAG.**
  Kitet löser "skicka en uppgift till en extern agent och hämta hem resultatet".
  Ni är agenten. Ingenting av det bär över.
- **`config.mjs`-beroendet.** `scope-guard.mjs` (317 rader) är bra, men
  importerar `normalizeScope` och `CI_DEFINITIONS` från kitets konfigurationslager,
  och därmed en hel konfigurationsmodell. Inte värt det för er. `test-paths.mjs`
  (85 rader, noll importer) är den del som faktiskt är återanvändbar.
- **Vakterna som sandlåda.** Ingenting av detta är en sandlåda. Det är
  heuristik med falska positiva, och kitets egen dokumentation säger det rakt ut
  ("the kit does not supply a process, filesystem or container sandbox"). Er
  `permissions`-modell gör ett annat — och delvis starkare — jobb. Modulerna
  ovan är komplement till behörigheter, inte ersättning.
- **Egna mutationsverktyg.** `mutation.mjs` (768 rader) genererar och kör
  mutanter. Det är ett bra verktyg, men för en harness är det en separat
  produktyta, inte en vakt. Ta det bara om ni vill ha mutation score som
  kvalitetsgrind — då är `runMutationTest({ minScore })` färdig att använda.

---

## Konkret förslag på ordning

1. `test-tamper-guard.mjs` + `test-paths.mjs` → ett `needs_review`-utfall på
   körningen. Störst effekt per rad, och det är ett *hål* i dag, inte en
   förbättring.
2. `secret-scanner.mjs` vid verktygsutdata- och artefaktgränsen. Litet, isolerat,
   omedelbart nytta.
3. Vittnestabell + kanariefåglar för era egna predikat (`isSensitiveTarget`,
   `IGNORE_DIRS`, verktygsgrupper). Ingen kod att importera, bara metod.
4. `bidi-guard.mjs` på `apply_patch`/`edit_file`-innehåll.
5. `process-tree.mjs` om Windows eller bakgrundsprocesser är i scope.

Licenserna är kompatibla (MIT båda). Kopiera med attribution i `NOTICE` eller
filhuvud — eller, om flera av modulerna tas, överväg att publicera dem som ett
eget litet `@smoke-monkey/guard`-paket; de har inga beroenden och ingen
konfiguration, så det är ett paket som går att äga.

## Vad jag kan bidra med

Jag kan göra porten åt er: TypeScript-version av tamper-guarden med era
`ToolContext`-typer, tester i er testsvit, och en adapter som anropar den efter
`run_test`. Säg till vilken av modulerna ni vill börja med, så skickar jag en PR
mot er `main` i stället för att ni ska behöva läsa 2173 rader JS för att avgöra
om idén håller.

Och motsatt riktning: om ni ser något i kitet som är fel — särskilt i
`guard-policy.mjs`, som är den del jag är minst säker på — är ett issue
välkommet. En vittnestabell som bara dess författare granskat är precis den
ensamhet som gjorde att `/test/`-buggen kunde leva så länge.
