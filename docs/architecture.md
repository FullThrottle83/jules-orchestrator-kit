# Architecture & Pipeline Flow

The Google Jules Orchestrator Kit is built to safely and automatically execute task boundaries, test code changes, and loop through an OODA (Observe, Orient, Decide, Act) cycle before finally creating a Pull Request.

## Detailed Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    
    box rgb(244,244,244) "Client Edge"
        actor Trigger as "Client (CLI / CI / SDK)"
    end
    
    box rgb(232,244,248) "Control Plane"
        participant Orc as "Orchestrator Core"
        participant Gate as "Self-Audit Gatekeeper"
    end
    
    box rgb(254,243,242) "Worker & Local Workspace"
        participant API as "Google Jules API"
        participant Tree as "Git Worktree (Local)"
    end

    box rgb(245,243,255) "Remote SCM"
        participant Remote as "GitHub Remote"
    end

    Trigger->>+Orc: Dispatch Task Payload
    
    note over Orc,Tree: Phase 1: Security Redaction & Provisioning
    Orc->>Orc: Redact Secrets (Entropy > 3.6) & Enforce Dynamic Guardrails
    Orc->>+Tree: Provision Isolated Worktree (git worktree add)
    Tree-->>-Orc: Worktree Ready
    
    loop OODA Repair Cycle (1..3 Attempts)
        note over Orc,API: Phase 2: Agent Execution & Dispatch
        Orc->>+API: Dispatch Task + #lt;MCP_DIRECTIVE#gt; & Scope Bounds
        
        alt API Network / Rate Limit / Timeout
            API-->>Orc: HTTP 429 / 5xx / Timeout
            Orc->>Orc: Record Telemetry (Exit 2)
            Orc-->>Trigger: Abort Execution (Exit 2: API Failure)
            note over Orc,Tree: Cleanup: Teardown Worktree
        else API Succeeded
            API->>+Tree: Apply Proposed Code Changes
            Tree-->>-API: Patch Applied to Worktree
            API-->>-Orc: Execution Completed
            
            note over Orc,Gate: Phase 3: 4-Tier Verification Gate
            Orc->>+Gate: Trigger Audit (rules strictly from origin/main)
            
            Gate->>+Tree: Tier 1: Scope Audit (committed + untracked vs forbidden_paths)
            Tree-->>-Gate: File List & Diff Payload
            
            alt Tier 1 Scope Breach (Exit 3)
                Gate-->>Orc: Scope Violation Detected
                Orc-->>Trigger: Abort Execution (Exit 3)
                note over Orc,Tree: Cleanup: Teardown Worktree
            else Tier 2 Diff Payload > 75 KB (Exit 5)
                Gate-->>Orc: Payload Limit Exceeded
                Orc-->>Trigger: Abort Execution (Exit 5)
                note over Orc,Tree: Cleanup: Teardown Worktree
            else Tier 3 Secret Detected in Diff (Exit 6)
                Gate-->>Orc: High-Confidence Secret Detected
                Orc-->>Trigger: Abort Execution (Exit 6)
                note over Orc,Tree: Cleanup: Teardown Worktree
            else Tier 1-3 Passed -> Execute Tier 4 Verification
                Gate->>+Tree: Tier 4: Run Trusted testCmd & buildCmd (NetGuard Sandbox)
                Tree-->>-Gate: Execution Exit Code + stdout/stderr
                
                alt Verification Passed (100% Green)
                    Gate-->>Orc: Verification Success
                    
                    alt Diff is Empty (No Changes)
                        Orc-->>Trigger: Abort PR - Diff is Empty (Exit 0)
                        note over Orc,Tree: Cleanup: Teardown Worktree
                    else Changes Present
                        Orc->>+Tree: Commit Verified Changes
                        Tree-->>-Orc: Commit Created
                        Orc->>+Remote: Push Branch & Open Pull Request
                        Remote-->>-Orc: PR Created (#123)
                        Orc->>Orc: Record Success Telemetry
                        Orc-->>Trigger: Dispatch Succeeded (Exit 0)
                        note over Orc,Tree: Cleanup: Teardown Worktree
                    end
                    
                else Verification Failed (Tests/Build Broken)
                    Gate-->>-Orc: Verification Failed + Stderr Trace
                    Orc->>Orc: Redact Stderr Trace & Record Failure Telemetry
                    
                    alt Retries Remaining (< 3)
                        Orc->>Orc: Construct Escalated Repair Prompt (Clean Stderr)
                    else Max Retries Exceeded (3/3)
                        Orc-->>Trigger: Abort & Log Diagnostic Feedback (Exit 4)
                        note over Orc,Tree: Cleanup: Teardown Worktree
                    end
                end
            end
        end
    end
    deactivate Orc
```

