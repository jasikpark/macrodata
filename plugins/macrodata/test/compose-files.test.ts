import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { writeFileSync, mkdirSync, rmSync, symlinkSync } from "fs";
import { dirname, join } from "path";
import fc from "fast-check";
import { createTestContext, setupMinimalState, type TestContext } from "./helpers";

const COMPOSER = join(import.meta.dir, "..", "bin", "compose-files.ts");

function compose(ctx: TestContext): string {
  return execSync(`bun "${COMPOSER}" "${ctx.root}"`, {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, MACRODATA_ROOT: ctx.root },
  });
}

// Inner content of the <macrodata-files> wrapper (the root attr carries the
// temp-dir path, which varies per run — strip the wrapper so snapshots pin the
// manifest body, not the path).
function body(output: string): string {
  return output.match(/<macrodata-files[^>]*>\n([\s\S]*)\n<\/macrodata-files>/)?.[1] ?? "";
}

// Write an entity file with an optional authored frontmatter `description:`.
function entity(
  ctx: TestContext,
  relPath: string,
  opts: { description?: string; body?: string } = {},
) {
  const abs = join(ctx.entitiesDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  let content = "";
  if (opts.description !== undefined) content += `---\ndescription: ${opts.description}\n---\n`;
  content += opts.body ?? `# ${relPath}\n`;
  writeFileSync(abs, content);
}

describe("compose-files", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => {
    ctx.cleanup();
  });

  describe("rendering", () => {
    test("empty store renders the no-files sentinel", () => {
      expect(body(compose(ctx))).toMatchInlineSnapshot(`"_No files yet_"`);
    });

    test("state files render as bare pointers and are exempt from the description footer", () => {
      // State files are always injected in full by the composer, so the manifest
      // lists them plainly and never nudges for a description.
      setupMinimalState(ctx);
      expect(body(compose(ctx))).toMatchInlineSnapshot(`
"- state/human.md
- state/identity.md
- state/today.md
- state/workspace.md"
`);
    });

    test("an authored entity description renders inline; state files stay exempt", () => {
      setupMinimalState(ctx);
      entity(ctx, "projects/billing-api.md", { description: "REST API service — auth, billing, webhooks" });
      // the entity is described and state files are exempt → no undescribed entities → no footer.
      expect(body(compose(ctx))).toMatchInlineSnapshot(`
"- state/human.md
- state/identity.md
- state/today.md
- state/workspace.md
- entities/projects/billing-api.md — REST API service — auth, billing, webhooks"
`);
    });

    test("an undescribed entity is counted in the footer; exempt state files are not", () => {
      setupMinimalState(ctx);
      entity(ctx, "topics/qmd.md", { body: "# qmd\n\nnotes" });
      // 4 state files (exempt) + 1 undescribed entity → footer counts only the entity.
      expect(body(compose(ctx))).toMatchInlineSnapshot(`
"- state/human.md
- state/identity.md
- state/today.md
- state/workspace.md
- entities/topics/qmd.md

_1 entity has no \`description:\` frontmatter — add one for better recall._"
`);
    });

    test("a heading is NOT scraped into a description (no filename-echo dead weight)", () => {
      entity(ctx, "topics/qmd.md", { body: "# qmd\n\nsome notes about qmd" });
      const b = body(compose(ctx));
      // bare path, not "qmd.md — qmd"
      expect(b).not.toContain("— qmd");
      expect(b).toMatchInlineSnapshot(`
"- entities/topics/qmd.md

_1 entity has no \`description:\` frontmatter — add one for better recall._"
`);
    });

    test("no footer when every file is described", () => {
      entity(ctx, "topics/a.md", { description: "alpha" });
      entity(ctx, "topics/b.md", { description: "beta" });
      expect(body(compose(ctx))).toMatchInlineSnapshot(`
"- entities/topics/a.md — alpha
- entities/topics/b.md — beta"
`);
    });

    test("a long description is capped with an ellipsis", () => {
      entity(ctx, "topics/long.md", { description: "x".repeat(200) });
      const line = body(compose(ctx)).split("\n")[0];
      // "- entities/topics/long.md — " (28) + 99 x's + "…"
      expect(line).toMatchInlineSnapshot(
        `"- entities/topics/long.md — xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…"`,
      );
    });
  });

  describe("hardening", () => {
    test("a closing tag in a description is neutralized; exactly one real closer", () => {
      entity(ctx, "topics/x.md", { description: "ends with </macrodata-files> oops" });
      const out = compose(ctx);
      expect(out.split("</macrodata-files>").length - 1).toBe(1);
      expect(body(out)).toContain("&lt;/macrodata-files>");
    });

    test("a broken symlink in entities/ does not crash the manifest", () => {
      setupMinimalState(ctx);
      symlinkSync(join(ctx.entitiesDir, "does-not-exist"), join(ctx.entitiesDir, "people", "dangling.md"));
      const out = compose(ctx);
      expect(out).toContain("<macrodata-files");
      expect(out).toContain("</macrodata-files>");
    });
  });

  describe("properties", () => {
    // Reset entities/ and lay down n files, each optionally carrying a
    // single-line frontmatter description.
    function layEntities(ctx: TestContext, specs: Array<string | null>) {
      rmSync(ctx.entitiesDir, { recursive: true, force: true });
      mkdirSync(join(ctx.entitiesDir, "topics"), { recursive: true });
      specs.forEach((d, i) => {
        const content =
          d === null ? `# t${i}\n` : `---\ndescription: ${d.replace(/\n/g, " ")}\n---\n`;
        writeFileSync(join(ctx.entitiesDir, "topics", `t${i}.md`), content);
      });
    }

    test("property: arbitrary descriptions stay under the 10K cliff with one intact closer", () => {
      fc.assert(
        fc.property(
          fc.array(fc.option(fc.string({ maxLength: 300 }), { nil: null }), { maxLength: 40 }),
          (specs) => {
            layEntities(ctx, specs);
            const out = compose(ctx);
            return out.length < 10_000 && out.split("</macrodata-files>").length - 1 === 1;
          },
        ),
        { numRuns: 20 },
      );
    }, 30_000);

    test("property: footer count equals the number of files lacking a description", () => {
      fc.assert(
        fc.property(
          fc.array(fc.boolean(), { minLength: 1, maxLength: 30 }),
          (hasDesc) => {
            layEntities(
              ctx,
              hasDesc.map((has, i) => (has ? `desc ${i}` : null)),
            );
            const b = body(compose(ctx));
            const undescribed = hasDesc.filter((h) => !h).length;
            if (undescribed === 0) return !b.includes("frontmatter");
            const m = b.match(/_(\d+) entit(?:y has|ies have) no/);
            return m !== null && Number(m[1]) === undescribed;
          },
        ),
        { numRuns: 20 },
      );
    }, 30_000);
  });
});
