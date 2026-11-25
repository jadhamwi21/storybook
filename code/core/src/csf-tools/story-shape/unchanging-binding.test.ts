import { describe, expect, it } from 'vitest';

import { SourceEditor } from '../estree/editor.ts';
import { isVisiblyChanged, unchangingKind } from './unchanging-binding.ts';

const bindingOf = (code: string, name = 'lines') => {
  const editor = new SourceEditor(code, 'entry.ts');
  editor.parentOf(editor.program);
  return {
    binding: editor.scopes.program.bindings.get(name)!,
    ctx: { editor, filePath: 'entry.ts' },
  };
};

const kindOf = (code: string, name = 'lines') => {
  const { binding, ctx } = bindingOf(code, name);
  return unchangingKind(binding, ctx);
};

describe('unchangingKind', () => {
  it.each([
    ['a primitive', `const lines = 'a';`, 'primitive'],
    ['a function', `const lines = () => 1;`, 'function'],
    ['an array of primitives', `const lines = ['a', 'b'];`, 'flat'],
    [
      'an array read in a type, an argTypes option and a play function',
      `const lines = ['a'] as const;
type Line = (typeof lines)[number];
export default { argTypes: { line: { options: lines } } };
export const S = { play: async () => { await expect(lines.map((l) => l.trim())).toHaveLength(1); } };`,
      'flat',
    ],
    [
      'an array given to a CSF factory meta and story',
      `import preview from '#.storybook/preview';\nconst lines = ['a'];\nconst meta = preview.meta({ args: { lines } });\nexport const S = meta.story({ args: { n: lines.length } });`,
      'flat',
    ],
    [
      'an array a CSF factory story holds, which a test runs',
      `import preview from '#.storybook/preview';\nconst lines = ['a'];\nconst meta = preview.meta({ args: { lines } });\nexport const S = meta.story({});\nS.test('x', async () => {});`,
      'flat',
    ],
    [
      'an array an imported expect reads',
      `import { expect } from 'storybook/test';\nconst lines = ['a'];\nexport const S = { play: async () => { await expect(lines).toHaveLength(1); } };`,
      'flat',
    ],
  ])('accepts %s', (_what, code, kind) => {
    expect(kindOf(code)).toBe(kind);
  });

  it.each([
    ['holds objects', `const lines = [{ id: 1 }];`],
    ['is declared with var', `var lines = ['a'];`],
    ['is built by a call', `const lines = new Map();`],
    ['is changed by a method', `const lines = ['a'];\nlines.push('b');`],
    [
      'is changed by a destructuring assignment',
      `const lines = ['a', 'b'];\n[lines[0], lines[1]] = [lines[1], lines[0]];`,
    ],
    [
      'is changed through a function returning it',
      `const lines = ['a'];\nconst get = () => lines;\nget().push('b');`,
    ],
    ['is handed to a template tag', `const lines = ['a'];\nconst out = tag\`\${lines}\`;`],
    ['is handed to an unknown function', `const lines = ['a'];\ngrow(lines);`],
    ['is given another name', `const lines = ['a'];\nconst alias = lines;`],
    ['is a function given a property', `const lines = () => 1;\nlines.prefix = 'a';`],
    [
      'is handed to a callback that takes the array',
      `const lines = ['a'];\nlines.forEach((line, i, all) => { all[i] = line.toUpperCase(); });`,
    ],
    ['is handed to a named callback', `const lines = ['a'];\nlines.forEach(grow);`],
    [
      'is handed to a callback that reaches it through arguments',
      `const lines = ['a'];\nlines.forEach(function () { arguments[2].push('b'); });`,
    ],
    [
      'is handed to a nested function declared under a reading name',
      `const lines = ['a'];\n{\n  const expect = (x) => x.push('b');\n  expect(lines);\n}`,
    ],
    [
      'is given to a CSF factory meta whose args are changed',
      `import preview from '#.storybook/preview';\nconst lines = ['a'];\nconst meta = preview.meta({ args: { lines } });\nmeta.input.args.lines.push('b');\nexport const S = meta.story({});`,
    ],
    [
      'is handed to a function the file declares under a reading name',
      `const lines = ['a'];\nconst expect = (x) => x;\nexpect(lines).push('b');`,
    ],
    [
      'a helper holds, whose own run method can change it',
      `const lines = ['a'];\nconst helper = { lines, run() {} };\nhelper.run();\nexport const S = { args: { lines } };`,
    ],
    [
      'is given to a meta method that is not a CSF factory',
      `import { analytics } from './analytics';\nconst lines = ['a'];\nexport const tracked = analytics.meta({ args: { lines } });`,
    ],
  ])('rejects a binding that %s', (_what, code) => {
    expect(kindOf(code)).toBeUndefined();
  });
});

describe('isVisiblyChanged', () => {
  it.each([
    ['a change the module makes', `let count = 0;\ncount += 1;`, true],
    [
      'a change a function the module calls makes',
      `let count = 0;\nfunction init() { count = 2; }\ninit();`,
      true,
    ],
    [
      'a change only an event handler makes',
      `let count = 0;\nfunction increment() { count += 1; }`,
      false,
    ],
    ['a change a lifecycle hook makes', `let count = 0;\nonMount(() => { count = 2; });`, false],
    [
      'a change a callback the module runs makes',
      `let count = 0;\n[1].forEach(() => { count = 2; });`,
      true,
    ],
    [
      'a change a function Storybook runs before render makes',
      `let count = 0;\nfunction setup() { count = 2; }\nexport default { beforeEach: setup };`,
      true,
    ],
    [
      'a change a function handed to a callback-taking call makes',
      `let count = 0;\nfunction add() { count += 1; }\n['a'].forEach(add);`,
      true,
    ],
    [
      'a change a handler arg makes',
      `let count = 0;\nfunction increment() { count += 1; }\nexport const S = { args: { onclick: increment } };`,
      false,
    ],
    [
      'a change a function a before-render arrow calls makes',
      `let count = 0;\nfunction reset() { count = 5; }\nexport default { beforeEach: () => { reset(); } };`,
      true,
    ],
    [
      'a change two calls deep the module makes',
      `let count = 0;\nfunction bump() { count = 5; }\nfunction init() { bump(); }\ninit();`,
      true,
    ],
    [
      'a change a function wrapped in a spy makes',
      `let count = 0;\nfunction inc() { count += 1; }\nconst onclick = fn(inc);`,
      false,
    ],
    [
      'a change a callback inside a lifecycle hook makes',
      `let count = 0;
onMount(() => { [1].forEach((n) => { count += n; }); });`,
      false,
    ],
    [
      'a change an inline handler in args makes',
      `let count = 0;\nexport const S = { args: { onclick: () => count++ } };`,
      false,
    ],
    [
      'a change a function a callback inside a lifecycle hook is handed makes',
      `let count = 0;\nfunction add() { count += 1; }\nonMount(() => { [1].forEach(add); });`,
      false,
    ],
    ['a change a method written with brackets makes', `const count = [];\ncount['push'](1);`, true],
    [
      'a change a function behind a type assertion makes',
      `let count = 0;\nconst bump = (() => { count += 1; }) as () => void;\nbump();`,
      true,
    ],
    [
      'a change a returned function makes',
      `let count = 0;\nfunction make() { return () => { count += 1; }; }\nmake()();`,
      true,
    ],
    [
      'a change a nested function handed to another call makes',
      `let count = 0;\nfunction setup() { const bump = () => { count += 1; }; untrack(bump); }\nsetup();`,
      true,
    ],
    [
      'a change a function called through call makes',
      `let count = 0;\nfunction bump() { count += 1; }\nbump.call(null);`,
      true,
    ],
    [
      'a change a handler in defineMeta args makes',
      `let count = 0;\nconst { Story } = defineMeta({ args: { onclick: () => count++ } });`,
      false,
    ],
    [
      'a store update the module makes',
      `const count = writable(0);\ncount.update((n) => n + 1);`,
      true,
    ],
  ])('while loading, counts %s', (_what, code, changed) => {
    const { binding, ctx } = bindingOf(code, 'count');
    expect(isVisiblyChanged(binding, ctx, { whileLoading: true })).toBe(changed);
    expect(isVisiblyChanged(binding, ctx)).toBe(true);
  });

  it('leaves a value alone when a copy of it is given a new one', () => {
    const { binding, ctx } = bindingOf(`const count = 0;\nlet copy = count;\ncopy = 1;`, 'count');
    expect(isVisiblyChanged(binding, ctx)).toBe(false);
  });
});
