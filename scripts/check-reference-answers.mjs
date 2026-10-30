import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const docs=path.join(root,'docs');
const read=name=>JSON.parse(fs.readFileSync(path.join(docs,name),'utf8'));
const data=read('reference-answers.json');
const manifest=read(data.source_manifest);
const annotations=read(data.question_annotations);
const normalize=text=>text.replace(/\r\n/g,'\n');
const hash=text=>crypto.createHash('sha256').update(normalize(text),'utf8').digest('hex');
const slug=text=>text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu,'').trim().replace(/\s/g,'-');
const inside=(parent,target)=>{
 const relative=path.relative(parent,target);
 return relative!== '..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);
};
const localPath=relative=>{
 const full=path.resolve(docs,relative);
 assert(inside(root,full),`Local reference escapes project: ${relative}`);
 assert(inside(fs.realpathSync(root),fs.realpathSync(full)),`Local reference resolves outside project: ${relative}`);
 return full;
};
const coverageLabels={supported:'Ответ по базе',clarification:'Уточнение перед решением',limited_diagnostic:'Сбор признаков; причина не установлена',boundary:'Граница данных или функции',safety_external:'Первичная реакция; отдельное дополнение'};

assert.equal(manifest.storage,'local_snapshot','Engineering base must be stored in this project');
const upstream=read(manifest.upstream_manifest);
const localBase=localPath(manifest.base_directory_relative_to_docs);
assert.equal(upstream.local_directory,manifest.base_directory_relative_to_docs);
assert.equal(upstream.upstream.repository,manifest.base_repository);
assert.equal(upstream.upstream.commit,manifest.base_commit);
assert.equal(upstream.upstream.worktree_dirty,manifest.base_worktree_dirty);
assert.equal(upstream.files.length,10,'Expected 8 chapters, README and sources');
assert.equal(new Set(upstream.files.map(file=>file.file)).size,10,'Duplicate snapshot file');
const snapshotFiles=fs.readdirSync(localBase).filter(file=>file.endsWith('.md')).sort();
assert.deepEqual(snapshotFiles,upstream.files.map(file=>file.file).sort(),'Snapshot inventory changed');
for(const file of upstream.files){
 assert.equal(file.file,path.basename(file.file),'Invalid snapshot filename');
 const content=fs.readFileSync(path.join(localBase,file.file),'utf8');
 assert.equal(hash(content),file.local_sha256_lf,`${file.file}: local base changed; review provenance and affected answers`);
 assert(/^[a-f0-9]{64}$/.test(file.upstream_sha256_lf),`${file.file}: missing original hash`);
 if(file.adaptations.length===0)assert.equal(file.local_sha256_lf,file.upstream_sha256_lf,`${file.file}: undocumented adaptation`);
}

assert.equal(data.records.length,160,'Expected 160 reference responses');
assert.equal(annotations.records.length,160,'Question annotations changed');
assert.equal(data.professional_reviewed,false,'Professional review cannot be inferred from this script');
assert.equal(new Set(data.records.map(r=>r.id)).size,160,'Duplicate ids');
const usedSources=new Set();
const byId=new Map();
for(let index=0;index<data.records.length;index++){
 const record=data.records[index];
 const original=annotations.records[index];
 assert.equal(record.id,`SYN-${String(index+1).padStart(3,'0')}`);
 assert.equal(record.id,original.id);
 assert.equal(original.reference_answer_id,record.id,`${record.id}: annotation reference`);
 assert.equal(record.question,original.question,`${record.id}: question changed`);
 assert.equal(record.question_context,original.context,`${record.id}: context changed`);
 assert.deepEqual(record.intents,original.intents,`${record.id}: intentions changed`);
 assert(coverageLabels[record.coverage],`${record.id}: coverage`);
 assert(record.answer.trim().length>30,`${record.id}: missing response`);
 assert(record.source_ids.length>0,`${record.id}: missing sources`);
 assert(record.acceptance_criteria.length>=3,`${record.id}: missing criteria`);
 assert.equal(record.verification.professional_reviewed,false);
 for(const id of record.source_ids){assert(manifest.sources[id],`${record.id}: missing source ${id}`);usedSources.add(id);}
 for(const result of record.numeric_expectations){
  assert(Number.isFinite(result.value));assert(result.absolute_tolerance>=0);assert(result.formula);assert(result.unit);
 }
 if(record.dialog_fixture){assert.equal(record.dialog_fixture.origin,'explicit_synthetic_dialog_state');assert(record.dialog_fixture.notes);assert(record.without_dialog_fixture?.answer);assert.equal(record.without_dialog_fixture.response_mode,'clarify');}
 if(index>=150){assert.equal(record.response_mode,'safety');assert.equal(record.coverage,'safety_external');}
 byId.set(record.id,record);
}

for(const [id,source] of Object.entries(manifest.sources)){
 const full=localPath(source.file);
 if(source.kind==='engineering_base')assert(inside(localBase,full),`${id}: engineering source outside local base`);
 const content=normalize(fs.readFileSync(full,'utf8'));
 assert.equal(hash(content),source.sha256_lf,`${id}: source changed: ${source.file}; recheck answers before refreshing hashes`);
 const lines=content.split('\n');
 assert.equal(lines[source.line_start-1].replace(/^#{1,6} /,''),source.heading,`${id}: heading`);
 const level=lines[source.line_start-1].match(/^#+/)[0].length;
 const next=lines.findIndex((line,i)=>i>=source.line_start&&new RegExp(`^#{1,${level}} `).test(line));
 assert.equal(source.line_end,next<0?lines.length:next,`${id}: section bounds`);
 assert.equal(hash(lines.slice(source.line_start-1,source.line_end).join('\n')),source.section_sha256_lf,`${id}: section content`);
 assert.equal(source.href,source.file+'#'+slug(source.heading),`${id}: link`);
}
assert.equal(manifest.base_worktree_dirty,false,'Reference revision was not clean');
assert(/^[a-f0-9]{40}$/.test(manifest.base_commit),'Missing base revision');
for(const external of manifest.external_sources){
 assert.equal(new URL(external.url).protocol,'https:');
 const host=new URL(external.url).hostname;
 assert(host==='mchs.gov.ru'||host.endsWith('.mchs.gov.ru')||host==='valtec.ru');
 assert(external.checked_on);assert(external.supports.length);
}

// Independent arithmetic checks: SI area/flow relations, energy balance and ratios.
// No evaluation of formula strings from the dataset is performed.
const area=d=>Math.PI*(d/2)**2;
const speed=(litersPerHour,diameterMeters)=>(litersPerHour/1000/3600)/area(diameterMeters);
const expect=(id,metric,actual)=>{
 const result=byId.get(id).numeric_expectations.find(v=>v.metric===metric);
 assert(result,`${id}: missing metric ${metric}`);
 assert(Math.abs(result.value-actual)<=result.absolute_tolerance,`${id}/${metric}: expected ${actual}, got ${result.value}`);
};
expect('SYN-024','nominal_temperature_head',(75+65)/2-20);
expect('SYN-024','target_temperature_head',(55+45)/2-22);
expect('SYN-055','inner_diameter',20-2*2.8);
expect('SYN-057','flow',0.86*5/10*1000);
expect('SYN-057','velocity',speed(430,0.012));
expect('SYN-061','flow',0.86*8/(60-40)*1000);
expect('SYN-062','flow',0.3*1000/60);
expect('SYN-063','velocity',speed(100,0.012));
expect('SYN-064','inner_diameter',2*Math.sqrt((400/1000/3600)/0.5/Math.PI)*1000);
expect('SYN-066','pressure_loss',100*(0.2/0.5)**2);
expect('SYN-068','head',15000/1000/9.81);
expect('SYN-069','flow_ratio',20/10);
expect('SYN-088','expansion_coefficient_multiplier',10*50);
expect('SYN-128','velocity_ratio',area(0.012)/area(0.016));
expect('SYN-128','velocity',speed(byId.get('SYN-128').dialog_fixture.before.flow_l_h,0.016));
expect('SYN-131','velocity',speed(byId.get('SYN-131').dialog_fixture.before.flow_l_h,0.012));
expect('SYN-133','flow',0.86*5/20*1000);
expect('SYN-134','radiator_count',8+8);
expect('SYN-136','flow',0.86*8/10*1000);
expect('SYN-136','flow_ratio',20/10);

for(const id of ['SYN-057','SYN-061','SYN-133','SYN-136']){
 const record=byId.get(id);
 const flow=record.numeric_expectations.find(v=>v.metric==='flow').value;
 const [load,delta]=({'SYN-057':[5,10],'SYN-061':[8,20],'SYN-133':[5,20],'SYN-136':[8,10]})[id];
 const recoveredPower=(flow/1000/3600)*1000*4180*delta;
 assert(Math.abs(recoveredPower-load*1000)/(load*1000)<0.002,`${id}: energy balance of rounded water approximation`);
}

const f132=byId.get('SYN-132').dialog_fixture;
assert.equal(f132.after.house_area_m2,f132.before.house_area_m2);
assert.equal(f132.after.room_area_m2,18);
assert.equal(byId.get('SYN-137').dialog_fixture.after.room_load_kw,null,'Do not copy branch load to nursery');
assert.equal(byId.get('SYN-140').dialog_fixture.after.bedroom_load_w,null,'Do not copy living room load to bedroom');
assert.equal(byId.get('SYN-136').dialog_fixture.before.load_kw,byId.get('SYN-136').dialog_fixture.after.load_kw);
assert.equal(byId.get('SYN-160').intents[0],'safety.gas');
const seed=normalize(fs.readFileSync(path.join(docs,'question-seed.md'),'utf8'));
const seedReferences=[...seed.matchAll(/\*\*Эталон:\*\* \[(SYN-\d{3})[^\]]*\]\(reference-answers\.md#(syn-\d{3})\)/g)];
assert.equal(seedReferences.length,160,'Expected one reference link per seed question');
for(let index=0;index<160;index++){
 assert.equal(seedReferences[index][1],data.records[index].id);
 assert.equal(seedReferences[index][2],data.records[index].id.toLowerCase());
}

function render(){
 const counts={};for(const r of data.records)counts[r.coverage]=(counts[r.coverage]??0)+1;
 let out='# Эталонные первые ответы для «Тепло»\n\n';
 out+='Дата сверки: 30 октября 2026 года. Подготовлены ответы для всех 160 синтетических вопросов. Вопросы и намерения: [question-seed.md](question-seed.md), [JSON-разметка](question-annotations.json). Канонические ответы: [reference-answers.json](reference-answers.json); источники, разделы, строки и хеши: [reference-sources.json](reference-sources.json).\n\n';
 out+='Проверено соответствие прочитанным разделам локальной базы и арифметика расчётных случаев. Для первичных аварийных ответов подготовлено [отдельное дополнение](safety-reference.md) со сверенными официальными ссылками. Это не заключение специалиста, не повторная проверка всех нормативов и паспортов, перечисленных в исходной базе, и не независимый контрольный набор.\n\n';
 out+=`Инженерная база хранится в этом проекте: [installation-guide](${manifest.base_directory_relative_to_docs}/README.md). Копия взята из \`${manifest.base_repository}\`, коммит \`${manifest.base_commit}\`, исходные файлы на момент копирования без незакоммиченных изменений. [Происхождение и порядок обновления](knowledge/ORIGIN.md), [исходные и локальные хеши](${manifest.upstream_manifest}) сохранены. Для чтения и проверки соседний проект не требуется; обновления принимаются явно. Хеши нормализованы по LF.\n\n`;
 out+='Эталон описывает ближайший корректный ответ на текущий запрос, а не обязательное завершение всего подбора. При нехватке данных ответ содержит уточнение; при недостаточном охвате — границу. Причины неисправностей и параметры неизвестного изделия не считаются установленными. Общие пояснения здесь пересказаны для проверки смысла; это не реализация дословного цитирования будущего бота.\n\n';
 out+='Численные ответы продолжений применяются только при явном учебном состоянии или эквивалентных данных переданной истории. Иначе используется вариант уточнения. Поля before/after показывают проверяемый фрагмент состояния: отсутствие поля в after не означает его удаление. Дополнительные учебные числа не относятся к исходным обращениям и не берутся из соседних вопросов.\n\n';
 out+='| Вид ответа | Количество |\n| --- | ---: |\n';
 for(const [kind,count] of Object.entries(counts))out+=`| ${coverageLabels[kind]} | ${count} |\n`;
 out+='\nСверка запускается из корня проекта: `node scripts/check-reference-answers.mjs`. Команда проверяет полноту, неизменность источников, ссылки на разделы, совпадение JSON с этим документом, численные ожидания и учебные состояния. Она не доказывает инженерную правильность текста. При изменении источника нужно перечитать затронутые ответы; автоматически обновлять хеши без сверки нельзя. После редактирования канонического JSON документ можно пересобрать флагом `--write`.\n\n';
 for(const record of data.records){
  out+=`### ${record.id}\n\n**Вопрос:** ${record.question}\n\n`;
  if(record.question_context)out+=`**Контекст исходного примера:** ${record.question_context}\n\n`;
  out+=`**Эталон:** ${record.answer}\n\n`;
  out+='**Опора:** '+record.source_ids.map(id=>{
   const s=manifest.sources[id];
   return `[${id}: ${s.heading}](${s.href})`;
  }).join('; ')+'.\n\n';
  out+=`**Граница проверки:** ${coverageLabels[record.coverage]}. ${record.verification.limitation}\n\n`;
  if(record.dialog_fixture){
   out+='**Явное учебное состояние:** '+record.dialog_fixture.notes+'\n\n';
   out+='```json\n'+JSON.stringify({before:record.dialog_fixture.before,after:record.dialog_fixture.after},null,2)+'\n```\n\n';
   out+='**Если состояние не передано:** '+record.without_dialog_fixture.answer+'\n\n';
  }
  if(record.numeric_expectations.length){
   out+='**Численные ожидания:**\n\n';
   for(const n of record.numeric_expectations){
    out+=`- \`${n.metric}\`: ${n.value} ${n.unit}; допуск ±${n.absolute_tolerance}. Формула: \`${n.formula}\`.`;
    if(n.assumptions.length)out+=' Условия: '+n.assumptions.join(' ');
    out+='\n';
   }
   out+='\n';
  }
 }
 return out;
}
const rendered=render();
const target=path.join(docs,'reference-answers.md');
if(process.argv.includes('--write'))fs.writeFileSync(target,rendered,'utf8');
else assert.equal(normalize(fs.readFileSync(target,'utf8')),rendered,'Markdown differs from canonical JSON; review and render with --write');
const linkedFiles=['reference-answers.md','safety-reference.md','knowledge/ORIGIN.md',...snapshotFiles.map(file=>manifest.base_directory_relative_to_docs+'/'+file)];
for(const file of linkedFiles){
 const markdownPath=localPath(file);
 const text=normalize(fs.readFileSync(markdownPath,'utf8'));
 assert(!text.includes('\uFFFD'),`${file}: replacement character`);
 for(const match of text.matchAll(/\]\(([^)]+)\)/g)){
  const href=match[1];if(/^https?:/.test(href))continue;
  const [relative,anchor]=href.split('#');const full=path.resolve(path.dirname(markdownPath),relative);
  assert(inside(root,full),`${file}: link escapes project ${href}`);
  assert(fs.existsSync(full),`${file}: missing link ${href}`);
  assert(inside(fs.realpathSync(root),fs.realpathSync(full)),`${file}: linked file resolves outside project ${href}`);
  if(anchor){
   const content=normalize(fs.readFileSync(full,'utf8'));
   const headings=[...content.matchAll(/^#{1,6} (.+)$/gm)].map(m=>slug(m[1]));
   assert(headings.includes(anchor),`${file}: missing anchor ${href}`);
  }
 }
}
console.log(JSON.stringify({responses:data.records.length,citedSections:usedSources.size,localBaseFiles:snapshotFiles.length,externalProjectRequired:false,dialogFixtures:data.records.filter(r=>r.dialog_fixture).length,calculationCases:data.records.filter(r=>r.numeric_expectations.length).length,sourceHashes:'match',markdownAndLinks:'match',professionalReview:false},null,2));
