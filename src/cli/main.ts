#!/usr/bin/env node

import { runCli } from "./cli.js";

runCli(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr })
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch(() => {
    process.stderr.write("error: unexpected CLI failure\n");
    process.exitCode = 2;
  });
