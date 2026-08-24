# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body-file <path>`. Use a body file for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments as needed and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."` or use `--body-file <path>` for multi-line comments.
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `gh issue edit <number> --remove-label "..."`.
- **Close an issue**: `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`; `gh` does this automatically when run inside this clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** Set this to `yes` if the repository later decides to treat external pull requests as feature requests; `/triage` reads this flag.

GitHub shares one number space across issues and pull requests, so a bare `#42` may be either. Resolve it with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The map is a single issue with child issues as tickets.

- **Map**: create one issue labelled `wayfinder:map` containing the Notes, Decisions-so-far, and Fog sections.
- **Child ticket**: link an issue to the map as a GitHub sub-issue. If sub-issues are unavailable, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Use a `wayfinder:<type>` label where `<type>` is `research`, `prototype`, `grilling`, or `task`.
- **Blocking**: prefer GitHub's native issue dependencies. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric database ID from `gh api repos/<owner>/<repo>/issues/<number> --jq .id`. If dependencies are unavailable, add `Blocked by: #<number>` at the top of the child body.
- **Frontier query**: choose the first open, unassigned child in map order that has no open blocker.
- **Claim**: run `gh issue edit <number> --add-assignee @me`; this is the session's first write.
- **Resolve**: record the answer in an issue comment, close the child, and append a context pointer and link to the map's Decisions-so-far section.
