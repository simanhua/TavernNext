# Expandable Preset Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the horizontally compressed Chat Preset controls with multi-open expandable prompt, order-group, and advanced-settings cards.

**Architecture:** Keep the existing React Hook Form schema and field arrays intact, changing only their semantic markup and CSS layout. Native `details` elements provide independent open state without new application state; responsive grids inside each card prevent horizontal overflow.

**Tech Stack:** React 19, React Hook Form, TypeScript, CSS, Testing Library, Vitest.

## Global Constraints

- Multiple prompt and prompt-order cards may remain open simultaneously.
- The first prompt is open initially; other prompt cards and Advanced JSON are closed initially.
- Existing labels, API payloads, validation, conflict handling, ordering, import, and export semantics remain unchanged.
- Layout must not require horizontal page scrolling at desktop or narrow viewport widths.

---

### Task 1: Build expandable Preset editor cards

**Files:**
- Modify: `apps/web/src/features/presets/PresetManagerPage.test.tsx`
- Modify: `apps/web/src/features/presets/PresetEditor.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: existing `FormValues`, `prompts` and `promptOrders` field arrays, and their current accessible labels.
- Produces: native `details.preset-card` sections with `summary.preset-card-summary`, responsive `.preset-card-grid`, and `.preset-card-actions` layouts.

- [ ] **Step 1: Write failing interaction and structure tests**

Add a focused test that opens the Chat preset and asserts:

```tsx
const cards = screen.getAllByTestId('prompt-card');
expect(cards[0]).toHaveAttribute('open');
expect(cards[1]).not.toHaveAttribute('open');
await user.click(within(cards[1]!).getByText(/Post history/));
expect(cards[0]).toHaveAttribute('open');
expect(cards[1]).toHaveAttribute('open');
expect(screen.getByTestId('advanced-settings')).not.toHaveAttribute('open');
```

Also assert both summaries expose role and enabled status, and that a Prompt Order Group card expands without closing either Prompt card.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx vitest run apps/web/src/features/presets/PresetManagerPage.test.tsx --no-file-parallelism --maxWorkers 1
```

Expected: FAIL because `prompt-card`, multi-open details, and collapsed advanced settings do not exist.

- [ ] **Step 3: Add semantic expandable Prompt cards**

Replace the prompt `.array-row` with:

```tsx
const promptValues = form.watch('prompts');

<details className="preset-card" data-testid="prompt-card" open={index === 0 ? true : undefined}>
  <summary className="preset-card-summary">
    <span className="preset-card-title">Prompt {index + 1} · {promptValues[index]?.name || promptValues[index]?.identifier || 'Untitled'}</span>
    <span className="preset-card-meta">{promptValues[index]?.role || 'system'} · {promptValues[index]?.enabled === false ? 'Disabled' : 'Enabled'}</span>
  </summary>
  <div className="preset-card-body">
    <div className="preset-card-grid preset-card-grid-basic">
      <label>Prompt {index + 1} identifier<input {...form.register(`prompts.${index}.identifier`)} /></label>
      <label>Prompt {index + 1} name<input {...form.register(`prompts.${index}.name`)} /></label>
      <label>Prompt {index + 1} role<input {...form.register(`prompts.${index}.role`)} /></label>
      <label className="checkbox-label"><input type="checkbox" {...form.register(`prompts.${index}.enabled`)} />Prompt {index + 1} enabled</label>
    </div>
    <label className="preset-card-content">Prompt {index + 1} content<textarea {...form.register(`prompts.${index}.content`)} /></label>
    <div className="preset-card-grid preset-card-grid-advanced">
      <label>Prompt {index + 1} system prompt<select {...form.register(`prompts.${index}.systemPrompt`)} /></label>
      <label>Prompt {index + 1} marker<select {...form.register(`prompts.${index}.marker`)} /></label>
      <label>Prompt {index + 1} injection position<input {...form.register(`prompts.${index}.injectionPosition`)} /></label>
      <label>Prompt {index + 1} injection depth<input {...form.register(`prompts.${index}.injectionDepth`)} /></label>
      <label>Prompt {index + 1} injection order<input {...form.register(`prompts.${index}.injectionOrder`)} /></label>
      <label>Prompt {index + 1} forbid overrides<select {...form.register(`prompts.${index}.forbidOverrides`)} /></label>
      <label>Prompt {index + 1} injection triggers<input {...form.register(`prompts.${index}.injectionTrigger`)} /></label>
      <label>Prompt {index + 1} generation triggers<input {...form.register(`prompts.${index}.generationTrigger`)} /></label>
    </div>
    <div className="preset-card-actions">
      <button type="button" disabled={index === 0} onClick={() => prompts.move(index, index - 1)}>Move up</button>
      <button type="button" disabled={index === prompts.fields.length - 1} onClick={() => prompts.move(index, index + 1)}>Move down</button>
      <button type="button" onClick={() => prompts.remove(index)}>Remove prompt</button>
    </div>
  </div>
</details>
```

The content textarea registration is exactly `form.register(\`prompts.${index}.content\`)`. The two tri-state selects retain their existing Unset/True/False options.

Use `form.watch('prompts')` for live summary values while retaining field-array identities for ordering.

- [ ] **Step 4: Add expandable Prompt Order Group and Advanced JSON cards**

Render each group using the same native card pattern. Wrap the existing executable-settings textarea in:

```tsx
<details className="preset-card preset-advanced-settings" data-testid="advanced-settings">
  <summary className="preset-card-summary">Advanced executable settings JSON</summary>
  <div className="preset-card-body">
    <label>Executable settings JSON<textarea rows={12} {...form.register('executableSettings')} /></label>
  </div>
</details>
```

Do not set `open` on Advanced JSON.

- [ ] **Step 5: Add responsive card CSS**

Add card borders, hover/focus summary treatment, chevron rotation, full-width content, grid columns using `repeat(auto-fit, minmax(12rem, 1fr))`, and a single-column mobile override. Scope selectors under `.preset-editor` or `.preset-card` so Worldbook and other manager layouts are unchanged.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the focused Preset test command. Expected: every existing and new Preset test passes.

- [ ] **Step 7: Run web and type gates**

```powershell
npm test -- apps/web
npm run typecheck
git diff --check
```

Expected: zero failures and clean diff check.

- [ ] **Step 8: Verify visually in the running app**

Open `http://localhost:5173/presets`, verify multiple Prompt cards stay open, order-group cards expand independently, Advanced JSON starts closed, and inspect a narrow viewport for horizontal overflow.

- [ ] **Step 9: Commit**

```powershell
git add apps/web/src/features/presets/PresetManagerPage.test.tsx apps/web/src/features/presets/PresetEditor.tsx apps/web/src/styles.css
git commit -m "feat: add expandable Preset editor cards"
```
