# Scene gameplay settlement

A Scene Workspace submits a player-confirmed gameplay command through `sdk.scene.action`. Its trusted server `handleAction` validates the command, computes the costs and outcome, and returns an accepted Player Operation with a state patch. TavernNext commits that patch and the operation history in one transaction. The next Agent Run receives the updated Scene State and the committed operation in chronological chat history.

For example, a Scene can settle an alchemy attempt after validating the recipe and choosing its outcome:

```js
// Scene Workspace: the outcome does not need to be known before submitting.
const settlement = await sdk.scene.action({ type: 'brew', recipeId: 'restoration' });
// Display the animation and rewards from settlement.result after success.
```

```js
// Return from the Scene server's handleAction after computing this outcome.
return {
  accepted: true,
  statePatch: [
    { op: 'delta', path: '/inventory/herbs', value: -3 },
    { op: 'delta', path: '/player/mana', value: -20 },
    { op: 'delta', path: '/inventory/superiorRestorationPills', value: 2 },
  ],
  operation: {
    kind: 'alchemy',
    title: '炼丹结算',
    summary: '消耗灵草×3、灵力20，炼成上品回春丹×2。',
  },
  result: { recipeId: 'restoration', quality: 'superior', quantity: 2 },
};
```

The example assumes these numeric state paths already exist. Recipe validation, material sufficiency, random selection, and any repeated-request handling belong to the Scene's rules. A rejected command returns `accepted: false` and may include an explanatory `result`, but cannot return a state patch or operation.

The server `operation` must contain exactly `kind`, `title`, and `summary`. `kind` is an identifier of up to 64 characters matching `[a-z0-9][a-z0-9._-]*`; `title` is 1–80 characters and `summary` is 1–500 characters. It requires `accepted: true`. An invalid server operation fails the request before writing state or history; an invalid patch or a state revision conflict rolls back the complete settlement.

If both the server and the frontend provide an operation, the server's complete operation is authoritative. Existing calls using `sdk.scene.action(command, { operation })` continue to record their frontend operation when the accepted server response omits one. An accepted operation without a patch still records an event and an empty state transition. A response without either operation keeps the existing state-only/result-only behavior.

Only Scene State and the operation history are persisted by this path; arbitrary `result` fields are returned to the workspace and are not automatically included in chat. Put durable items, balances, and summoned characters in Scene State, and describe what happened in the operation summary. Settlement does not automatically start an Agent Run or a memory extraction job. Older chat history remains subject to the prompt token budget.
