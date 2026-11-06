// Intent classifier: TF-IDF features (stemmed unigrams + bigrams) and a
// multinomial logistic regression (softmax) trained with mini-batch gradient
// descent and L2 regularisation. Pure JavaScript, trains in well under a second.

import natural from 'natural';

const stem = (w) => natural.PorterStemmer.stem(w);

export function tokenize(text) {
  return String(text).toLowerCase()
    .replace(/[^a-z0-9_\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (/^[A-Z_]+$/i.test(w) && w.startsWith('slot_') ? w : stem(w)));
}

function features(tokens) {
  const f = [...tokens];
  for (let i = 0; i + 1 < tokens.length; i++) f.push(`${tokens[i]}__${tokens[i + 1]}`);
  return f;
}

export class IntentClassifier {
  constructor({ epochs = 220, lr = 0.5, l2 = 1e-3 } = {}) {
    Object.assign(this, { epochs, lr, l2 });
  }

  vectorize(text) {
    const feats = features(tokenize(text));
    const counts = new Map();
    for (const t of feats) {
      const j = this.vocab.get(t);
      if (j != null) counts.set(j, (counts.get(j) ?? 0) + 1);
    }
    const vec = [];
    let norm = 0;
    for (const [j, c] of counts) {
      const v = (1 + Math.log(c)) * this.idf[j];
      vec.push([j, v]);
      norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    return vec.map(([j, v]) => [j, v / norm]);
  }

  train(examples) {
    // examples: [{ text, label }]
    this.labels = [...new Set(examples.map((e) => e.label))];
    const df = new Map();
    const docs = examples.map((e) => new Set(features(tokenize(e.text))));
    for (const d of docs) for (const t of d) df.set(t, (df.get(t) ?? 0) + 1);
    this.vocab = new Map([...df.keys()].map((t, i) => [t, i]));
    this.idf = [...df.values()].map((n) => Math.log((1 + examples.length) / (1 + n)) + 1);

    const K = this.labels.length;
    const D = this.vocab.size;
    this.W = Array.from({ length: K }, () => new Float64Array(D));
    this.b = new Float64Array(K);
    const X = examples.map((e) => this.vectorize(e.text));
    const Y = examples.map((e) => this.labels.indexOf(e.label));

    // deterministic shuffle so training is reproducible
    let seed = 42;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const idx = X.map((_, i) => i);
    for (let ep = 0; ep < this.epochs; ep++) {
      for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      const lr = this.lr / (1 + ep * 0.02);
      for (const i of idx) {
        const p = this.probs(X[i]);
        for (let k = 0; k < K; k++) {
          const g = p[k] - (k === Y[i] ? 1 : 0);
          for (const [j, v] of X[i]) this.W[k][j] -= lr * (g * v + this.l2 * this.W[k][j]);
          this.b[k] -= lr * g;
        }
      }
    }
    return this;
  }

  probs(vec) {
    const z = this.labels.map((_, k) => {
      let s = this.b[k];
      for (const [j, v] of vec) s += this.W[k][j] * v;
      return s;
    });
    const m = Math.max(...z);
    const e = z.map((x) => Math.exp(x - m));
    const sum = e.reduce((a, c) => a + c, 0);
    return e.map((x) => x / sum);
  }

  predict(text) {
    const vec = this.vectorize(text);
    const p = this.probs(vec);
    const ranked = this.labels.map((label, k) => ({ label, p: p[k] })).sort((a, b) => b.p - a.p);
    return { intent: ranked[0].label, confidence: ranked[0].p, ranked: ranked.slice(0, 3), knownTokens: vec.length };
  }
}
