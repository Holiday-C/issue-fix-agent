#!/usr/bin/env node

import { runCli } from "./cli.js";

const controller = new AbortController();
const cancel = (): void => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

runCli(
  process.argv.slice(2),
  { stdout: process.stdout, stderr: process.stderr },
  undefined,
  controller.signal,
)
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch(() => {
    process.stderr.write("error: unexpected CLI failure\n");
    process.exitCode = 2;
  })
  .finally(() => {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  });
