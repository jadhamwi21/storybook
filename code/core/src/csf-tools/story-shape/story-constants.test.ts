import { describe, expect, it } from 'vitest';

import { loadCsf } from '../CsfFile.ts';
import { textOf } from '../estree/ast.ts';
import { createStoryArgsResolver } from './resolve-story-args.ts';
import { collectStoryConstants } from './story-constants.ts';

const constantsOf = (code: string, taken?: string[], fileName = 'entry.tsx') => {
  const csf = loadCsf(`${code}\nexport default {};\nexport const Story = { args: { v } };`, {
    makeTitle: () => 'Example',
    fileName,
  }).parse();
  const resolver = createStoryArgsResolver(csf);
  const { args } = resolver.resolve('Story');
  const constants = collectStoryConstants(args, resolver.ctx, new Set(taken));
  return Object.fromEntries(
    [...constants.names].map((name) => [name, textOf(constants.declarations.get(name)!.value)])
  );
};

describe('collectStoryConstants', () => {
  it('collects the constants a value reads, and those they read', () => {
    expect(
      constantsOf(
        `const SEP = '\\n';\nconst lines = ['a', 'b'];\nconst v = \`<pre>\${lines.join(SEP)}</pre>\`.length;`
      )
    ).toEqual({ SEP: `'\\n'`, lines: `['a', 'b']` });
  });

  it('collects a component a constant renders', () => {
    expect(
      constantsOf(
        `const Icon = () => <b />;\nconst renderIcon = () => <Icon />;\nconst v = renderIcon();`
      )
    ).toEqual({ Icon: '() => <b />', renderIcon: '() => <Icon />' });
  });

  it('keeps the as const a constant is written with', () => {
    expect(constantsOf(`const sizes = ['sm', 'lg'] as const;\nconst v = sizes[0];`)).toEqual({
      sizes: `['sm', 'lg'] as const`,
    });
  });

  it('keeps an as const written before satisfies', () => {
    expect(
      constantsOf(
        `const sizes = ['sm', 'lg'] as const satisfies readonly string[];\nconst v = sizes[0];`
      )
    ).toEqual({ sizes: `['sm', 'lg'] as const satisfies readonly string[]` });
  });

  it('declares nothing for a value holding an angle-bracket assertion', () => {
    expect(
      constantsOf(`const sizes = [<string>'sm'];\nconst v = sizes[0];`, [], 'entry.ts')
    ).toEqual({});
  });

  it('declares nothing for a generic arrow written outside a TSX file', () => {
    expect(constantsOf(`const id = <T>(x: T) => x;\nconst v = id(1);`, [], 'entry.ts')).toEqual({});
  });

  it('leaves out an angle-bracket assertion, which JSX cannot hold', () => {
    expect(
      constantsOf(`const sizes = <const>['sm', 'lg'];\nconst v = sizes[0];`, [], 'entry.ts')
    ).toEqual({
      sizes: `['sm', 'lg']`,
    });
  });

  it('collects the key a parameter pattern reads', () => {
    expect(
      constantsOf(`const KEY = 'a';\nconst pick = ({ [KEY]: x }) => x;\nconst v = pick({ a: 1 });`)
    ).toEqual({ KEY: `'a'`, pick: '({ [KEY]: x }) => x' });
  });

  it('reads a global the story file declares over as its own', () => {
    expect(constantsOf(`const Math = { label: 'custom' };\nconst v = Math.label;`)).toEqual({
      Math: `{ label: 'custom' }`,
    });
  });

  it.each([
    ['a name the snippet takes', `const ref = { current: 1 };\nconst v = ref.current;`, ['ref']],
    [
      'a type of the story file',
      `interface Item { id: number }\nconst items = [] as Item[];\nconst v = items.length;`,
      [],
    ],
    [
      'a constant that reads itself',
      `const fact = (n) => (n ? n * fact(n - 1) : 1);\nconst v = fact(3);`,
      [],
    ],
    [
      'a component it renders that the snippet cannot declare',
      `import { Icon } from './Icon';\nconst renderIcon = () => <Icon />;\nconst v = renderIcon();`,
      [],
    ],
    ['a type imported inline', `const opt = 'a' as import('./types').Opt;\nconst v = [opt];`, []],
    [
      'an import',
      `import { theme } from './theme';\nconst size = theme.size;\nconst v = size;`,
      [],
    ],
  ])('declares nothing for a value that reads %s', (_what, code, taken) => {
    expect(constantsOf(code, taken)).toEqual({});
  });
});
