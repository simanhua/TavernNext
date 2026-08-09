# Expandable Preset Editor Design

## Goal

Replace the horizontally compressed Chat Preset editor with readable, vertically stacked expandable cards. Users may keep multiple cards open at once, and existing Preset data and save behavior must remain unchanged.

## Layout

- Keep the Preset sidebar and top-level Name, Family, and Temperature fields.
- Render every Chat prompt as a full-width native `details` card.
- The card summary shows the prompt number, display name or identifier, role, and enabled state.
- The first prompt is open initially. Every card can be opened or closed independently.
- Inside an open card:
  - identifier, name, role, and enabled state form the basic responsive grid;
  - content spans the full card width;
  - system, marker, injection, override, and trigger fields form an advanced responsive grid;
  - move and remove actions appear in a footer.
- Render Prompt Order Groups as the same style of expandable cards. Their summaries show character ID and item count.
- Render Executable Settings JSON inside a separate expandable section that is closed initially.
- Keep Add Prompt, Add Prompt Order Group, Save, Export, and Delete actions visible outside individual cards.

## Responsive behavior

- Cards use CSS grid with `minmax()` columns and wrap before controls become narrow.
- Content textareas occupy the full available width.
- At narrow widths, every grid becomes a single column.
- No editor section may require horizontal page scrolling.

## Accessibility

- Use native `details` and `summary` elements so multiple sections can remain open without custom accordion state.
- Preserve all existing form labels and accessible button names.
- Give each expandable card a concise visible summary and retain keyboard focus styles.
- Disabled move actions remain visibly and semantically disabled.

## Data and error handling

- Do not change the form schema, API payload, conflict handling, validation, or import/export behavior.
- Reordering continues to use stable field-array identities.
- Validation summaries remain outside collapsed cards so errors are announced even when the relevant card is closed.

## Verification

- Add a UI regression proving multiple prompt cards can be open simultaneously.
- Assert prompt summaries expose identifier/name, role, and enabled status.
- Assert prompt and order-group fields remain editable after expansion.
- Assert Advanced JSON is collapsed initially and can be expanded.
- Run the focused Preset manager tests, full web tests, typecheck, and browser visual verification at desktop and narrow viewport widths.
