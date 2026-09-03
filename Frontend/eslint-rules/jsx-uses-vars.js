/**
 * @fileoverview Local flat-config plugin providing `local/jsx-uses-vars`.
 *
 * WHY THIS EXISTS
 * ----------------
 * Core ESLint's `no-unused-vars` categorises a function parameter — including a
 * destructured-and-renamed one, e.g. `({ icon: Icon }) => <Icon />` — under its
 * internal "args" bucket, not "vars". This repo's `no-unused-vars` config uses
 * `varsIgnorePattern: "^[A-Z_]"`, which only exempts the "vars" bucket, so it
 * never reaches an args-bucket binding. Worse, scope analysis does not treat a
 * JSX tag-position read (`<Icon />`) as a "use" of the `Icon` binding at all —
 * JSX is not part of core ESTree, so core ESLint's reference-counting pass
 * never visits `JSXOpeningElement.name`. Net effect: any destructured-rename
 * icon param (`({ icon: Icon }) => <Icon />`) false-positives as unused even
 * though it renders on screen.
 *
 * WHAT THIS REPLACES
 * -------------------
 * `eslint-plugin-react`'s `react/jsx-uses-vars` rule fixed this by walking JSX
 * element names and calling `sourceCode.markVariableAsUsed(name, node)` for
 * every identifier referenced in JSX tag position. That one rule was the
 * entire reason the plugin was a devDependency here — every other rule in the
 * plugin (`react/prop-types`, `react/react-in-jsx-scope`, etc.) was left
 * disabled because they don't apply to this React 19 automatic-JSX-runtime
 * codebase. Depending on the whole package for one ~30-line rule pulled in 18
 * direct dependencies (mostly es-shims — array.prototype.tosorted,
 * es-iterator-helpers, string.prototype.matchall, object.fromentries, …) and
 * roughly 97 packages transitively: a large supply-chain surface, installed
 * on every dev machine and executed in CI, for a rule whose entire job is
 * "mark this identifier as used." This file reimplements just that rule as a
 * local ESLint flat-config plugin so `eslint-plugin-react` can be removed
 * entirely.
 *
 * Logic ported from `eslint-plugin-react/lib/rules/jsx-uses-vars.js` (v7.37.5)
 * plus `eslint-plugin-react/lib/util/eslint.js#markVariableAsUsed`, with all
 * three JSX element-name shapes handled explicitly (see below). Registered in
 * `eslint.config.js` under the `local` plugin namespace as `local/jsx-uses-vars`
 * — renamed off `react/jsx-uses-vars` deliberately, since `eslint-plugin-react`
 * is no longer installed and keeping the `react/` prefix would misleadingly
 * imply it still is. See CLAUDE.md "13. Linting & Tooling" for the full story.
 */

/**
 * A JSX element name is one of three ESTree/estree-jsx node shapes
 * (see acorn-jsx, which this project's parser — espree — uses under the hood):
 *
 *   <Icon />         → JSXIdentifier            { name: "Icon" }
 *   <Foo.Bar />      → JSXMemberExpression       { object, property }
 *   <ns:tag />       → JSXNamespacedName         { namespace, name }
 *
 * Walks a (possibly nested) JSXMemberExpression down to its root object and
 * returns that root's name. `<Foo.Bar />` and `<Foo.Bar.Baz />` both
 * reference the single variable `Foo` — only the root object is an actual
 * binding; `.Bar` / `.Baz` are property accesses on it, not separate
 * variables, so only the root is ever passed to markVariableAsUsed.
 *
 * @param {import("estree").Node} node A JSXMemberExpression node.
 * @returns {string} The root identifier's name.
 */
function getRootMemberName(node) {
    let current = node;
    while (current.type === "JSXMemberExpression") {
        current = current.object;
    }
    return current.name;
}

// Intrinsic host tags (<div />, <span />, <button />) start with a lowercase
// letter by JSX convention and compile to string literals, not identifier
// references — there is no `div` variable to mark as used. This mirrors
// eslint-plugin-react's own `isTagName` check (isTagNameRe = /^[a-z]/).
const isIntrinsicTagName = (name) => /^[a-z]/.test(name);

/** @type {import("eslint").Rule.RuleModule} */
const jsxUsesVarsRule = {
    meta: {
        type: "problem",
        docs: {
            description: "Mark identifiers referenced in JSX tag position as used, so core no-unused-vars does not false-positive on destructured-rename or plain JSX-component params.",
        },
        schema: [],
    },
    create(context) {
        // Only JSXOpeningElement is visited — JSXClosingElement (the `</Icon>`
        // half of `<Icon>...</Icon>`) carries the identical name node and would
        // resolve to the same binding, so visiting it too would be a redundant
        // second markVariableAsUsed call for every non-self-closing element,
        // not a correctness gap. Self-closing tags (`<Icon />`, the dominant
        // shape in this codebase) have no closing element at all.
        return {
            JSXOpeningElement(node) {
                const nameNode = node.name;
                let name;

                switch (nameNode.type) {
                    case "JSXIdentifier":
                        // <Icon /> — plain or destructured-rename component reference.
                        name = nameNode.name;
                        if (isIntrinsicTagName(name)) {
                            // Deliberate skip, not a fallthrough: an unresolved
                            // name passed to markVariableAsUsed is harmless (it
                            // just returns false when no matching binding is
                            // found in scope), but intrinsic tags are never
                            // variable references in the first place, so we
                            // don't even attempt the lookup.
                            return;
                        }
                        break;

                    case "JSXMemberExpression":
                        // <Foo.Bar /> or <Foo.Bar.Baz /> — the root object
                        // (`Foo`) is the variable; walk down to it.
                        name = getRootMemberName(nameNode);
                        break;

                    case "JSXNamespacedName":
                        // <ns:tag /> — XML-style namespaced element name
                        // (`namespace` + `name`, both JSXIdentifiers, e.g.
                        // `<svg:rect>` in namespace-aware JSX dialects). Neither
                        // half resolves to a JS binding — this is markup syntax,
                        // not a variable reference — so there is nothing to mark
                        // as used. eslint-plugin-react's own rule takes the same
                        // early-return on this shape. This codebase has zero
                        // namespaced JSX tags (verified via grep across src/) and
                        // React does not render them meaningfully; documented
                        // here rather than silently falling through so a future
                        // reader isn't left guessing whether the omission is a
                        // bug.
                        return;

                    default:
                        return;
                }

                // Passing `node` (not the default `context.sourceCode.ast`) is
                // required, not cosmetic: SourceCode#markVariableAsUsed resolves
                // the scope containing the given node and then walks upward
                // through `scope.upper` looking for a matching binding. A
                // destructured-rename param like `({ icon: Icon }) => <Icon />`
                // declares `Icon` in the arrow function's parameter scope, which
                // sits *below* module scope. Passing no node (or the Program
                // node) would resolve the module/global scope and only walk
                // further outward from there, never finding — and never
                // marking — a binding declared in a nested function scope.
                context.sourceCode.markVariableAsUsed(name, node);
            },
        };
    },
};

/** @type {import("eslint").ESLint.Plugin} */
const localPlugin = {
    rules: {
        "jsx-uses-vars": jsxUsesVarsRule,
    },
};

export default localPlugin;
