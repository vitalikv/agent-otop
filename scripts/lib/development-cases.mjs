import assert from 'node:assert/strict';

export function validateDevelopmentCases(definition, fixtures, references, assessInput, fixtureValues, metricKeys) {
  assert.equal(fixtures.schema_version, 1);
  assert.equal(fixtures.independent_test_set, false);
  assert.equal(fixtures.professional_reviewed, false);
  assert.equal(fixtures.origin, 'explicit_synthetic_development_cases');
  assert(fixtures.notes.trim());
  assert.equal(new Set(fixtures.cases.map(item => item.id)).size, fixtures.cases.length, 'Duplicate development case');
  const covered = new Set();
  const conditionalCovered = new Set();
  const clarificationCovered = new Set();
  for (const item of fixtures.cases) {
    const view = item.reference_view ?? 'first_response';
    assert(['first_response', 'conditional_example'].includes(view), `${item.id}: unknown reference view`);
    if (view === 'conditional_example') assert(item.reference_id, `${item.id}: missing conditional reference`);
    else assert(!Object.hasOwn(item, 'reference_assumptions'), `${item.id}: assumptions require a conditional example`);
    const assessment = assessInput(definition, item.input);
    assert.equal(assessment.status, item.expected.status, item.id);
    assert.deepEqual(assessment.issues.toSorted(), (item.expected.issues ?? []).toSorted(), `${item.id}: issues`);
    let values;
    if (assessment.status === 'ready') {
      values = fixtureValues(item.input);
      assert(Object.keys(item.expected.values).length > 0, item.id);
      assert.deepEqual(Object.keys(values).sort(), Object.keys(definition.methods[item.input.method].outputs).sort(), item.id);
      for (const [key, expected] of Object.entries(item.expected.values)) {
        assert(Number.isFinite(expected), item.id);
        assert(Math.abs(values[key] - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${item.id}/${key}`);
      }
    } else assert(!item.expected.values, `${item.id}: result despite incomplete or invalid inputs`);
    if (!item.reference_id) continue;
    const reference = references.records.find(record => record.id === item.reference_id);
    assert(reference && definition.reference_answer_ids.includes(reference.id), item.id);
    assert(reference.intents.includes(definition.id), item.id);
    covered.add(reference.id);
    if (reference.dialog_fixture) {
      assert(['after', 'absent'].includes(item.dialog_state), `${item.id}: explicit dialog state required`);
      if (item.dialog_state === 'after') {
        for (const [key, value] of Object.entries(reference.dialog_fixture.after)) assert.equal(item.input[key], value, `${item.id}/${key}`);
      } else {
        assert.equal(reference.without_dialog_fixture.response_mode, 'clarify', item.id);
        assert.equal(assessment.status, 'clarify', item.id);
        continue;
      }
    }
    if (view === 'conditional_example') {
      assert.equal(reference.response_mode, 'clarify', `${item.id}: only an explicit conditional result in a clarification can use this view`);
      const assumptions = [...new Set(reference.numeric_expectations.flatMap(result => result.assumptions))];
      assert(assumptions.length > 0, `${item.id}: conditional result requires source assumptions`);
      assert.deepEqual(item.reference_assumptions, assumptions, `${item.id}: conditional assumptions differ from reference`);
      assert.equal(assessment.status, 'ready', item.id);
      conditionalCovered.add(reference.id);
    } else if (reference.response_mode === 'clarify') {
      assert.equal(assessment.status, 'clarify', item.id);
      clarificationCovered.add(reference.id);
      // Numbers in a clarification describe an explicitly conditional example,
      // not a result for its incomplete primary input.
      continue;
    }
    if (reference.response_mode === 'calculate') assert.equal(assessment.status, 'ready', item.id);
    let numericMatches = 0;
    for (const expected of reference.numeric_expectations) {
      const key = metricKeys[expected.metric];
      if (!key || values?.[key] === undefined) continue;
      assert.equal(definition.methods[item.input.method].outputs[key], expected.unit, `${item.id}: reference units differ`);
      assert(Math.abs(values[key] - expected.value) <= expected.absolute_tolerance, `${item.id}: differs from ${reference.id}`);
      numericMatches++;
    }
    if (reference.numeric_expectations.length) assert(numericMatches > 0, `${item.id}: reference arithmetic was not checked`);
  }
  assert.deepEqual([...covered].sort(), definition.reference_answer_ids.toSorted(), 'Missing reference coverage');
  for (const id of definition.reference_answer_ids) {
    const reference = references.records.find(record => record.id === id);
    if (reference.response_mode === 'clarify' && reference.numeric_expectations.length) {
      assert(clarificationCovered.has(id) && conditionalCovered.has(id), `${id}: both clarification and conditional example must be checked`);
    }
  }
}
