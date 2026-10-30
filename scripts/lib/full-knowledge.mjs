import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {CALCULATOR_IDS, prepareKnowledge, sha256} from './knowledge-data.mjs';

export function formulaValue(id, input) {
  const operations = {
    'hydraulics.reynolds': p => p.density_kg_m3 * p.velocity_m_s * p.inner_m / p.viscosity_pa_s,
    'hydraulics.laminar_friction': p => 64 / p.reynolds,
    'hydraulics.darcy_loss': p => p.darcy_lambda * (p.length_m / p.inner_m) * p.density_kg_m3 * p.velocity_m_s ** 2 / 2,
    'hydraulics.local_zeta_loss': p => p.zeta_sum * p.density_kg_m3 * p.velocity_m_s ** 2 / 2,
    'hydraulics.required_water_kv': p => p.flow_m3_h / Math.sqrt(p.pressure_bar)
  };
  assert(Object.hasOwn(operations, id), `Unknown supplementary formula ${id}`);
  const value = operations[id](input);
  assert(Number.isFinite(value), `${id}: non-finite result`);
  return value;
}

export function validateFormulaCatalog(catalog, sourceIds) {
  assert.equal(catalog.schema_version, 1);
  assert.equal(catalog.status, 'source_aligned_not_professionally_reviewed');
  assert.equal(catalog.common_validation.unknown_fields, 'reject');
  assert.equal(new Set(catalog.formulas.map(record => record.id)).size, catalog.formulas.length);
  for (const record of catalog.formulas) {
    assert(sourceIds.has(record.source_id), record.id);
    assert(record.formula && record.output.unit && record.applicability.length && record.missing_data_action, record.id);
    assert(record.result_status, record.id);
    assert.deepEqual(record.required.toSorted(), Object.keys(record.inputs).sort(), record.id);
    const example = record.development_example;
    assert.equal(example.origin, 'synthetic_not_product_data');
    assert.deepEqual(Object.keys(example.inputs).sort(), Object.keys(record.inputs).sort(), record.id);
    for (const [name, parameter] of Object.entries(record.inputs)) {
      const value = example.inputs[name];
      assert(!Object.hasOwn(parameter, 'default'), name);
      if (parameter.type === 'number') {
        assert(parameter.unit && typeof value === 'number' && Number.isFinite(value), name);
        if (parameter.minimum !== undefined) assert(value >= parameter.minimum, name);
        if (parameter.exclusive_minimum !== undefined) assert(value > parameter.exclusive_minimum, name);
      } else if (parameter.type === 'enum') assert(parameter.values.includes(value), name);
      else assert(parameter.type === 'string' && typeof value === 'string' && value.trim(), name);
    }
    assert(Math.abs(formulaValue(record.id, example.inputs) - example.expected) < 1e-9 * Math.max(1, Math.abs(example.expected)), record.id);
  }
}

const slug = value => value.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

export function prepareFullKnowledge(root, bundles = CALCULATOR_IDS.map(id => prepareKnowledge(root, id))) {
  assert.deepEqual(bundles.map(bundle => bundle.calculators[0].id), CALCULATOR_IDS);
  const inputFiles = new Map();
  const read = relative => {
    const file = path.resolve(root, relative);
    assert(inside(root, file) && inside(fs.realpathSync(root), fs.realpathSync(file)), `Source escapes project: ${relative}`);
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    inputFiles.set(relative, sha256(text));
    return text;
  };
  const json = relative => JSON.parse(read(relative));
  const upstream = json('docs/knowledge/installation-guide.upstream.json');
  const manifest = json('docs/reference-sources.json');
  const settings = json('data/definitions/knowledge-sections.json');
  const rules = json('data/definitions/engineering-rules.json');
  const explanations = json('data/definitions/intent-explanations.json');
  const terminology = json('data/definitions/terminology.json');
  const formulas = json('data/definitions/formula-catalog.json');
  const references = json('docs/reference-answers.json');
  const annotations = json('docs/question-annotations.json');
  assert.equal(settings.schema_version, 1);
  assert.equal(settings.status, 'source_aligned_not_professionally_reviewed');
  assert.equal(settings.sections.length, new Set(settings.sections.map(section => section.id)).size);
  const chunks = [];
  for (const snapshot of upstream.files) {
    const file = 'docs/' + upstream.local_directory + '/' + snapshot.file;
    const text = read(file);
    assert.equal(sha256(text), snapshot.local_sha256_lf, `${file}: snapshot changed`);
    if (!/^0[1-8]-/.test(snapshot.file)) continue;
    const lines = text.split('\n');
    const starts = [0, ...lines.flatMap((line, index) => /^## /.test(line) ? [index] : [])];
    const metadata = settings.sections.filter(section => section.file === file);
    assert.equal(metadata.length, starts.length, `${file}: section inventory changed`);
    starts.forEach((start, index) => {
      const end = starts[index + 1] ?? lines.length;
      const heading = lines[start].replace(/^#{1,2} /, '');
      const section = metadata[index];
      assert.equal(section.heading, heading, `${file}: section order or heading changed`);
      assert(section.number_statuses.length > 0 && section.note, section.id);
      const canonical = lines.slice(start, end).join('\n');
      const body = canonical + (end < lines.length ? '\n' : '');
      const source = manifest.sources[section.id];
      if (source) {
        assert.equal('docs/' + source.file, file, section.id);
        assert.equal(source.line_start, start + 1, section.id);
        assert.equal(source.line_end, end, section.id);
        assert.equal(source.section_sha256_lf, sha256(canonical), section.id);
      }
      chunks.push({...section, chapter: lines[0].replace(/^# /, ''), href: file + '#' + slug(heading), line_start: start + 1, line_end: end, file_sha256_lf: snapshot.local_sha256_lf, sha256_lf: sha256(body), text: body});
    });
  }
  assert.equal(chunks.length, settings.sections.length, 'Unresolved section metadata');
  const supportingSources = Object.fromEntries(Object.entries(manifest.sources).map(([id, source]) => {
    const text = read('docs/' + source.file);
    assert.equal(sha256(text), source.sha256_lf, `${id}: supporting source changed`);
    const section = text.split('\n').slice(source.line_start - 1, source.line_end).join('\n');
    assert.equal(sha256(section), source.section_sha256_lf, `${id}: supporting section changed`);
    return [id, {...source, file: 'docs/' + source.file, href: 'docs/' + source.href, text: section}];
  }));
  const catalog = terminology.catalog_origin;
  assert.equal(catalog.original_file_available, false);
  const catalogEvidence = read(catalog.evidence_file);
  assert(catalogEvidence.includes(catalog.evidence_quote), 'Catalog vocabulary evidence changed');
  supportingSources['project.catalog-vocabulary'] = {file: catalog.evidence_file, heading: catalog.evidence_heading, sha256_lf: sha256(catalogEvidence), text: catalog.evidence_quote, kind: 'local_mention_not_original_catalog'};
  const sourceIds = new Set([...chunks.map(chunk => chunk.id), ...Object.keys(supportingSources)]);

  assert.equal(rules.schema_version, 1);
  assert.equal(rules.unknown_evidence, 'unknown_is_not_passed');
  const ruleRows = supportingSources['g08.rules'].text.split('\n').filter(line => /^\| \p{L}-\d{2} \|/u.test(line)).map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
  assert.deepEqual(rules.rules.map(rule => [rule.code, rule.condition, rule.on_failure]), ruleRows, 'Rules must preserve every source condition and failure action');
  assert.equal(new Set(rules.rules.map(rule => rule.code)).size, rules.rules.length);
  for (const rule of rules.rules) assert(rule.source_id === 'g08.rules' && rule.evaluation === 'requires_explicit_evidence_not_keyword_match', rule.code);

  assert.equal(explanations.schema_version, 1);
  assert.equal(explanations.training_classes_approved, false);
  const intentRows = read('docs/question-intents.md').split('\n').filter(line => /^\| `[^`]+\.[^`]+` \|/.test(line)).map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
  assert.deepEqual(explanations.records.map(record => [record.id, record.title, record.required_data_for_concrete_decision, record.boundary]), intentRows.map(([id, ...rest]) => [id.slice(1, -1), ...rest]), 'Intent catalog coverage or formal context changed');
  assert.equal(new Set(explanations.records.map(record => record.id)).size, explanations.records.length);
  for (const record of explanations.records) {
    assert(record.explanation.length > 40 && record.professional_reviewed === false, record.id);
    assert(record.source_ids.length > 0 && record.source_ids.every(id => sourceIds.has(id)), record.id);
    assert.deepEqual(record.reference_answer_ids, references.records.filter(reference => reference.intents.includes(record.id)).map(reference => reference.id), `${record.id}: reference coverage`);
  }
  assert.equal(terminology.schema_version, 1);
  const termIds = new Set(terminology.records.map(record => record.id));
  assert.equal(termIds.size, terminology.records.length);
  for (const record of terminology.records) {
    assert(record.aliases.length && record.note && record.normalization, record.id);
    assert(record.source_ids.length && record.source_ids.every(id => sourceIds.has(id)), record.id);
  }
  for (const ambiguous of terminology.ambiguous_terms) assert(ambiguous.candidates.every(id => termIds.has(id)) && ambiguous.action, ambiguous.alias);
  validateFormulaCatalog(formulas, sourceIds);
  assert.deepEqual(references.records.map(record => record.id), annotations.records.map(record => record.id));
  for (const record of references.records) {
    assert(record.source_ids.every(id => sourceIds.has(id)), record.id);
    assert(record.intents.every(id => explanations.records.some(intent => intent.id === id)), record.id);
  }
  for (const bundle of bundles) {
    for (const input of bundle.provenance.inputs) {
      assert.equal(sha256(read(input.file)), input.sha256_lf, `${input.file}: calculator provenance changed`);
    }
  }
  return {
    schema_version: 1, scope: 'stage_3_first_scenario', professional_reviewed: false, independent_test_set: false,
    provenance: {upstream: upstream.upstream, hash_normalization: upstream.text_normalization, inputs: [...inputFiles].sort(([a], [b]) => a.localeCompare(b)).map(([file, hash]) => ({file, sha256_lf: hash}))},
    chapters: upstream.files.filter(file => /^0[1-8]-/.test(file.file)).map(file => ({file: 'docs/' + upstream.local_directory + '/' + file.file, sha256_lf: file.local_sha256_lf})),
    chunks, supporting_sources: supportingSources,
    engineering_rules: rules, terminology, intent_explanations: explanations,
    calculators: bundles.map(bundle => bundle.calculators[0]), supplementary_formulas: formulas,
    development_cases: bundles.map(bundle => ({calculator_id: bundle.calculators[0].id, ...bundle.development_cases})),
    reference_answers: references.records
  };
}
