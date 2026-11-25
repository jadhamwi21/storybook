import {
  type Node,
  isFunction,
  isTSWrapper,
  textOf,
  unwrapExpression,
  walk,
} from '../estree/ast.ts';
import type { ReferenceContext } from './resolve-members.ts';
import { unchangingKind } from './unchanging-binding.ts';

/** A constant the story file declares at module level, which a snippet can declare again. */
export interface StoryConstant {
  /** Its value as written, keeping `as const` and `satisfies`. */
  value: Node;
  /** The constants this value reads, declared before it. */
  uses: string[];
  /** Its position in the story file, for ordering. */
  start: number;
}

/** The story-file constants a story's args read. */
export interface StoryConstants {
  /** The declaration of each constant in `names`, by name. */
  declarations: ReadonlyMap<string, StoryConstant>;
  /** Every constant name the snippet may declare, which it must keep free. */
  names: ReadonlySet<string>;
  /** The constants a value reads; none if it also reads something the snippet cannot declare. */
  readBy: (value: Node) => ReadonlySet<string>;
  /** The constant whose declared value this is, so the snippet can print its name instead. */
  declaredAs: (value: Node) => string | undefined;
}

const NO_NAMES: ReadonlySet<string> = new Set();

export const NO_STORY_CONSTANTS: StoryConstants = {
  declarations: new Map(),
  names: NO_NAMES,
  readBy: () => NO_NAMES,
  declaredAs: () => undefined,
};

/**
 * The unchanging module-level constants a story's args read, so its snippet can declare them. Names
 * in `taken` and constants that cannot be declared again stay in `locals` for the caller to report.
 *
 * @example `const lines = ['a']; args: { count: lines.length }` → declares `lines`
 */
export function collectStoryConstants(
  args: Record<string, Node>,
  ctx: ReferenceContext,
  taken: ReadonlySet<string> = NO_NAMES
): StoryConstants {
  const declarations = new Map<string, StoryConstant>();
  const values = new WeakMap<Node, string>();
  const rejected = new Set<string>();
  const { editor } = ctx;
  const { program } = editor.scopes;

  // A node copied from another module has no parent in this file.
  const owned = (node: Node): boolean => editor.parentOf(node) !== null;

  const readNames = (node: Node): string[] => {
    const names = new Set<string>();
    walk(node, (child) => {
      if (
        (child.type === 'Identifier' || child.type === 'JSXIdentifier') &&
        editor.scopes.bindingOf(child)?.scope === program
      ) {
        names.add(child.name);
      }
    });
    return [...names];
  };

  const declarable = (name: string, visiting: Set<string>): boolean => {
    if (declarations.has(name)) {
      return true;
    }
    // A constant that reads itself cannot be ordered.
    if (rejected.has(name) || visiting.has(name) || taken.has(name)) {
      return false;
    }

    const binding = program.bindings.get(name);
    const declarator =
      binding?.node.type === 'VariableDeclarator' && unchangingKind(binding, ctx) !== undefined
        ? binding.node
        : undefined;
    const init = declarator?.init ? unwrapExpression(declarator.init) : undefined;
    if (!declarator?.init || !init || namesStoryFileType(declarator.init, ctx)) {
      rejected.add(name);
      return false;
    }

    const uses = readNames(init);
    visiting.add(name);
    const readable = uses.every((used) => declarable(used, visiting));
    visiting.delete(name);
    if (!readable) {
      rejected.add(name);
      return false;
    }

    // `<T>value` does not parse in a TSX snippet.
    const value = hasAngleBracketAssertion(declarator.init) ? init : declarator.init;
    if (breaksJsx(value, ctx.filePath.endsWith('.tsx'))) {
      rejected.add(name);
      return false;
    }
    declarations.set(name, {
      value,
      uses,
      start: declarator.start,
    });
    values.set(init, name);
    return true;
  };

  // All or nothing: one name the snippet cannot declare drops the whole value.
  const reads = (value: Node): ReadonlySet<string> => {
    const unwrapped = unwrapExpression(value);
    if (!owned(unwrapped) || namesStoryFileType(value, ctx)) {
      return NO_NAMES;
    }
    const names = readNames(unwrapped);
    return names.every((name) => declarable(name, new Set())) ? new Set(names) : NO_NAMES;
  };

  const names = new Set<string>();
  const name = (constant: string): void => {
    if (!names.has(constant)) {
      names.add(constant);
      declarations.get(constant)?.uses.forEach(name);
    }
  };
  for (const value of Object.values(args)) {
    reads(value).forEach(name);
  }

  return {
    declarations: new Map([...names].map((constant) => [constant, declarations.get(constant)!])),
    names,
    readBy: (value) => {
      const read = reads(value);
      return [...read].every((constant) => names.has(constant)) ? read : NO_NAMES;
    },
    declaredAs: (value) => {
      const constant = values.get(unwrapExpression(value));
      return constant !== undefined && names.has(constant) ? constant : undefined;
    },
  };
}

// A type the story file declares does not exist where the snippet lands.
function namesStoryFileType(node: Node, { editor }: ReferenceContext): boolean {
  const { tsDeclarationNames, program } = editor.scopes;
  let named = false;
  walk(node, (child) => {
    if (named) {
      return false;
    }
    // `import('./types').Item` may not resolve where the snippet lands.
    if (child.type === 'TSImportType') {
      named = true;
    } else if (child.type === 'TSTypeReference' || child.type === 'TSTypeQuery') {
      // `Item` in `Item`, `Shapes` in `Shapes.Item`, `config` in `typeof config`.
      const root = /^[\w$]+/.exec(
        textOf(child.type === 'TSTypeReference' ? child.typeName : child.exprName)
      )?.[0];
      named = root !== undefined && (tsDeclarationNames.has(root) || program.bindings.has(root));
    }
  });
  return named;
}

// `<T>value`, and `<T>(value: T) => value` outside a `.tsx` file, read as JSX tags in a TSX snippet.
function breaksJsx(node: Node, tsx: boolean): boolean {
  let found = false;
  walk(node, (child) => {
    found ||=
      child.type === 'TSTypeAssertion' ||
      (!tsx &&
        isFunction(child) &&
        Boolean((child as { typeParameters?: unknown }).typeParameters));
    return !found;
  });
  return found;
}

function hasAngleBracketAssertion(node: Node): boolean {
  let current: Node = node;
  while (isTSWrapper(current) || current.type === 'ParenthesizedExpression') {
    if (current.type === 'TSTypeAssertion') {
      return true;
    }
    current = (current as Node & { expression: Node }).expression;
  }
  return false;
}
