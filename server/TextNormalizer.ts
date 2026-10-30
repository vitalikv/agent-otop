export class TextNormalizer {
  normalize(text: string): string {
    return text.normalize('NFKC').toLowerCase().replace(/ё/g, 'е').replace(/−/g, '-')
      .replace(/(\d),(?=\d)/g, '$1.').replace(/(?<![a-z])kw(?![a-z])/g, 'квт').replace(/(?<![a-z])w(?![a-z])/g, 'вт')
      .replace(/(?<=\d)\s*[х×x]\s*(?=\d)/g, 'x').replace(/\s+/g, ' ').trim();
  }
}
