import { readFile } from "node:fs/promises";
import * as csstree from "css-tree";
const ast = csstree.parse(
  await readFile(new URL("style.css", import.meta.url), "utf8"),
  { positions: true },
);
csstree.walk(ast, {
  visit: "Declaration",
  enter(node) {
    const result = csstree.lexer.matchProperty(node.property, node.value);
    if (result.error) throw result.error;
  },
});
