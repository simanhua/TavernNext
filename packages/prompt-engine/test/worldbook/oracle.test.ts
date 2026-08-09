import { describe, expect, it } from 'vitest';
import { evaluateWorldbooks, type WorldbookEvaluationResult } from '../../src/index.js';
import { evaluationInput, runtimeBook, worldbookEntry } from './fixtures.js';
import {
  loadSillyTavern118WorldbookOracle,
  ORACLE_ACTIVE_MULTI_GROUP_FIXTURE,
  ORACLE_BUDGET_ACCUMULATOR_FIXTURE,
  ORACLE_BUDGET_FIXTURE,
  ORACLE_GROUP_ORDER_FIXTURE,
  ORACLE_MATCH_FIXTURE,
  ORACLE_TIMED_FIXTURE,
  type OracleEntryFixture,
  type OracleProjection,
} from './st-1.18-worldbook-oracle-harness.js';

const oracleRoot = process.env.TAVERNNEXT_ST_ORACLE_ROOT;

function bookFrom(fixtures: readonly OracleEntryFixture[]) {
  return runtimeBook('oracle', fixtures.map((fixture, index) => worldbookEntry(fixture.uid, {
    sourceOrdinal: index,
    keys: fixture.keys ?? [],
    content: fixture.content,
    order: fixture.order,
    constant: fixture.constant ?? false,
    enabled: fixture.enabled ?? true,
    group: fixture.group ?? '',
    groupWeight: fixture.groupWeight ?? 100,
    groupOverride: fixture.groupOverride ?? false,
    ignoreBudget: fixture.ignoreBudget ?? false,
    useProbability: fixture.useProbability ?? false,
    probability: fixture.probability ?? 100,
    triggers: fixture.triggers ?? [],
    sticky: fixture.sticky ?? null,
    cooldown: fixture.cooldown ?? null,
    preventRecursion: fixture.preventRecursion ?? false,
    characterFilter: fixture.characterFilter ?? { isExclude: false, names: [], tags: [] },
  })));
}

function activationProjection(result: WorldbookEvaluationResult) {
  return {
    activated: result.activated.map((entry) => ({
      uid: String(entry.sourceUid), content: entry.content, order: entry.order,
    })),
    excluded: result.excluded.map((entry) => ({ uid: String(entry.sourceUid), reason: entry.reason })),
  };
}

function budgetProjection(budget: number) {
  const tokenizerInputs: string[] = [];
  const result = evaluateWorldbooks(evaluationInput([bookFrom(ORACLE_BUDGET_FIXTURE)], {
    tokenBudget: budget,
    tokenizer: { countText: (text) => {
      tokenizerInputs.push(text);
      return text.length;
    } },
  }));
  return {
    activated: result.activated.map((entry) => String(entry.sourceUid)),
    excluded: result.excluded.filter((entry) => entry.reason === 'budget').map((entry) => String(entry.sourceUid)),
    tokenizerInputs,
    tokenUsage: result.tokenUsage,
  };
}

function rejectedThenIgnoredBudgetProjection() {
  const tokenizerInputs: string[] = [];
  const result = evaluateWorldbooks(evaluationInput([bookFrom(ORACLE_BUDGET_ACCUMULATOR_FIXTURE)], {
    tokenBudget: 2,
    tokenizer: { countText: (text) => {
      tokenizerInputs.push(text);
      if (text.includes('B')) throw new Error('ignoreBudget content reached the tokenizer');
      return text.length;
    } },
  }));
  return {
    activated: result.activated.map((entry) => String(entry.sourceUid)),
    excluded: result.excluded.filter((entry) => entry.reason === 'budget').map((entry) => String(entry.sourceUid)),
    tokenizerInputs,
    tokenUsage: result.tokenUsage,
  };
}

function projection(result: WorldbookEvaluationResult): OracleProjection {
  const uidByKey = new Map<string, string>();
  for (const entry of result.activated) uidByKey.set(entry.entryKey, String(entry.sourceUid));
  for (const entry of result.excluded) uidByKey.set(entry.entryKey, String(entry.sourceUid));
  const effects = (values: typeof result.timedState.sticky) => values.map((effect) => ({
    uid: uidByKey.get(effect.entryKey) ?? effect.entryKey,
    start: effect.start,
    end: effect.end,
    protected: effect.protected,
  }));
  return {
    activated: result.activated.map((entry) => ({
      uid: String(entry.sourceUid), content: entry.content, order: entry.order,
    })),
    excluded: result.excluded.map((entry) => ({ uid: String(entry.sourceUid), reason: entry.reason })),
    timedState: { sticky: effects(result.timedState.sticky), cooldown: effects(result.timedState.cooldown) },
    tokens: { used: result.tokenUsage.used },
  };
}

describe.runIf(oracleRoot !== undefined)('read-only SillyTavern 1.18.0 Worldbook runtime oracle', () => {
  it('matches complete activation, exclusion, order, timed state, and token projections', async () => {
    const oracle = await loadSillyTavern118WorldbookOracle(oracleRoot!);
    expect(oracle.provenance).toMatchObject({
      packageName: 'sillytavern',
      version: '1.18.0',
      revision: '8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8',
      revisionVerifiedBy: 'git rev-parse HEAD',
      execution: 'read-only hash-pinned upstream WorldInfoBuffer, WorldInfoTimedEffects, grouping, and checkWorldInfo',
      declarations: [
        'parseRegexFromString', 'WorldInfoBuffer', 'WorldInfoTimedEffects',
        'filterGroupsByScoring', 'filterGroupsByTimedEffects', 'filterByInclusionGroups', 'checkWorldInfo',
      ],
    });

    const matching = evaluateWorldbooks(evaluationInput([bookFrom(ORACLE_MATCH_FIXTURE)], {
      seed: 4,
      messageIndex: 4,
      scanSources: {
        messages: ['alpha', 'pad-1', 'pad-2', 'pad-3'], additional: [], trigger: 'normal',
        character: {
          name: 'Aster.png', tags: [], description: '', personality: '', depthPrompt: '', scenario: '', creatorNotes: '',
        },
      },
      tokenBudget: 64,
    }));
    expect(projection(matching)).toEqual(oracle.matching);

    const timedBook = bookFrom(ORACLE_TIMED_FIXTURE);
    const started = evaluateWorldbooks(evaluationInput([timedBook], { seed: 1, messageIndex: 10, tokenBudget: 64 }));
    const held = evaluateWorldbooks(evaluationInput([timedBook], {
      seed: 1, messageIndex: 11, previousTimedState: started.timedState, tokenBudget: 64,
    }));
    const cooling = evaluateWorldbooks(evaluationInput([timedBook], {
      seed: 1, messageIndex: 12, previousTimedState: held.timedState, tokenBudget: 64,
    }));
    expect(projection(started)).toEqual(oracle.timed.started);
    expect(projection(held)).toEqual(oracle.timed.held);
    expect(projection(cooling)).toEqual(oracle.timed.cooling);

    const groupOrder = evaluateWorldbooks(evaluationInput([bookFrom(ORACLE_GROUP_ORDER_FIXTURE)], {
      seed: 1,
      tokenBudget: 64,
    }));
    expect(projection(groupOrder)).toEqual(oracle.groups.firstOccurrence);

    const activeMultiGroup = evaluateWorldbooks(evaluationInput([
      runtimeBook('oracle', bookFrom(ORACLE_ACTIVE_MULTI_GROUP_FIXTURE).book.entries, { recursiveScanning: true }),
    ], {
      seed: 1,
      scanSources: { messages: ['alpha'], additional: [], trigger: 'normal' },
      tokenBudget: 64,
    }));
    expect(activationProjection(activeMultiGroup)).toEqual({
      activated: oracle.groups.activeMultiGroup.activated,
      excluded: oracle.groups.activeMultiGroup.excluded,
    });

    expect(budgetProjection(4)).toEqual(oracle.budget.fits);
    expect(budgetProjection(3)).toEqual(oracle.budget.boundary);
    expect(rejectedThenIgnoredBudgetProjection()).toEqual(oracle.budget.rejectedThenIgnored);
  });
});
