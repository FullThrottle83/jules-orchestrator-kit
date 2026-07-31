name: Bug Report
description: Create a report to help us improve Jules Orchestrator Kit
title: "[BUG] "
labels: ["bug"]
assignees: []
body:
  - type: markdown
    attributes:
      value: |
        Thanks for taking the time to fill out this bug report!
  - type: input
    id: version
    attributes:
      label: "Node.js Version"
      description: "What version of Node.js are you using? (e.g. v20.11.0)"
      placeholder: "v20.x"
    validations:
      required: true
  - type: dropdown
    id: package_manager
    attributes:
      label: "Package Manager"
      description: "Which package manager are you using?"
      options:
        - npm
        - pnpm
        - yarn
        - bun
    validations:
      required: true
  - type: dropdown
    id: execution_mode
    attributes:
      label: "Execution Mode"
      description: "How are you running Jules?"
      options:
        - API Mode (JULES_API_KEY set)
        - CLI Mode (Local jules binary)
    validations:
      required: true
  - type: textarea
    id: description
    attributes:
      label: "Bug Description"
      description: "A clear and concise description of what the bug is."
      placeholder: "When I run npm run jules:queue..."
    validations:
      required: true
  - type: textarea
    id: reproduction
    attributes:
      label: "Steps to Reproduce"
      description: "Steps to reproduce the behavior."
      placeholder: "1. Go to...\n2. Click on...\n3. See error"
    validations:
      required: true
  - type: textarea
    id: expected
    attributes:
      label: "Expected Behavior"
      description: "A clear and concise description of what you expected to happen."
    validations:
      required: true
