import { expect, test } from "bun:test";
import { join } from "node:path";

// Each harness imports the real server, which reads REPO_DIR once; it runs in its own process.
for (const harness of ["selfIntro.harness.ts"]) {
  test(`server routes: ${harness}`, async () => {
    const proc = Bun.spawn([process.execPath, "test", `./${join("tests/routes", harness)}`], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, `${out}${err}`.slice(-4000)).toBe(0);
  }, 130_000);
}
