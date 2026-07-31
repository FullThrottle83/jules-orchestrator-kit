# Architecture & Pipeline Flow

The Google Jules Orchestrator Kit is built to safely and automatically execute task boundaries, test code changes, and loop through an OODA (Observe, Orient, Decide, Act) cycle before finally creating a Pull Request.

## Detailed Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    actor Trigger as Client (CLI / CI / SDK)
    participant Orc as Orchestrator Core
    participant API as Google Jules API
    participant Git as Git / Worktree Sandbox
    participant Gate as Self-Audit Gatekeeper

    Trigger->>Orc: Dispatch Task Payload
    
    note over Orc,Git: Phase 1: Security Redaction & Context Enrichment
    Orc->>Orc: Redact Secrets (Entropy > 3.6) & Enforce Dynamic Guardrails
    Orc->>Git: Provision Isolation Sandbox (Worktree / Repoless)
    Orc->>API: Dispatch Task + <MCP_DIRECTIVE> & Target Scope

    API->>Git: Apply Proposed Code Changes
    
    note over Orc,Gate: Phase 2: Tiered Verification & OODA Gatekeeper
    Orc->>Gate: Trigger Self-Audit (fetch trusted origin/main rules)
    Gate->>Git: Scope Audit (`git diff -z --name-only` vs forbidden_paths)
    
    alt Scope Breach (Forbidden Path Modified)
        Gate-->>Orc: Security Violation Detected
        Orc-->>Trigger: Abort Execution (Exit 3)
    else Scope Verification Passed
        Gate->>Git: Resolve & Run Dynamic Verification Suite (`test_cmd` & `build_cmd`)
    end

    alt 100% Verification Suite Passed
        Gate->>Orc: Verification Success
        Orc->>Git: Record Telemetry (`metrics.jsonl`)
        Orc-->>Trigger: Dispatch Succeeded (Exit 0)
    else Verification Failed (OODA Feedback Triggered)
        alt Auto-Repair Eligible (Retries < 3)
            Gate->>API: Auto-Dispatch Repair Prompt with Stderr Trace
        else Max Retries Exceeded
            Gate-->>Orc: Verification Exhausted
            Orc-->>Trigger: Abort & Log Diagnostic Feedback (Exit 4)
        end
    end
```
