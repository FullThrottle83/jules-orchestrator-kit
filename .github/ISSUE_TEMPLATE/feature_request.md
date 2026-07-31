name: Feature Request
description: Suggest an idea for Jules Orchestrator Kit
title: "[FEATURE] "
labels: ["enhancement"]
assignees: []
body:
  - type: markdown
    attributes:
      value: |
        Thanks for suggesting a new feature!
  - type: textarea
    id: description
    attributes:
      label: "Is your feature request related to a problem? Please describe."
      description: "A clear and concise description of what the problem is. Ex. I'm always frustrated when [...]"
      placeholder: "..."
    validations:
      required: true
  - type: textarea
    id: solution
    attributes:
      label: "Describe the solution you'd like"
      description: "A clear and concise description of what you want to happen."
      placeholder: "..."
    validations:
      required: true
  - type: textarea
    id: alternatives
    attributes:
      label: "Describe alternatives you've considered"
      description: "A clear and concise description of any alternative solutions or features you've considered."
      placeholder: "..."
    validations:
      required: false
