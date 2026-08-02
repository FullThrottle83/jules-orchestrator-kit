# Architecture & Pipeline Flow

The Google Jules Orchestrator Kit is built to safely and automatically execute task boundaries, test code changes, and loop through an OODA (Observe, Orient, Decide, Act) cycle before finally creating a Pull Request.

## Detailed Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    
    box "Client Edge" #F4F4F4
        actor Trigger as Client (CLI / CI / SDK)
    end
    
    box "Control Plane" #E8F4F8
        participant Orc as Orchestrator Core
        participant Gate as Self-Audit Gatekeeper
    end
    
    box "Execution Sandbox" #F8E8E8
        participant API as Google Jules API
        participant Git as Git Worktree Sandbox
    end

    Trigger->>+Orc: Dispatch Task Payload
    
    note over Orc,Git: Phase 1: Security Redaction & Provisioning
    Orc->>Orc: Redact Secrets (Entropy > 3.6) & Enforce Dynamic Guardrails
    Orc->>+Git: Provision Isolation Sandbox (git worktree)
    Git-->>-Orc: Sandbox Ready
    
    loop OODA Repair Cycle (Max 3 Retries)
        note over Orc,Git: Phase 2: Agent Execution & Dispatch
        Orc->>+API: Dispatch Task + <MCP_DIRECTIVE> & Target Scope
        API->>+Git: Apply Proposed Code Changes
        Git-->>-API: Changes Written
        API-->>-Orc: Execution Complete
        
        note over Orc,Gate: Phase 3: Tiered Verification & Gatekeeping
        Orc->>+Gate: Trigger Self-Audit (trusted origin/main rules)
        
        Gate->>+Git: Scope Audit (`git diff -z --name-only` vs forbidden_paths)
        Git-->>-Gate: Diff Stats & File List
        
        alt Scope Breach (Forbidden Path OR Diff Payload > 75 KB)
            Gate-->>Orc: Security / Scope Violation Detected
            Orc->>Orc: Record Telemetry (metrics.jsonl)
            Orc-->>Trigger: Abort Execution (Exit 3)
            break Fatal Security Error
                Orc->>Git: Teardown Worktree Sandbox
            end
        else Scope Verification Passed
            Gate->>+Git: Run Dynamic Verification (`testCmd` & `buildCmd`)
            Git-->>-Gate: stdout / stderr verification results
        end

        alt 100% Verification Suite Passed
            Gate-->>-Orc: Verification Success
            Orc->>+Git: Commit & Push to Remote Branch / PR
            Git-->>-Orc: PR Ready
            Orc->>Orc: Record Telemetry (metrics.jsonl)
            Orc-->>Trigger: Dispatch Succeeded (Exit 0)
            break Task Completed
                Orc->>Git: Teardown Worktree Sandbox
            end
        else Verification Failed
            Gate-->>Orc: Verification Failed (Stderr Trace output)
            Orc->>Orc: Record Failure Telemetry
            
            alt Retries Remaining (< 3)
                Orc->>Orc: Construct Repair Prompt with Stderr Trace
            else Max Retries Exceeded (3/3)
                Orc-->>-Trigger: Abort & Log Diagnostic Feedback (Exit 4)
                Orc->>Git: Teardown Worktree Sandbox
            end
        end
    end
```
