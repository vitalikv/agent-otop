"""Обучение собственной сети определения намерения (этап 5).

Вход: data/generated/intent-dataset.json (npm run train:data). Признаки уже посчитаны
классом IntentFeaturizer на TypeScript, поэтому собственной обработки текста здесь нет.
Выход в data/generated: веса для сервиса (intent-model.json), отчёт групповой
перекрёстной проверки (intent-report.json) и логиты для сверки с выполнением сети
на TypeScript (intent-parity.json, npm run train:check).
"""
import argparse
import base64
import hashlib
import json
import math
import os
import random
import struct
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

os.environ.setdefault('CUBLAS_WORKSPACE_CONFIG', ':4096:8')
import torch  # noqa: E402
from torch import nn  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
GENERATED = ROOT / 'data' / 'generated'


class IntentNet(nn.Module):
    """Mean of hashed n-gram embeddings → ReLU → linear layer; mirrors server/IntentClassifier.ts."""

    def __init__(self, buckets, hidden, classes, dropout):
        super().__init__()
        self.embedding = nn.EmbeddingBag(buckets, hidden, mode='mean')
        self.hidden_bias = nn.Parameter(torch.zeros(hidden))
        self.dropout = nn.Dropout(dropout)
        self.output = nn.Linear(hidden, classes)

    def forward(self, ids, offsets):
        return self.output(self.dropout(torch.relu(self.embedding(ids, offsets) + self.hidden_bias)))


def pack(rows, device):
    ids, offsets = [], []
    for row in rows:
        offsets.append(len(ids))
        ids.extend(row)
    return torch.tensor(ids, dtype=torch.long, device=device), torch.tensor(offsets, dtype=torch.long, device=device)


def train_net(rows, labels, classes, buckets, params, device, seed):
    torch.manual_seed(seed)
    order_rng = random.Random(seed)
    model = IntentNet(buckets, params['hidden'], classes, params['dropout']).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=params['lr'], weight_decay=params['weight_decay'])
    order = list(range(len(rows)))
    for _ in range(params['epochs']):
        order_rng.shuffle(order)
        model.train()
        for start in range(0, len(order), params['batch_size']):
            batch = order[start:start + params['batch_size']]
            ids, offsets = pack([rows[i] for i in batch], device)
            loss = nn.functional.cross_entropy(model(ids, offsets), torch.tensor([labels[i] for i in batch], device=device))
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
    model.eval()
    return model


@torch.no_grad()
def net_probabilities(model, rows, device):
    return torch.softmax(model(*pack(rows, device)), dim=1).cpu()


def tfidf_matrix(rows, idf, device):
    row_index = [i for i, row in enumerate(rows) for _ in row]
    column_index = [f for row in rows for f in row]
    x = torch.zeros(len(rows), idf.numel(), device=device)
    if column_index:
        columns = torch.tensor(column_index, device=device)
        x[torch.tensor(row_index, device=device), columns] = idf[columns]
    return x / x.norm(dim=1, keepdim=True).clamp_min(1e-12)


def train_tfidf(rows, labels, classes, buckets, l2, device):
    """Baseline: binary TF × IDF of the same hashed features, multinomial logistic regression with L2."""
    idf = torch.zeros(buckets)
    for feature, count in Counter(f for row in rows for f in row).items():
        idf[feature] = math.log((1 + len(rows)) / (1 + count)) + 1
    idf = idf.to(device)
    x, y = tfidf_matrix(rows, idf, device), torch.tensor(labels, device=device)
    weight = torch.zeros(buckets, classes, device=device, requires_grad=True)
    bias = torch.zeros(classes, device=device, requires_grad=True)
    optimizer = torch.optim.LBFGS([weight, bias], max_iter=300, line_search_fn='strong_wolfe')

    def closure():
        optimizer.zero_grad()
        loss = nn.functional.cross_entropy(x @ weight + bias, y) + l2 * weight.pow(2).sum()
        loss.backward()
        return loss

    optimizer.step(closure)
    return lambda test: torch.softmax(tfidf_matrix(test, idf, device) @ weight + bias, dim=1).detach().cpu()


def make_folds(examples, folds, seed):
    """Whole groups (a question with its paraphrases) go to one fold; each intent's groups are spread over folds."""
    rng = random.Random(seed)
    members = defaultdict(list)
    for example in examples:
        members[example['group']].append(example['intent'])
    by_intent = defaultdict(list)
    for group, intents in members.items():
        assert len(set(intents)) == 1, f'В группе {group} разные намерения'
        by_intent[intents[0]].append(group)
    fold_of, offset = {}, 0
    for intent in sorted(by_intent):
        groups = sorted(by_intent[intent])
        rng.shuffle(groups)
        for j, group in enumerate(groups):
            fold_of[group] = (offset + j) % folds
        offset += len(groups)
    return [fold_of[example['group']] for example in examples]


def mean(values):
    values = list(values)
    return round(sum(values) / len(values), 4) if values else None


def evaluate(predicted, examples, classes, probabilities=None):
    gold = [example['intent'] for example in examples]
    correct = [p == g for p, g in zip(predicted, gold)]
    per_class, f1 = {}, []
    for name in classes:
        support = gold.count(name)
        hits = sum(1 for p, g in zip(predicted, gold) if p == g == name)
        chosen = predicted.count(name)
        recall, precision = (hits / support if support else 0.0), (hits / chosen if chosen else 0.0)
        f1.append(2 * precision * recall / (precision + recall) if precision + recall else 0.0)
        per_class[name] = {'support': support, 'recall': round(recall, 4), 'precision': round(precision, 4)}
    seeds = [i for i, example in enumerate(examples) if example['origin'] == 'seed']
    safety = [i for i, name in enumerate(gold) if name.startswith('safety.')]
    other = [i for i, name in enumerate(gold) if not name.startswith('safety.')]
    is_safety = [(p or '').startswith('safety.') for p in predicted]
    confusions = Counter((g, p or 'нет') for p, g in zip(predicted, gold) if p != g)
    top3 = None
    if probabilities is not None:
        best = probabilities.topk(3, dim=1).indices.tolist()
        top3 = mean(classes.index(g) in row for g, row in zip(gold, best))
    return {
        'accuracy': mean(correct),
        'top3_accuracy': top3,
        'macro_f1': mean(f1),
        'seed_accuracy': mean(correct[i] for i in seeds),
        'seed_any_intent_accuracy': mean(predicted[i] in examples[i]['intents'] for i in seeds),
        'safety_recall_exact': mean(correct[i] for i in safety),
        'safety_recall_any_safety': mean(is_safety[i] for i in safety),
        'false_safety_rate': mean(is_safety[i] for i in other),
        'per_class': per_class,
        'top_confusions': [{'gold': g, 'predicted': p, 'count': n} for (g, p), n in confusions.most_common(15)],
    }


def threshold_table(probabilities, labels):
    confidence, predicted = probabilities.max(dim=1)
    gold = torch.tensor(labels)
    rows = []
    for step in range(20):
        threshold = step / 20
        accepted = confidence >= threshold
        count = int(accepted.sum())
        accuracy = float((predicted[accepted] == gold[accepted]).float().mean()) if count else None
        rows.append({'threshold': threshold, 'coverage': round(count / len(labels), 4), 'accepted_accuracy': None if accuracy is None else round(accuracy, 4)})
    return rows


def tensor(value):
    values = value.detach().cpu().contiguous().view(-1).tolist()
    return {'shape': list(value.shape), 'data': base64.b64encode(struct.pack(f'<{len(values)}f', *values)).decode('ascii')}


def summary(metrics):
    return {key: value for key, value in metrics.items() if key not in ('per_class', 'top_confusions')}


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description='Обучение сети определения намерения')
    parser.add_argument('--device', choices=['cpu', 'cuda', 'auto'], default='cpu', help='cpu даёт воспроизводимый результат на любом компьютере')
    args = parser.parse_args()
    device = torch.device('cuda' if args.device == 'cuda' or (args.device == 'auto' and torch.cuda.is_available()) else 'cpu')
    torch.use_deterministic_algorithms(True)

    dataset_path = GENERATED / 'intent-dataset.json'
    if not dataset_path.exists():
        sys.exit('Нет data/generated/intent-dataset.json. Выполните npm run train:data.')
    raw = dataset_path.read_bytes()
    dataset = json.loads(raw)
    assert dataset['schema_version'] == 1, 'Неизвестная версия набора'
    examples, classes = dataset['examples'], dataset['classes']
    index = {name: i for i, name in enumerate(classes)}
    rows, labels = [example['features'] for example in examples], [index[example['intent']] for example in examples]
    settings, buckets = dataset['training'], dataset['featurizer']['buckets']
    base = {key: settings[key] for key in ('batch_size', 'lr', 'weight_decay')}
    folds = make_folds(examples, settings['folds'], settings['seed'])

    def cross_validate(fit):
        probabilities = torch.zeros(len(examples), len(classes))
        for fold in range(settings['folds']):
            train = [i for i, f in enumerate(folds) if f != fold]
            test = [i for i, f in enumerate(folds) if f == fold]
            predict = fit([rows[i] for i in train], [labels[i] for i in train])
            probabilities[test] = predict([rows[i] for i in test])
        return probabilities

    def as_names(probabilities):
        return [classes[i] for i in probabilities.argmax(dim=1).tolist()]

    def net_fit(params):
        def fit(train_rows, train_labels):
            model = train_net(train_rows, train_labels, len(classes), buckets, params, device, settings['seed'])
            return lambda test: net_probabilities(model, test, device)
        return fit

    print(f'Набор: {len(examples)} примеров, {len(classes)} классов, {settings["folds"]} групп проверки; устройство {device}.')
    grid = []
    for variant in settings['grid']:
        params = {**base, **variant}
        started = time.perf_counter()
        probabilities = cross_validate(net_fit(params))
        metrics = evaluate(as_names(probabilities), examples, classes, probabilities)
        grid.append({'params': params, 'seconds': round(time.perf_counter() - started, 2), 'metrics': metrics, 'probabilities': probabilities})
        print(f'  сеть {variant}: точность {metrics["accuracy"]:.3f}, macro-F1 {metrics["macro_f1"]:.3f}, исходные вопросы {metrics["seed_accuracy"]:.3f} ({grid[-1]["seconds"]} с)')
    best = max(grid, key=lambda item: (item['metrics']['accuracy'], item['metrics']['macro_f1'], -item['params']['hidden'], -item['params']['epochs']))

    tfidf_probabilities = cross_validate(lambda r, l: train_tfidf(r, l, len(classes), buckets, settings['tfidf_l2'], device))
    tfidf = evaluate(as_names(tfidf_probabilities), examples, classes, tfidf_probabilities)
    rules = evaluate([example['rules'] for example in examples], examples, classes)
    thresholds = threshold_table(best['probabilities'], labels)
    target = settings['target_accepted_accuracy']
    reached = [row for row in thresholds if row['accepted_accuracy'] is not None and row['accepted_accuracy'] >= target]
    chosen = reached[0] if reached else max(thresholds, key=lambda row: row['accepted_accuracy'] or 0)

    started = time.perf_counter()
    model = train_net(rows, labels, len(classes), buckets, best['params'], device, settings['seed'])
    train_seconds = round(time.perf_counter() - started, 2)
    model = model.cpu()
    parameters = sum(p.numel() for p in model.parameters())
    reviews = Counter(example['review'] for example in examples)
    origins = Counter(example['origin'] for example in examples)
    cv = {'network': summary(best['metrics']), 'tfidf_logistic_regression': summary(tfidf), 'rules_stage_4': summary(rules)}
    output = {
        'format': 'teplo-intent-mlp',
        'version': 1,
        'featurizer': dataset['featurizer'],
        'classes': classes,
        'threshold': chosen['threshold'],
        'weights': {
            'embedding': tensor(model.embedding.weight),
            'hidden_bias': tensor(model.hidden_bias),
            'output': tensor(model.output.weight),
            'output_bias': tensor(model.output.bias),
        },
        'training': {
            'dataset_sha256': hashlib.sha256(raw).hexdigest(),
            'inputs': dataset['inputs'],
            'seed': settings['seed'],
            'params': best['params'],
            'parameters': parameters,
            'device': str(device),
            'torch': torch.__version__,
            'examples': len(examples),
            'origins': dict(origins),
            'reviews': dict(reviews),
            'threshold_target': target,
            'threshold_coverage': chosen['coverage'],
            'threshold_accepted_accuracy': chosen['accepted_accuracy'],
            'cross_validation': cv,
            'warning': 'Обучено и проверено на синтетических примерах разработки; независимого контрольного набора нет.',
        },
    }
    model_text = json.dumps(output, ensure_ascii=False, indent=1) + '\n'
    (GENERATED / 'intent-model.json').write_text(model_text, encoding='utf-8', newline='\n')

    step = max(1, len(examples) // settings['parity_cases'])
    picked = list(range(0, len(examples), step))[:settings['parity_cases']]
    with torch.no_grad():
        logits = model(*pack([rows[i] for i in picked], 'cpu'))
    parity = {
        'model_sha256': hashlib.sha256(model_text.encode('utf-8')).hexdigest(),
        'cases': [{'id': examples[i]['id'], 'logits': [round(v, 7) for v in logits[n].tolist()]} for n, i in enumerate(picked)],
    }
    (GENERATED / 'intent-parity.json').write_text(json.dumps(parity, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')
    report = {
        'dataset_sha256': output['training']['dataset_sha256'],
        'grid': [{'params': item['params'], 'seconds': item['seconds'], 'metrics': summary(item['metrics'])} for item in grid],
        'chosen_params': best['params'],
        'network': best['metrics'],
        'tfidf_logistic_regression': tfidf,
        'rules_stage_4': rules,
        'thresholds': thresholds,
        'final_training_seconds': train_seconds,
    }
    (GENERATED / 'intent-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')

    print('Групповая перекрёстная проверка (оценка на синтетических примерах разработки):')
    for name, metrics in (('сеть', best['metrics']), ('TF-IDF + логистическая регрессия', tfidf), ('правила этапа 4', rules)):
        top3 = '' if metrics['top3_accuracy'] is None else f', в тройке лучших {metrics["top3_accuracy"]:.3f}'
        print(f'  {name}: точность {metrics["accuracy"]:.3f}{top3}, macro-F1 {metrics["macro_f1"]:.3f}, исходные вопросы {metrics["seed_accuracy"]:.3f}, '
              f'опасность распознана {metrics["safety_recall_any_safety"]:.3f}, ложная опасность {metrics["false_safety_rate"]:.3f}')
    print(f'Выбрано: {best["params"]}. Порог {chosen["threshold"]:.2f}: охват {chosen["coverage"]:.3f}, точность принятых {chosen["accepted_accuracy"]:.3f}.')
    print(f'Итоговая сеть: {parameters} параметров, обучение {train_seconds} с. Сохранено: data/generated/intent-model.json, intent-report.json, intent-parity.json.')


if __name__ == '__main__':
    main()
