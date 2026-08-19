# Architecture & Pipeline Flow

The Google Jules Orchestrator Kit is built to safely and automatically execute task boundaries, test code changes, and loop through an OODA (Observe, Orient, Decide, Act) cycle before finally opening a verified Pull Request.

---

## Autonomous Orchestration Sequence

```mermaid
sequenceDiagram
    autonumber
    
    actor Trigger as Client (CLI / CI / SDK)
    participant Orc as Orchestrator Core
    participant API as Google Jules API
    participant Tree as Git Worktree (Local)
    participant Gate as Self-Audit Gatekeeper
    participant Remote as GitHub Remote

    note over Trigger,Remote: Phase 1: Security Redaction & Worktree Provisioning
    Trigger->>Orc: Dispatch Task Payload
    Orc->>Orc: Redact Secrets (Entropy > 3.6) & Enforce Dynamic Guardrails
    Orc->>Tree: Provision Isolated Worktree (git worktree add)
    Tree-->>Orc: Worktree Ready

    loop OODA Repair Cycle (Max 3 Attempts)
        note over Orc,Tree: Phase 2: Agent Execution & Dispatch
        Orc->>API: Dispatch Task + Guardrails & Scope Bounds
        
        alt API Network / Rate Limit / Timeout
            API-->>Orc: HTTP 429 / 5xx / Timeout (Exit 2)
            Orc-->>Trigger: Abort Execution (Exit 2: API Failure)
        else API Execution Success
            API->>Tree: Apply Proposed Code Changes
            Tree-->>API: Patch Applied to Worktree
            API-->>Orc: Execution Completed
            
            note over Orc,Gate: Phase 3: 4-Tier Verification Gate (origin/main rules)
            Orc->>Gate: Trigger Audit
            Gate->>Tree: Run Tiers 1-3 (Scope Bounds, Diff < 75KB, Secret Scan)
            Tree-->>Gate: Scope & Security Audit Results
            Gate->>Tree: Run Tier 4: Trusted testCmd & buildCmd (NetGuard Sandbox)
            Tree-->>Gate: Execution Exit Code + stdout / stderr
            Gate-->>Orc: Audit Verdict (Pass or Failure Trace)

            note over Orc,Remote: Phase 4: Resolution / PR or Escalated Auto-Repair
            alt Gate Violation (Tier 1 Scope / Tier 2 Diff > 75KB / Tier 3 Secret)
                Orc-->>Trigger: Abort Immediate (Exit 3 / Exit 5 / Exit 6)
                Orc->>Tree: Teardown Worktree Sandbox
            else Verification Passed (100% Green) & Empty Diff
                Orc-->>Trigger: Abort PR - Diff is Empty (Exit 0)
                Orc->>Tree: Teardown Worktree Sandbox
            else Verification Passed (100% Green) & Changes Present
                Orc->>Tree: Commit Verified Changes
                Orc->>Remote: Push Branch & Open Pull Request
                Remote-->>Orc: PR Created (#123)
                Orc->>Orc: Record Telemetry Chain
                Orc-->>Trigger: Dispatch Succeeded (Exit 0)
                Orc->>Tree: Teardown Worktree Sandbox
            else Tests Failed & Retries Remaining (< 3)
                Orc->>Orc: Redact Stderr Trace & Formulate Escalated Repair Prompt
            else Tests Failed & Max Retries Exceeded (3/3)
                Orc-->>Trigger: Abort & Log Diagnostic Feedback (Exit 4)
                Orc->>Tree: Teardown Worktree Sandbox
            end
        end
    end
```

---

## 4-Tier Gatekeeper Architecture

Every proposed patch must clear all 4 verification tiers before entering remote SCM:

| Tier | Gatekeeper Component | Enforcement | Exit Code on Failure |
| :--- | :--- | :--- | :--- |
| **Tier 1** | **Scope Audit** | Compares modified + untracked files against `.agent/config.yml` `scope.deny` patterns. | `3` (Scope Violation) |
| **Tier 2** | **Diff Governor** | Ensures cumulative diff payload does not exceed budget (`75 KB`). | `5` (Diff Payload Limit) |
| **Tier 3** | **Secret Scanner** | High-entropy Shannon scanning (`entropy > 3.6`) and pattern detection (AWS, OpenAI, GitHub tokens). | `6` (Secret Leak Prevented) |
| **Tier 4** | **Test & Build Sandbox** | Executes project test and build oracles (`testCmd`, `buildCmd`) inside sandboxed sub-process. | `4` (OODA Exhausted on 3 fails) |

