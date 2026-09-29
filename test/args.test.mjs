import assert from "node:assert/strict";
import test from "node:test";
import { helpText, parseArgs } from "../dist/codex-args.mjs";
import { CliUsageError } from "../dist/types.mjs";

test("引数なしの既定値は one-shot、interval 180秒、popup通知、timeout 15秒", () => {
  const parsed = parseArgs([]);
  assert.deepEqual(parsed, {
    kind: "run",
    options: {
      watch: false,
      intervalSeconds: 180,
      json: false,
      notifyBelow: undefined,
      notifyEvery: undefined,
      notifyApiError: false,
      notifyMethod: "popup",
      notifyExclude: [],
      codexBin: "codex",
      timeoutSeconds: 15,
    },
  });
  assert.equal(parsed.options.filter, undefined);
});

test("filter は指定した文字列を保持する", () => {
  assert.equal(parseArgs(["--filter", "codex / primary"]).options.filter, "codex / primary");
});

test("notify-exclude は複数指定を順に保持する", () => {
  assert.deepEqual(
    parseArgs(["--notify-exclude", "codex / primary", "--notify-exclude", "secondary"]).options.notifyExclude,
    ["codex / primary", "secondary"],
  );
});

test("interval は60以上の整数を受理する", () => {
  const parsed = parseArgs(["--watch", "--interval", "60", "--json"]);
  assert.equal(parsed.kind, "run");
  assert.equal(parsed.options.intervalSeconds, 60);
  assert.equal(parsed.options.watch, true);
  assert.equal(parsed.options.json, true);
});

for (const value of ["59", "1.5", "abc", "-60", "Infinity"]) {
  test(`interval の不正値 ${value} を拒否する`, () => {
    assert.throws(() => parseArgs(["--interval", value]), CliUsageError);
  });
}

test("timeout、通知閾値、codex-bin を解釈する", () => {
  assert.deepEqual(parseArgs(["--timeout", "1", "--notify-below", "0", "--codex-bin", "/tmp/fake-codex"]), {
    kind: "run",
    options: {
      watch: false,
      intervalSeconds: 180,
      json: false,
      notifyBelow: 0,
      notifyEvery: undefined,
      notifyApiError: false,
      notifyMethod: "popup",
      notifyExclude: [],
      codexBin: "/tmp/fake-codex",
      timeoutSeconds: 1,
    },
  });
  assert.equal(parseArgs(["--notify-below", "100"]).options.notifyBelow, 100);
});

test("notify-every は1〜99の整数を解釈し、notify-belowと併用できる", () => {
  assert.equal(parseArgs(["--notify-every", "1"]).options.notifyEvery, 1);
  assert.equal(parseArgs(["--notify-every", "99"]).options.notifyEvery, 99);

  const options = parseArgs(["--notify-below", "30", "--notify-every", "20"]).options;
  assert.equal(options.notifyBelow, 30);
  assert.equal(options.notifyEvery, 20);
});

test("notify-method は popup と notification を解釈する", () => {
  assert.equal(parseArgs(["--notify-method", "popup"]).options.notifyMethod, "popup");
  assert.equal(parseArgs(["--notify-method", "notification"]).options.notifyMethod, "notification");
});

test("notify-api-error は指定時だけ有効になる", () => {
  assert.equal(parseArgs([]).options.notifyApiError, false);
  assert.equal(parseArgs(["--notify-api-error"]).options.notifyApiError, true);
});

test("notify-method の不正値にはMac 通知センター方式を案内する", () => {
  assert.throws(
    () => parseArgs(["--notify-method", "banner"]),
    /notification（Mac 通知センター）/,
  );
});

for (const args of [
  ["--timeout", "0"],
  ["--timeout", "1.5"],
  ["--notify-below", "-1"],
  ["--notify-below", "101"],
  ["--notify-below", "1.5"],
  ["--notify-every", "0"],
  ["--notify-every", "100"],
  ["--notify-every", "1.5"],
  ["--notify-every", "abc"],
  ["--notify-every"],
  ["--unknown"],
  ["--interval"],
  ["--timeout", "--json"],
  ["--codex-bin"],
  ["--filter"],
  ["--notify-exclude"],
  ["--notify-method"],
  ["--notify-method", "banner"],
]) {
  test(`不正な引数 ${args.join(" ")} を使用法エラーにする`, () => {
    assert.throws(() => parseArgs(args), (error) => error instanceof CliUsageError && error.exitCode === 2);
  });
}

test("help と version は即時結果を返す", () => {
  assert.deepEqual(parseArgs(["--help"]), { kind: "help" });
  assert.deepEqual(parseArgs(["--version"]), { kind: "version" });
  assert.match(helpText(), /既定: 180、60以上の整数/);
  assert.match(helpText(), /--notify-below <percent>\s+残量が指定値以下なら通知する（0〜100）/);
  assert.match(helpText(), /--notify-every <percent>\s+指定した割合（%）ごとに通知する（1〜99）/);
  assert.match(helpText(), /--notify-api-error\s+利用量 API の取得エラーを通知する/);
  assert.match(
    helpText(),
    /--notify-method <method>\s+通知方式: popup（ポップアップ）または notification（Mac 通知センター）（既定: popup）/,
  );
});
