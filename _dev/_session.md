# Coder Optimisation Session -- 2026-04-10

## Objective
Use the NPoint compass problem to test and evaluate Coder across all 5 task types.
Output: confirmed model stable rankings + solved compass problem.

## Coder Changes Deployed Today
- js/all.js: getModelsToUse() now returns all 5 stables (was filtering to 3)
- js/all.js: buildContext() now includes memory context (was missing)
- js/commands.js: sendToLastModel() now classifies task type and routes to best model
- api/query/[action].js: added Debug, Explain, Review, Plan system prompts

## Task-Type Router (client-side, no API call)
- fix/bug/error/broken/crash -> groq-cascade (Groq = fast tracer)
- explain/how does/what is/describe -> gemini-lite (Gemini Lite = clear explainer)
- review/audit/check/assess -> gemini-cascade (Gemini = thorough reviewer)
- plan/architect/strategy/best way -> gemini-cascade (Gemini = structured planner)
- write/create/implement/build -> mistral-cascade (Codestral = code writer)
- no match -> last used model

## Session Queries + Results

### Q1 -- PLAN (test: planning/reasoning)
Query sent: Plan the NPoint compass fix...
Models used: all 5 (All Mode)
Category classified as: [TBD]
Winner (thumbs-up): [TBD]
Notes: [TBD]

### Q2 -- EXPLAIN (test: explanation)
Query sent: Code: File app/js/north-point-2d.js explain...
Model routed to: [TBD]
Correct? [TBD]
Notes: [TBD]

### Q3 -- DEBUG (test: debugging)
Query sent: Debug: np-ctx-rotate-np wiring...
Model routed to: [TBD]
Root cause identified correctly? [TBD]
Notes: [TBD]

### Q4 -- CODE Bug 1 (test: code generation)
Query sent: Code: Fix Bug 1...
Model routed to: [TBD]
Code correct? [TBD]
Notes: [TBD]

### Q5 -- CODE Bug 2 (test: code generation)
Query sent: Code: Fix Bug 2...
Model routed to: [TBD]
Code correct? [TBD]
Notes: [TBD]

### Q6 -- REVIEW (test: code review)
Query sent: Code: Review proposed changes...
Model routed to: [TBD]
Issues caught: [TBD]
Notes: [TBD]

## Model Rankings (filled in after session)

### Planning/Reasoning
1. [TBD]
2. [TBD]
3. [TBD]
4. [TBD]
5. [TBD]

### Explanation
1. [TBD]
2. [TBD]
3. [TBD]
4. [TBD]
5. [TBD]

### Debugging
1. [TBD]
2. [TBD]
3. [TBD]
4. [TBD]
5. [TBD]

### Code Generation (Write/Fix)
1. [TBD]
2. [TBD]
3. [TBD]
4. [TBD]
5. [TBD]

### Code Review
1. [TBD]
2. [TBD]
3. [TBD]
4. [TBD]
5. [TBD]

## NPoint Compass Fix Status
- Bug 1 (Rotate N Point sets DN, should set TN): [OPEN/SOLVED]
- Bug 2 (2D rotate2D not applied to housing): [OPEN/SOLVED]
- Code reviewed: [Y/N]
- Applied to GPRTool: [Y/N]
