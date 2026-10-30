// Arithmetic for the language model's calculate tool: the model writes the formula, code computes the number.
// Recursive descent over numbers, + - * / ^, parentheses, sqrt() and pi; nothing is evaluated as code.
export class ExpressionCalculator {
  evaluate(expression: string): number {
    if (typeof expression !== 'string' || !expression.trim() || expression.length > 300) throw new Error('Пустое или слишком длинное выражение.');
    const source = expression.replace(/(\d),(\d)/g, '$1.$2').replace(/[×·]/g, '*').replace(/π/g, 'pi');
    const tokens = source.match(/\d+(?:\.\d+)?(?:e[+-]?\d+)?|[a-z]+|[-+*/^()]|\S/gi) ?? [];
    let position = 0;
    const peek = () => tokens[position];
    const take = (expected?: string) => {
      const token = tokens[position++];
      if (token === undefined || (expected !== undefined && token !== expected)) throw new Error(`Ожидалось «${expected ?? 'значение'}».`);
      return token;
    };
    const primary = (): number => {
      const token = take();
      if (/^\d/.test(token)) return Number(token);
      if (token === '(') { const value = sum(); take(')'); return value; }
      if (token.toLowerCase() === 'pi') return Math.PI;
      if (token.toLowerCase() === 'sqrt') { take('('); const value = sum(); take(')'); return Math.sqrt(value); }
      throw new Error(`Недопустимый элемент «${token}».`);
    };
    const unary = (): number => {
      if (peek() === '-') { take(); return -unary(); }
      if (peek() === '+') { take(); return unary(); }
      return power();
    };
    // Right-associative; -2^2 = -4 as in ordinary notation.
    const power = (): number => {
      const base = primary();
      if (peek() !== '^') return base;
      take();
      return base ** unary();
    };
    const product = (): number => {
      let value = unary();
      while (peek() === '*' || peek() === '/') value = take() === '*' ? value * unary() : value / unary();
      return value;
    };
    const sum = (): number => {
      let value = product();
      while (peek() === '+' || peek() === '-') value = take() === '+' ? value + product() : value - product();
      return value;
    };
    const value = sum();
    if (position !== tokens.length) throw new Error(`Лишний элемент «${tokens[position]}».`);
    if (!Number.isFinite(value)) throw new Error('Результат не является конечным числом.');
    return value;
  }
}
