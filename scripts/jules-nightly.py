#!/usr/bin/env python3
"""
Framework-Agnostic Nightly Jules Maintenance & Audit Suite Runner
Dispatches scheduled automated code health & maintenance tasks to Google Jules.
"""

import sys
import os
import datetime
import subprocess
import json
import argparse

REPO_NAME = os.environ.get("JULES_REPO", "")

UNIVERSAL_NIGHTLY_TASKS = [
    {
        "id": "sec-review",
        "title": "Nightly Security & Secret Leaks Audit",
        "prompt": (
            "Perform a security review of the repository. "
            "Scan for hardcoded API keys, exposed secrets, unmasked PII in logs, "
            "and unvalidated input parameters in public endpoints."
        )
    },
    {
        "id": "a11y-audit",
        "title": "Nightly Accessibility & ARIA Audit",
        "prompt": (
            "Audit UI components for WCAG 2.2 AA accessibility standards. "
            "Verify that form inputs have labels, interactive elements support keyboard focus, "
            "and all images have descriptive alt text."
        )
    },
    {
        "id": "dead-code-prune",
        "title": "Nightly Dead Code & Unused Exports Audit",
        "prompt": (
            "Audit the codebase for unused exports, dead files, and obsolete types. "
            "Prune unused local utility functions and unreferenced types. "
            "Verify that test and build suites pass cleanly before opening a PR."
        )
    },
    {
        "id": "zombie-env-audit",
        "title": "Nightly Unused Environment Variable Audit",
        "prompt": (
            "Scan configuration files and environment variable declarations against codebase usage. "
            "Identify unused or zombie environment variables that are declared but never referenced in source code. "
            "Document findings and remove obsolete declarations."
        )
    }
]

def log_nightly_history(task_results, dry_run=False):
    date_str = datetime.datetime.now().strftime("%Y-%m-%d")
    history_dir = os.path.join(os.getcwd(), ".agent", "history")
    os.makedirs(history_dir, exist_ok=True)
    history_file = os.path.join(history_dir, f"{date_str}-nightly-audit.md")
    
    mode_label = "[DRY RUN]" if dry_run else "[DISPATCHED]"
    content = f"""---
type: nightly_jules_audit
timestamp: "{datetime.datetime.now().isoformat()}"
status: "{mode_label}"
---
# Nightly Jules Maintenance Suite Audit - {date_str}

Summary of automated audit dispatches:

"""
    for res in task_results:
        content += f"- **{res['title']}** (`{res['id']}`): {res['status']}\n"

    with open(history_file, "w", encoding="utf-8") as f:
        f.write(content)
        
    print(f"📝 Logged nightly audit summary to: {os.path.relpath(history_file)}")

def dispatch_task(task, dry_run=False):
    title = task["title"]
    full_prompt = task['prompt']
    
    print(f"\n🌙 [{task['id']}] Preparing task: '{title}'...")
    
    if dry_run:
        print(f"   [DRY RUN] Would dispatch task '{title}' to target repository")
        return {"id": task["id"], "title": title, "status": "Dry Run OK"}
        
    dispatch_script = os.path.join(os.getcwd(), "scripts", "jules-dispatch.mjs")
    if os.path.exists(dispatch_script):
        try:
            cmd = ["node", dispatch_script, title, full_prompt]
            subprocess.run(cmd, check=True)
            return {"id": task["id"], "title": title, "status": "Dispatched successfully"}
        except subprocess.CalledProcessError as e:
            print(f"❌ Failed to dispatch via jules-dispatch.mjs: {e}")
            return {"id": task["id"], "title": title, "status": f"Failed: {e}"}
    else:
        print(f"❌ Dispatch script not found at {dispatch_script}")
        return {"id": task["id"], "title": title, "status": "Failed (Script missing)"}

def main():
    parser = argparse.ArgumentParser(description="Nightly Jules Maintenance Suite Runner")
    parser.add_argument("--dry-run", action="store_true", help="Simulate run without dispatching tasks")
    args = parser.parse_args()

    print("==================================================")
    print("🌙 Nightly Jules Maintenance & Audit Suite")
    print("==================================================")
    
    if args.dry_run:
        print("🔍 Running in DRY RUN mode. No tasks will be dispatched.")
        
    results = []
    for task in UNIVERSAL_NIGHTLY_TASKS:
        res = dispatch_task(task, dry_run=args.dry_run)
        results.append(res)
        
    log_nightly_history(results, dry_run=args.dry_run)
    print("\n✅ Nightly Jules audit suite execution completed cleanly.")

if __name__ == "__main__":
    main()
