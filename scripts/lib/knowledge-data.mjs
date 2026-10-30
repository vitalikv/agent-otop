import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import * as flowContract from './flow-contract.mjs';
import * as geometryContract from './geometry-contract.mjs';
import * as pressureContract from './pressure-contract.mjs';
import * as expansionContract from './expansion-contract.mjs';

export const CALCULATOR_IDS = ['hydraulics.flow', 'pipe.size', 'hydraulics.velocity', 'hydraulics.diameter', 'hydraulics.loss', 'hydraulics.head', 'pipe.expansion'];
const numberStatuses = {
  'g05.flow': ['calculation_relationship', 'rounded_water_approximation', 'educational_example'],
  'g05.size': ['calculation_relationship', 'educational_example_for_specified_wall'],
  'g05.speed': ['calculation_relationship', 'project_guideline', 'educational_example_under_stated_conditions'],
  'g05.loss': ['calculation_relationship', 'exact_unit_conversion'],
  'g05.pump': ['calculation_relationship', 'approximate_gravity'],
  'g06.expand': ['calculation_relationship', 'passport_requirement']
};

const normalize = text => text.replace(/\r\n/g, '\n');
export const sha256 = text => crypto.createHash('sha256').update(normalize(text), 'utf8').digest('hex');
const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

export function prepareKnowledge(root, calculatorId = 'hydraulics.flow') {
  assert(CALCULATOR_IDS.includes(calculatorId), 'Unknown calculator');
  const read = relative => {
    const file = path.resolve(root, relative);
    assert(within(root, file) && within(fs.realpathSync(root), fs.realpathSync(file)), `Source escapes project: ${relative}`);
    return normalize(fs.readFileSync(file, 'utf8'));
  };
  const readJSON = relative => JSON.parse(read(relative));
  const manifestPath = 'docs/reference-sources.json';
  const upstreamPath = 'docs/knowledge/installation-guide.upstream.json';
  const definitionPath = `data/definitions/${calculatorId}.json`;
  const fixturesPath = `data/fixtures/${calculatorId}.json`;
  const referencesPath = 'docs/reference-answers.json';
  const manifest = readJSON(manifestPath);
  const upstream = readJSON(upstreamPath);
  assert.equal(manifest.storage, 'local_snapshot');
  assert.equal(manifest.base_commit, upstream.upstream.commit);
  assert.equal(manifest.base_repository, upstream.upstream.repository);
  assert.equal(manifest.base_worktree_dirty, false);
  assert.equal(upstream.upstream.worktree_dirty, false);
  assert.equal(manifest.base_directory_relative_to_docs, upstream.local_directory);
  const baseDirectory = 'docs/' + upstream.local_directory;
  const files = fs.readdirSync(path.resolve(root, baseDirectory)).filter(file => file.endsWith('.md')).sort();
  assert.equal(upstream.files.length, 10);
  assert.deepEqual(files, upstream.files.map(file => file.file).sort(), 'Snapshot inventory changed');
  for (const file of upstream.files) {
    assert.equal(file.file, path.basename(file.file));
    assert.equal(sha256(read(baseDirectory + '/' + file.file)), file.local_sha256_lf, `${file.file}: source changed; review before updating hashes`);
  }
  const definition = readJSON(definitionPath);
  const fixtures = readJSON(fixturesPath);
  const references = readJSON(referencesPath);
  assert.equal(definition.id, calculatorId, 'Definition id differs from filename');
  const contract = calculatorId === 'hydraulics.flow' ? flowContract
    : calculatorId === 'pipe.expansion' ? expansionContract
    : ['hydraulics.loss', 'hydraulics.head'].includes(calculatorId) ? pressureContract : geometryContract;
  contract.validateDefinition(definition);
  contract.validateCases(definition, fixtures, references);
  const chunks = definition.source_ids.map(id => {
    const source = manifest.sources[id];
    assert(source && source.kind === 'engineering_base', `Missing source ${id}`);
    assert(source.file.startsWith(upstream.local_directory + '/'), id);
    const content = read('docs/' + source.file);
    assert.equal(sha256(content), source.sha256_lf, `${id}: file changed`);
    const lines = content.split('\n');
    const headingIndex = lines.indexOf('## ' + source.heading);
    assert(headingIndex >= 0, `${id}: heading missing`);
    const nextHeading = lines.findIndex((line, index) => index > headingIndex && /^#{1,2} /.test(line));
    const end = nextHeading < 0 ? lines.length : nextHeading;
    assert.equal(source.line_start, headingIndex + 1, `${id}: section start`);
    assert.equal(source.line_end, end, `${id}: section end`);
    const text = lines.slice(headingIndex, end).join('\n');
    assert.equal(sha256(text), source.section_sha256_lf, `${id}: section changed`);
    return {
      id, chapter: lines[0].replace(/^# /, ''), section: source.heading,
      file: 'docs/' + source.file, href: 'docs/' + source.href,
      line_start: source.line_start, line_end: source.line_end,
      sha256_lf: source.section_sha256_lf,
      number_statuses: numberStatuses[id],
      text
    };
  });
  const referenceAnswers = definition.reference_answer_ids.map(id => {
    const record = references.records.find(item => item.id === id);
    assert(record && record.source_ids.some(sourceId => definition.source_ids.includes(sourceId)), `${id}: missing calculator source`);
    return record;
  });
  // Reference answers may cite additional policies or material restrictions.
  // Keep their source descriptors, without presenting them as prepared chunks.
  const referenceSources = Object.fromEntries([...new Set(referenceAnswers.flatMap(record => record.source_ids))].map(id => {
    const source = manifest.sources[id];
    assert(source, `${id}: missing reference source`);
    const text = read('docs/' + source.file);
    assert.equal(sha256(text), source.sha256_lf, `${id}: linked reference source changed`);
    const section = text.split('\n').slice(source.line_start - 1, source.line_end).join('\n');
    assert.equal(sha256(section), source.section_sha256_lf, `${id}: linked reference section changed`);
    return [id, {...source, file: 'docs/' + source.file, href: 'docs/' + source.href}];
  }));
  const inputPaths = [manifestPath, upstreamPath, definitionPath, fixturesPath, referencesPath];
  return {
    schema_version: 1,
    scope: `${calculatorId}_only`,
    professional_reviewed: false,
    independent_test_set: false,
    provenance: {
      upstream: upstream.upstream,
      hash_normalization: upstream.text_normalization,
      inputs: inputPaths.map(file => ({file, sha256_lf: sha256(read(file))})),
      snapshot_files: upstream.files.map(file => ({file: baseDirectory + '/' + file.file, sha256_lf: file.local_sha256_lf}))
    },
    chunks,
    calculators: [definition],
    development_cases: fixtures,
    reference_answers: referenceAnswers,
    reference_sources: referenceSources
  };
}
