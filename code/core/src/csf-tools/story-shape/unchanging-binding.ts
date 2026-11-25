import { isValidPreviewPath } from 'storybook/internal/csf/csf-utils';

import {
  type Node,
  calledMethodName,
  isFunction,
  isTSWrapper,
  staticKey,
  textOf,
  unwrapExpression,
  walk,
  withoutTypeCalls,
} from '../estree/ast.ts';
import { type Binding, constantInit } from '../estree/scope.ts';
import type { ReferenceContext } from './resolve-members.ts';

// `flat`: an array or object literal of primitives the file only reads.
export type UnchangingKind = 'primitive' | 'function' | 'flat';

const ARRAY_READING_METHODS = new Set(
  (
    'at concat entries every filter find findIndex findLast findLastIndex flat flatMap forEach ' +
    'includes indexOf join keys lastIndexOf map reduce reduceRight slice some toReversed ' +
    'toSorted toSpliced toString values with'
  ).split(' ')
);

// The callback parameter that receives the array itself: `forEach((item, index, array) => …)`.
const ARRAY_PARAMETER: Record<string, number> = {
  every: 2,
  filter: 2,
  find: 2,
  findIndex: 2,
  findLast: 2,
  findLastIndex: 2,
  flatMap: 2,
  forEach: 2,
  map: 2,
  reduce: 3,
  reduceRight: 3,
  some: 2,
};

const ARRAY_PRIMITIVE_METHODS = new Set('at includes indexOf join lastIndexOf'.split(' '));

const PRIMITIVE_METHODS = new Set(
  (
    'at charAt charCodeAt codePointAt concat endsWith includes indexOf lastIndexOf ' +
    'localeCompare normalize padEnd padStart repeat replace replaceAll search slice startsWith ' +
    'substring toFixed toLocaleString toLowerCase toPrecision toString toUpperCase trim trimEnd ' +
    'trimStart valueOf'
  ).split(' ')
);

const READING_FUNCTIONS = new Set(
  (
    'Array.from Array.isArray Boolean JSON.stringify Number Object.entries Object.keys ' +
    'Object.values String console.debug console.error console.info console.log console.warn ' +
    'expect structuredClone'
  ).split(' ')
);

const COPYING_CONSTRUCTORS = new Set(['Map', 'Set']);

// CSF factory story methods that run the story with its args.
const STORY_RUNNING_METHODS = new Set(['play', 'run', 'test']);

// Functions that run their callback after the story renders.
const DEFERRING_FUNCTIONS = new Set(
  (
    '$effect $effect.pre afterUpdate beforeUpdate onDestroy onMount onUnmounted onMounted ' +
    'requestAnimationFrame setInterval setTimeout'
  ).split(' ')
);

// Modules whose `expect` reads the value it is given.
const TEST_MODULES = new Set(['@storybook/test', 'storybook/test', 'vitest']);

const FACTORY_METHODS = new Set(['extend', 'meta', 'story']);

const PRIMITIVE_GLOBALS = new Set(['Infinity', 'NaN', 'undefined']);

// Whether the story file declares the callee's root name, as a local `expect` would.
const declaresCallee = (callee: Node, { editor }: ReferenceContext): boolean => {
  let root = unwrapExpression(callee);
  while (root.type === 'MemberExpression') {
    root = unwrapExpression(root.object);
  }
  if (root.type !== 'Identifier') {
    return true;
  }
  const binding = editor.scopes.bindingOf(root);
  const source =
    binding?.kind === 'import' && binding.declaration?.type === 'ImportDeclaration'
      ? binding.declaration.source.value
      : undefined;
  return binding !== undefined && !(source !== undefined && TEST_MODULES.has(source));
};

const isWrapper = (node: Node): boolean =>
  node.type === 'ChainExpression' || node.type === 'ParenthesizedExpression' || isTSWrapper(node);

const isTypePosition = (parent: Node): boolean =>
  parent.type.startsWith('TS') && !isTSWrapper(parent);

interface Analysis {
  ctx: ReferenceContext;
  kinds: Map<Binding, UnchangingKind | undefined>;
  // A cycle through these bindings counts as settled.
  visiting: Set<Binding>;
}

// The kind of a binding whose declared value cannot have changed by the time a story renders.
export function unchangingKind(
  binding: Binding,
  ctx: ReferenceContext
): UnchangingKind | undefined {
  return kindOfBinding(binding, { ctx, kinds: new Map(), visiting: new Set() });
}

function kindOfBinding(binding: Binding, analysis: Analysis): UnchangingKind | undefined {
  if (analysis.kinds.has(binding)) {
    return analysis.kinds.get(binding);
  }
  // A `var` is `undefined` to the code above it, which no declaration in the snippet reproduces.
  if (
    !binding.constant ||
    binding.kind === 'var' ||
    binding.node.type !== 'VariableDeclarator' ||
    binding.node.id.type !== 'Identifier' ||
    !binding.node.init ||
    analysis.visiting.has(binding)
  ) {
    return undefined;
  }

  analysis.visiting.add(binding);
  let kind = kindOfValue(unwrapExpression(binding.node.init), analysis);
  // A function can be given properties, as `format.prefix = 'a'` does.
  if (
    (kind === 'flat' && !binding.references.every((reference) => readsFlat(reference, analysis))) ||
    (kind !== undefined && isVisiblyChanged(binding, analysis.ctx))
  ) {
    kind = undefined;
  }
  analysis.visiting.delete(binding);
  analysis.kinds.set(binding, kind);
  return kind;
}

function kindOfValue(node: Node, analysis: Analysis): UnchangingKind | undefined {
  const value = unwrapExpression(node);
  const kindOf = (child: Node) => kindOfValue(child, analysis);
  const isPrimitive = (child: Node) => kindOf(child) === 'primitive';
  const kindOfHolder = (child: Node) => {
    const holder = unwrapExpression(child);
    const binding =
      holder.type === 'Identifier'
        ? analysis.ctx.editor.scopes.program.bindings.get(holder.name)
        : undefined;
    return binding ? kindOfBinding(binding, analysis) : kindOf(holder);
  };

  if (isFunction(value)) {
    return 'function';
  }

  switch (value.type) {
    case 'Literal':
      return 'regex' in value && value.regex ? undefined : 'primitive';

    case 'TemplateLiteral':
    case 'BinaryExpression':
      return 'primitive';

    case 'UnaryExpression':
      return value.operator === 'delete' ? undefined : 'primitive';

    case 'Identifier': {
      const binding = analysis.ctx.editor.scopes.program.bindings.get(value.name);
      if (!binding) {
        return PRIMITIVE_GLOBALS.has(value.name) ? 'primitive' : undefined;
      }
      // Another name for an array is a second way to change it.
      const kind = kindOfBinding(binding, analysis);
      return kind === 'flat' ? undefined : kind;
    }

    case 'MemberExpression': {
      const holder = kindOfHolder(value.object);
      return holder === 'flat' || holder === 'primitive' ? 'primitive' : undefined;
    }

    case 'CallExpression': {
      const callee = unwrapExpression(value.callee);
      const method = calledMethodName(callee);
      if (method === undefined || callee.type !== 'MemberExpression') {
        return undefined;
      }
      const receiver = kindOfHolder(callee.object);
      const methods =
        receiver === 'flat'
          ? ARRAY_PRIMITIVE_METHODS
          : receiver === 'primitive'
            ? PRIMITIVE_METHODS
            : undefined;
      return methods?.has(method) ? 'primitive' : undefined;
    }

    case 'ArrayExpression':
      return value.elements.every(
        (element) => element !== null && element.type !== 'SpreadElement' && isPrimitive(element)
      )
        ? 'flat'
        : undefined;

    case 'ObjectExpression':
      return value.properties.every(
        (property) =>
          property.type === 'Property' &&
          property.kind === 'init' &&
          !property.method &&
          !property.computed &&
          isPrimitive(property.value)
      )
        ? 'flat'
        : undefined;

    default:
      return undefined;
  }
}

// `lines` in `lines.items[0]`: the member read it starts, and how many members deep that goes.
function memberRead(reference: Node, { editor }: ReferenceContext) {
  let read = reference;
  let depth = 0;
  let parent = editor.parentOf(read);
  while (parent) {
    if (parent.type === 'MemberExpression' && parent.object === read) {
      depth += 1;
    } else if (!isWrapper(parent)) {
      break;
    }
    read = parent;
    parent = editor.parentOf(read);
  }
  return { read, depth, parent };
}

// `lines[0] = 'z'`, `[lines[0]] = ['z']`, `for (lines[0] of other)`, `lines.length += 1`.
function isWritten(read: Node, parent: Node, { editor }: ReferenceContext): boolean {
  switch (parent.type) {
    case 'AssignmentExpression':
    case 'AssignmentPattern':
    case 'ForInStatement':
    case 'ForOfStatement':
      return parent.left === read;
    case 'UpdateExpression':
    case 'ArrayPattern':
    case 'RestElement':
      return true;
    case 'UnaryExpression':
      return parent.operator === 'delete';
    case 'Property':
      // `{ [KEY]: value } = …` writes `value`; its computed key is only read.
      return parent.value === read && editor.parentOf(parent)?.type === 'ObjectPattern';
    default:
      return false;
  }
}

// The statements that export a binding count among its references.
const isExport = (node: Node): boolean => node.type.startsWith('Export');

function readsFlat(reference: Node, analysis: Analysis): boolean {
  if (reference.type !== 'Identifier') {
    return isExport(reference);
  }
  const { ctx } = analysis;
  const { read, depth, parent } = memberRead(reference, ctx);
  if (!parent) {
    return false;
  }
  if (isTypePosition(parent) || isExport(parent)) {
    return true;
  }
  if (isWritten(read, parent, ctx)) {
    return false;
  }

  if (parent.type === 'CallExpression' && parent.callee === read) {
    // `lines[0].trim()` calls a primitive's method; `lines.join()` has to be a method that reads.
    if (depth > 1) {
      return true;
    }
    const method = depth === 1 ? calledMethodName(read) : undefined;
    return (
      method !== undefined &&
      ARRAY_READING_METHODS.has(method) &&
      !handsOnArray(parent, ARRAY_PARAMETER[method])
    );
  }

  return depth > 0 || readsWhole(read, analysis);
}

function handsOnArray(call: Node & { type: 'CallExpression' }, position: number | undefined) {
  if (position === undefined) {
    return false;
  }
  const callback = call.arguments[0] && unwrapExpression(call.arguments[0]);
  return (
    callback !== undefined &&
    (!isFunction(callback) ||
      callback.params.length > position ||
      callback.params.some((param) => param.type === 'RestElement') ||
      // `function () { arguments[2].push('b'); }` reaches the array without naming a parameter.
      (callback.type !== 'ArrowFunctionExpression' && readsArguments(callback)))
  );
}

function readsArguments(fn: Node): boolean {
  let reads = false;
  walk(fn, (child) => {
    if (reads) {
      return false;
    }
    reads = child.type === 'Identifier' && child.name === 'arguments';
  });
  return reads;
}

function readsWhole(value: Node, analysis: Analysis): boolean {
  const { editor } = analysis.ctx;
  let node = value;

  for (;;) {
    const parent = editor.parentOf(node);
    if (!parent) {
      return false;
    }

    switch (parent.type) {
      case 'LogicalExpression':
        node = parent;
        continue;
      case 'ConditionalExpression':
        if (parent.test === node) {
          return true;
        }
        node = parent;
        continue;

      // A spread copies the primitives, wherever it is.
      case 'SpreadElement':
      case 'BinaryExpression':
      case 'UnaryExpression':
      case 'ExpressionStatement':
        return true;

      case 'IfStatement':
        return parent.test === node;

      case 'ForInStatement':
      case 'ForOfStatement':
        return parent.right === node;

      case 'MemberExpression':
        return parent.property === node && parent.computed;

      // A tag is a function that gets the value itself.
      case 'TemplateLiteral':
        return editor.parentOf(parent)?.type !== 'TaggedTemplateExpression';

      case 'CallExpression':
        return (
          parent.callee !== node &&
          READING_FUNCTIONS.has(textOf(parent.callee)) &&
          !declaresCallee(parent.callee, analysis.ctx)
        );

      case 'NewExpression':
        return (
          parent.callee !== node &&
          parent.callee.type === 'Identifier' &&
          COPYING_CONSTRUCTORS.has(parent.callee.name)
        );

      case 'ArrayExpression':
      case 'Property':
        return isStoryConfig(node, analysis);

      default:
        if (isWrapper(parent)) {
          node = parent;
          continue;
        }
        return false;
    }
  }
}

// Storybook only reads the configs it is given.
function isStoryConfig(value: Node, analysis: Analysis): boolean {
  const { editor } = analysis.ctx;
  let node = value;

  for (;;) {
    const parent = editor.parentOf(node);
    if (!parent) {
      return false;
    }

    switch (parent.type) {
      case 'ArrayExpression':
      case 'ObjectExpression':
      case 'SpreadElement':
        node = parent;
        continue;

      case 'Property':
        if (parent.value !== node || editor.parentOf(parent)?.type !== 'ObjectExpression') {
          return false;
        }
        node = parent;
        continue;

      case 'ExportDefaultDeclaration':
        return true;

      case 'CallExpression':
        // `preview.meta({ args: { lines } })`: what holds the result decides, as for a literal.
        if (parent.callee === node || !isFactoryCall(parent, analysis.ctx)) {
          return false;
        }
        node = parent;
        continue;

      case 'VariableDeclarator': {
        const holder =
          parent.init === node && parent.id.type === 'Identifier'
            ? editor.scopes.bindingOf(parent.id)
            : undefined;
        return (
          holder !== undefined &&
          holder.scope === editor.scopes.program &&
          holdsStoryConfig(holder, analysis)
        );
      }

      default:
        if (isWrapper(parent)) {
          node = parent;
          continue;
        }
        return false;
    }
  }
}

function holdsStoryConfig(binding: Binding, analysis: Analysis): boolean {
  if (!binding.constant) {
    return false;
  }
  if (analysis.visiting.has(binding)) {
    return true;
  }

  analysis.visiting.add(binding);
  const given = binding.references.every((reference) => {
    if (reference.type !== 'Identifier') {
      return isExport(reference);
    }
    const { read, depth, parent } = memberRead(reference, analysis.ctx);
    if (!parent) {
      return false;
    }
    if (isTypePosition(parent) || isExport(parent)) {
      return true;
    }
    if (parent.type === 'CallExpression' && parent.callee === read) {
      const method = depth === 1 ? calledMethodName(read) : undefined;
      // `meta.story()` copies the meta's args; `S.test()`, `S.play()` and `S.run()` run the story.
      return (
        method !== undefined &&
        ((STORY_RUNNING_METHODS.has(method) && isFactoryCall(constantInit(binding), analysis.ctx)) ||
          (isFactoryCall(parent, analysis.ctx) && isStoryConfig(parent, analysis)))
      );
    }
    return (
      (parent.type === 'SpreadElement' ||
        parent.type === 'ArrayExpression' ||
        parent.type === 'Property') &&
      isStoryConfig(read, analysis)
    );
  });
  analysis.visiting.delete(binding);
  return given;
}

// `preview.meta()` on the preview import, or `.story()` and `.extend()` on what one returns.
function isFactoryCall(
  call: Node | undefined,
  ctx: ReferenceContext,
  visiting: Set<Node> = new Set()
): boolean {
  const callee = call?.type === 'CallExpression' ? unwrapExpression(call.callee) : undefined;
  const method = callee && calledMethodName(callee);
  if (
    callee?.type !== 'MemberExpression' ||
    !FACTORY_METHODS.has(method ?? '') ||
    visiting.has(call!)
  ) {
    return false;
  }
  visiting.add(call!);
  let receiver = withoutTypeCalls(callee.object);
  while (receiver.type === 'Identifier') {
    const binding = ctx.editor.scopes.bindingOf(receiver);
    const { declaration } = binding ?? {};
    if (method === 'meta' && declaration?.type === 'ImportDeclaration') {
      return isValidPreviewPath(String(declaration.source.value));
    }
    const init = constantInit(binding);
    if (!init || visiting.has(binding!.node)) {
      return false;
    }
    visiting.add(binding!.node);
    receiver = withoutTypeCalls(unwrapExpression(init));
  }
  return method !== 'meta' && isFactoryCall(receiver, ctx, visiting);
}

const CHANGING_METHODS = new Set(
  'add clear copyWithin delete fill pop push reverse set shift sort splice unshift update'.split(
    ' '
  )
);

/** Whether a method changes what it is called on, as `push` does. */
export const isChangingMethod = (name: string | undefined): boolean =>
  name !== undefined && CHANGING_METHODS.has(name);

const CHANGING_FUNCTIONS = new Set(
  'Object.assign Object.defineProperties Object.defineProperty Object.setPrototypeOf Reflect.defineProperty Reflect.set Reflect.deleteProperty'.split(
    ' '
  )
);

/**
 * Whether the story file visibly changes a binding's value, directly or through an alias. Changes
 * made by a function the value is passed to go unseen. With `whileLoading`, only changes made while
 * the module runs count.
 *
 * @example `const lines = ['a']; lines.push('b')` → true
 */
export function isVisiblyChanged(
  binding: Binding,
  ctx: ReferenceContext,
  { whileLoading = false }: { whileLoading?: boolean } = {}
): boolean {
  return changes(binding, ctx, new Set(), whileLoading, false);
}

function changes(
  binding: Binding,
  ctx: ReferenceContext,
  visiting: Set<Binding>,
  whileLoading: boolean,
  alias: boolean
): boolean {
  if (visiting.has(binding)) {
    return false;
  }
  visiting.add(binding);
  const { editor } = ctx;
  return binding.references.some((reference) => {
    if (reference.type !== 'Identifier' || (whileLoading && !runsWhileLoading(reference, ctx))) {
      return false;
    }
    const { read, depth, parent } = memberRead(reference, ctx);
    if (!parent) {
      return false;
    }
    // `alias = other` gives the alias another value and leaves the one it shared alone.
    if (isWritten(read, parent, ctx)) {
      return !alias || depth > 0;
    }
    if (parent.type === 'CallExpression') {
      if (parent.callee === read) {
        const method = calledMethodName(read);
        // `lines[name]()` may call any method.
        const unknown = read.type === 'MemberExpression' && read.computed && method === undefined;
        return depth > 0 && (unknown || CHANGING_METHODS.has(method ?? ''));
      }
      return parent.arguments[0] === read && CHANGING_FUNCTIONS.has(textOf(parent.callee));
    }
    // `const alias = lines`: a change through `alias` changes `lines`.
    if (
      parent.type === 'VariableDeclarator' &&
      parent.init === read &&
      parent.id.type === 'Identifier'
    ) {
      const aliasBinding = editor.scopes.bindingOf(parent.id);
      return aliasBinding !== undefined && changes(aliasBinding, ctx, visiting, whileLoading, true);
    }
    return false;
  });
}

function runsWhileLoading(
  node: Node,
  ctx: ReferenceContext,
  visiting: Set<Node> = new Set()
): boolean {
  const fn = enclosingFunction(node, ctx);
  if (!fn) {
    return true;
  }
  // A recursive function runs as often as its first caller.
  if (visiting.has(fn)) {
    return false;
  }
  visiting.add(fn);
  const { editor } = ctx;
  let held: Node = fn;
  let holder = editor.parentOf(fn);
  while (holder && isWrapper(holder)) {
    held = holder;
    holder = editor.parentOf(held);
  }
  const id =
    fn.type === 'FunctionDeclaration'
      ? fn.id
      : holder?.type === 'VariableDeclarator' && holder.init === held
        ? holder.id
        : undefined;
  const binding = id?.type === 'Identifier' ? editor.scopes.bindingOf(id) : undefined;
  if (!binding) {
    // An unnamed function runs with the code around it, unless something keeps it for later: a
    // lifecycle hook, a timer, or a story holding it as a handler.
    return (
      !isKept(held, holder) && !isStoryHandler(held, ctx) && runsWhileLoading(fn, ctx, visiting)
    );
  }
  return binding.references.some((reference) => {
    let read = reference;
    let parent = editor.parentOf(read);
    while (parent && isWrapper(parent)) {
      read = parent;
      parent = editor.parentOf(read);
    }
    if (
      parent?.type === 'MemberExpression' &&
      /^(call|apply)$/.test(calledMethodName(parent) ?? '')
    ) {
      read = parent;
      parent = editor.parentOf(read);
    }
    if (parent?.type === 'CallExpression' || parent?.type === 'NewExpression') {
      return (
        (parent.callee === read || !isKept(read, parent)) && runsWhileLoading(parent, ctx, visiting)
      );
    }
    if (
      parent?.type === 'ReturnStatement' ||
      (parent && isFunction(parent) && parent.body === read)
    ) {
      return runsWhileLoading(parent, ctx, visiting);
    }
    // Run by Storybook before render, as `beforeEach: setup` is.
    return runsBeforeRender(reference, ctx);
  });
}

// Functions that keep the function they are given rather than call it while the module loads.
const KEEPING_FUNCTIONS = new Set([...DEFERRING_FUNCTIONS, 'action', 'fn', 'jest.fn', 'vi.fn']);

const KEEPING_METHODS = new Set(['addEventListener', 'removeEventListener']);

function isKept(value: Node, parent: Node | null): boolean {
  return (
    (parent?.type === 'CallExpression' || parent?.type === 'NewExpression') &&
    parent.callee !== value &&
    (KEEPING_FUNCTIONS.has(textOf(parent.callee)) ||
      KEEPING_METHODS.has(calledMethodName(parent.callee) ?? ''))
  );
}

// `args: { onClick: () => count++ }`: a handler a story holds outside its before-render keys.
function isStoryHandler(value: Node, ctx: ReferenceContext): boolean {
  const { editor } = ctx;
  let node = value;
  let parent = editor.parentOf(node);
  let held = false;
  while (parent) {
    if (parent.type === 'Property' && parent.value === node) {
      if (BEFORE_RENDER_KEYS.has(staticKey(parent) ?? '')) {
        return false;
      }
      held = true;
    } else if (
      parent.type !== 'ObjectExpression' &&
      parent.type !== 'ArrayExpression' &&
      !isWrapper(parent)
    ) {
      break;
    }
    node = parent;
    parent = editor.parentOf(node);
  }
  if (!held || !parent) {
    return false;
  }
  if (parent.type === 'ExportDefaultDeclaration') {
    return true;
  }
  if (parent.type === 'VariableDeclarator') {
    return editor.parentOf(editor.parentOf(parent) ?? parent)?.type === 'ExportNamedDeclaration';
  }
  return (
    parent.type === 'CallExpression' &&
    parent.callee !== node &&
    (textOf(parent.callee) === 'defineMeta' || isFactoryCall(parent, ctx))
  );
}

const BEFORE_RENDER_KEYS = new Set(['beforeAll', 'beforeEach', 'decorators', 'loaders', 'render']);

function runsBeforeRender(node: Node, { editor }: ReferenceContext): boolean {
  let current = node;
  let parent = editor.parentOf(current);
  while (parent?.type === 'ArrayExpression' || (parent && isWrapper(parent))) {
    current = parent;
    parent = editor.parentOf(current);
  }
  return (
    parent?.type === 'Property' &&
    parent.value === current &&
    BEFORE_RENDER_KEYS.has(staticKey(parent) ?? '')
  );
}

function enclosingFunction(node: Node, { editor }: ReferenceContext): Node | undefined {
  for (let current = editor.parentOf(node); current; current = editor.parentOf(current)) {
    if (isFunction(current)) {
      return current;
    }
  }
  return undefined;
}
