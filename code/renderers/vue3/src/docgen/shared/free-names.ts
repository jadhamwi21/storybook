import {
  type ESTree as E,
  type ESTreeNode as Node,
  unwrapExpression,
} from 'storybook/internal/csf-tools';

import { collectPatternNames } from './classify-value.ts';

// The names the setup statements a snippet forwards read from the scope they are written in.

/**
 * Collects every free identifier a statement references, or reports `false` for syntax this
 * grammar does not model. Unknown shapes bail rather than pass through unchecked.
 */
export function collectFreeIdentifiers(
  node: E.Statement,
  scope: ReadonlySet<string>,
  free: Set<string>
): boolean {
  if (node.type === 'VariableDeclaration') {
    // Declared names are already in scope. A pattern default has to resolve against that scope
    // alone, see `collectPatternNames`, so it never adds a free name.
    return node.declarations.every(
      (declaration) => !declaration.init || collectFreeExpression(declaration.init, scope, free)
    );
  }
  if (node.type === 'ExpressionStatement') {
    return collectFreeExpression(node.expression, scope, free);
  }
  if (node.type === 'ReturnStatement') {
    return !node.argument || collectFreeExpression(node.argument, scope, free);
  }
  return false;
}

// Collects every free identifier an expression references; `false` for syntax it does not model.
function collectFreeExpression(node: Node, scope: ReadonlySet<string>, free: Set<string>): boolean {
  if (node.type === 'SpreadElement') {
    return collectFreeExpression(node.argument, scope, free);
  }

  const value = unwrapExpression(node);
  const collect = (child: Node): boolean => collectFreeExpression(child, scope, free);

  switch (value.type) {
    case 'Literal':
      return true;

    case 'Identifier':
      if (!scope.has(value.name)) {
        free.add(value.name);
      }
      return true;

    case 'TemplateLiteral':
      return value.expressions.every(collect);

    case 'ArrayExpression':
      return value.elements.every((element) => element === null || collect(element));

    case 'ObjectExpression':
      return value.properties.every((property) => {
        if (property.type === 'SpreadElement') {
          return collect(property.argument);
        }
        if (!property.method && property.kind === 'init') {
          return (!property.computed || collect(property.key)) && collect(property.value);
        }
        return collectFreeFunction(property.value as E.Function, scope, free);
      });

    case 'ChainExpression':
      return collect(value.expression);

    case 'MemberExpression':
      return collect(value.object) && (!value.computed || collect(value.property));

    case 'CallExpression':
    case 'NewExpression':
      return collect(value.callee) && value.arguments.every(collect);

    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return collectFreeFunction(value, scope, free);

    case 'UnaryExpression':
    case 'UpdateExpression':
      return collect(value.argument);

    case 'BinaryExpression':
      return collect(value.left) && collect(value.right);

    case 'LogicalExpression':
      return collect(value.left) && collect(value.right);

    case 'ConditionalExpression':
      return collect(value.test) && collect(value.consequent) && collect(value.alternate);

    case 'AssignmentExpression':
      return collect(value.left) && collect(value.right);

    case 'SequenceExpression':
      return value.expressions.every(collect);

    default:
      return false;
  }
}

function collectFreeFunction(
  fn: E.ArrowFunctionExpression | E.Function,
  scope: ReadonlySet<string>,
  free: Set<string>
): boolean {
  const childScope = new Set(scope);
  if (!fn.params.every((param) => collectPatternNames(param, childScope))) {
    return false;
  }
  if (fn.type === 'FunctionExpression' && fn.id) {
    childScope.add(fn.id.name);
  }

  const body = fn.body;
  if (!body) {
    return false;
  }
  if (body.type !== 'BlockStatement') {
    return collectFreeExpression(body, childScope, free);
  }

  // Inner declarations scope over the whole body, approximating function-scope hoisting.
  for (const statement of body.body) {
    if (statement.type === 'VariableDeclaration') {
      const named = statement.declarations.every((declaration) =>
        collectPatternNames(declaration.id, childScope)
      );
      if (!named) {
        return false;
      }
    }
  }
  return body.body.every((statement) => collectFreeIdentifiers(statement, childScope, free));
}
