---
name: code-quality
description: Audit code & tests in a scope against the repo's own standards, then produce a prioritized action plan.
inputs:
  - scope
---

# code-quality

**Inputs:** `scope` — what's in scope (e.g. "frontend code", "api", "tests").

## 1. Standards & scope  (util)
Identify what code/docs/tests are in scope for this task (`{{scope}}`).
Assemble the documentation and selected best practices for this repo;
check for linting config and established standards. Write `standards.md`
with: the in-scope file set, the standards that apply, and any gaps.

## 2. Review code  (dev, parallel)
Read `standards.md`. For your assigned code area, look for issues with
logic evaluation, error handling, duplicated code, naming, parameters/args,
and types. List each as `file:line — issue — severity`. Write
`code-issues-<area>.md`. Do not edit code.

## 3. Review tests  (dev, parallel)
Read `standards.md` and the in-scope test files. Verify the tests actually
prove code behavior and that assertions are trustworthy. Look for issues
with setup/teardown, mocks, over-lenient expectations, and whether test
cases are focused and small. Write `test-issues-<area>.md`.

## 4. Merge findings & update standards  (research)
Read `standards.md` and every `*-issues-*.md`. Cross-check for patterns
across code and tests. Update `standards.md` with any strengthened
reference standards implied by the findings. Write `findings.md`
summarizing the patterns.

## 5. Followup & action points  (high)
Read `findings.md`. Suggest followup checks or clarifications to do, and
collect the initial action points for planning. Write `actions-draft.md`.

## 6. Investigate stated issues  (dev)
Read `actions-draft.md` and the original `*-issues-*.md`. For the top
items, investigate the stated issues in the code/tests and confirm or
refute each with `file:line` evidence. Write `investigation.md`.

## 7. Final action plan  (high)
Read `actions-draft.md` and `investigation.md`. Develop the final,
prioritized action plan. Write `action-plan.md`.

## 8. Present to user  (high)
Summarize `action-plan.md` for the user in their language. Surface the
decisions to take clearly and concretely. Do not start implementing.
