import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {CALCULATOR_IDS, prepareKnowledge} from './lib/knowledge-data.mjs';
import {prepareFullKnowledge} from './lib/full-knowledge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 1 && args[0] === '--check'), 'Usage: node scripts/prepare-knowledge.mjs [--check]');
// Validate every calculator before writing any output.
const artifacts = CALCULATOR_IDS.map(id => {
  const bundle = prepareKnowledge(root, id);
  return {id, bundle, output: path.join(root, `data/generated/${id}.json`), content: JSON.stringify(bundle, null, 2) + '\n'};
});
const knowledge = prepareFullKnowledge(root, artifacts.map(artifact => artifact.bundle));
artifacts.push({id: 'knowledge', bundle: knowledge, output: path.join(root, 'data/generated/knowledge.json'), content: JSON.stringify(knowledge, null, 2) + '\n'});
if (args[0] === '--check') {
  for (const {id, output, content} of artifacts) {
    assert(fs.existsSync(output), `${id}: prepared data missing. Run npm run data:prepare`);
    assert.equal(fs.readFileSync(output, 'utf8').replace(/\r\n/g, '\n'), content, `${id}: prepared data stale. Review changes and run npm run data:prepare`);
  }
  console.log(`Prepared data is current: ${CALCULATOR_IDS.length} calculators and the complete knowledge bundle.`);
} else {
  for (const {id, bundle, output, content} of artifacts) {
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.writeFileSync(output, content, 'utf8');
    console.log(`Prepared data/generated/${id}.json: ${bundle.chunks.length} complete fragments, ${id === 'knowledge' ? bundle.development_cases.reduce((sum, item) => sum + item.cases.length, 0) : bundle.development_cases.cases.length} development cases, ${bundle.reference_answers.length} reference answers.`);
  }
}
