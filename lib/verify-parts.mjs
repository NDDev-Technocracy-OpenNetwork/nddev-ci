// The parts of a full check: the dependencies of the project's `verify` recipe, read from
// `just --dump --dump-format json`. Each part runs as its own job; a part that another part needs,
// directly or through its own dependencies, runs in that part's job, so nothing runs twice and no
// declared order is lost. A `verify` that is more than a list of dependencies runs whole.
const refuse = (message) => { throw new Error(message); };
const whole = (reason) => ({split: false, reason, parts: []});

// The recipe a dependency names, resolved against the module it is written in.
function resolve(dump, scope, name) {
  const parts = [...scope, ...name.split("::")];
  let module = dump;
  for (const step of parts.slice(0, -1)) {
    module = module?.modules?.[step];
    if (!module) return null;
  }
  const recipe = module?.recipes?.[parts.at(-1)];
  return recipe ? {key: parts.join("::"), scope: parts.slice(0, -1), recipe} : null;
}

// Every recipe a recipe runs before its own body, through any depth of dependencies.
function closure(dump, start) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const current = stack.pop();
    for (const dependency of current.recipe.dependencies ?? []) {
      const next = resolve(dump, current.scope, dependency.recipe);
      if (!next) refuse(`The justfile names an unknown recipe: ${dependency.recipe}`);
      if (!seen.has(next.key)) { seen.add(next.key); stack.push(next); }
    }
  }
  return seen;
}

/** The parts of `verify`, or a reason to run it whole. */
export function plan(dump) {
  const verify = dump?.recipes?.verify;
  if (!verify) return whole("the justfile has no verify recipe");
  const dependencies = verify.dependencies ?? [];
  if ((verify.body ?? []).length) return whole("verify has commands of its own");
  if ((verify.parameters ?? []).length) return whole("verify takes parameters");
  if (verify.priors !== dependencies.length) return whole("verify runs recipes after its own body");
  if (dependencies.length < 2) return whole("verify has fewer than two parts");
  const steps = dependencies.map((dependency) => {
    const target = resolve(dump, [], dependency.recipe);
    if (!target) refuse(`verify names an unknown recipe: ${dependency.recipe}`);
    if ((dependency.arguments ?? []).some((argument) => typeof argument !== "string" || argument.startsWith("-"))) return null;
    if ((target.recipe.parameters ?? []).some((parameter) => parameter.kind !== "singular")) return null;
    return {key: target.key, argv: [target.key, ...dependency.arguments], needs: closure(dump, target)};
  });
  if (steps.includes(null)) return whole("a part takes a computed, variadic or option-like argument");
  if (new Set(steps.map((step) => step.key)).size !== steps.length) return whole("verify names a recipe twice");
  // A part another part needs joins that part's job; joined parts stay in verify's order.
  const group = steps.map((_, index) => index);
  const root = (index) => group[index] === index ? index : (group[index] = root(group[index]));
  steps.forEach((step, index) => steps.forEach((other, at) => {
    if (index !== at && step.needs.has(other.key)) group[root(at)] = root(index);
  }));
  const jobs = new Map();
  steps.forEach((step, index) => {
    const id = root(index);
    if (!jobs.has(id)) jobs.set(id, []);
    jobs.get(id).push(step);
  });
  if (jobs.size < 2) return whole("verify's parts all need each other");
  const parts = [...jobs.values()].sort((a, b) => steps.indexOf(a[0]) - steps.indexOf(b[0])).map((members) => ({
    name: members.map((member) => member.key).join(" + "),
    group: members[0].key.replace(/[^A-Za-z0-9_-]/g, "-"),
    argv: members.flatMap((member) => member.argv),
  }));
  return {split: true, reason: `verify runs as ${parts.length} parts`, parts};
}

/** The jobs of the full check: one job named `full check` for a whole verify, or one job a part. */
export function matrix(result) {
  if (!result.split) return [{label: "full check", group: "verify", argv: ["verify"]}];
  return result.parts.map((part) => ({label: `verify: ${part.name}`, group: part.group, argv: part.argv}));
}
