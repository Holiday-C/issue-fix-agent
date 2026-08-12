const title = process.argv[2] ?? "";
const conventionalCommit =
  /^(feat|fix|docs|test|refactor|perf|build|ci|chore|revert)(\([a-z0-9][a-z0-9-]*\))?!?: [a-z0-9].{0,71}$/;

if (!conventionalCommit.test(title)) {
  process.stderr.write(
    [
      "PR title must use Conventional Commit format.",
      "Example: feat(tools): add bounded file reader",
      `Received: ${JSON.stringify(title)}`,
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
}
