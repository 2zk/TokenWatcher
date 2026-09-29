import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readRateLimitsWithRetry, runCli } from "../dist/codex-cli.mjs";
import { createFakeCodex, readCapturedEvents, waitUntil } from "./helpers/fake-codex.mjs";

const cliPath = fileURLToPath(new URL("../dist/codex-cli.mjs", import.meta.url));

function spawnCli(args) {
  const child = spawn(process.execPath, [cliPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, completed, stdout: () => stdout, stderr: () => stderr };
}

async function captureOutputAsync(callback) {
  const stdout = [];
  const stderr = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    const code = await callback();
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

test("Codex の再試行中に取得できれば API エラー通知しない", async () => {
  const calls = [];
  let attempts = 0;
  const server = {
    async start() {},
    async readRateLimits() {
      attempts += 1;
      if (attempts < 4) throw new Error("一時失敗");
      return { rateLimitsByLimitId: {} };
    },
    async stop() {},
  };
  const result = await captureOutputAsync(() => runCli(["--notify-api-error"], {
    server,
    notificationExecutor: async (...args) => { calls.push(args); },
    readDependencies: { waitForRetry: async () => {}, reportRetry: () => {} },
  }));
  assert.equal(result.code, 0);
  assert.equal(attempts, 4);
  assert.deepEqual(calls, []);
  assert.match(result.stdout, /通知設定: API 取得エラー \/ ポップアップ/);
});

test("Codex の再試行を使い切ると API エラーを1回通知する", async () => {
  const calls = [];
  let attempts = 0;
  const server = {
    async start() {},
    async readRateLimits() { attempts += 1; throw new Error("取得失敗"); },
    async stop() {},
  };
  const result = await captureOutputAsync(() => runCli(["--notify-api-error", "--notify-method", "notification", "--json"], {
    server,
    notificationExecutor: async (...args) => { calls.push(args); },
    readDependencies: { waitForRetry: async () => {}, reportRetry: () => {} },
  }));
  assert.equal(result.code, 1);
  assert.equal(attempts, 4);
  assert.equal(calls.length, 1);
  assert.match(calls[0][1][1], /display notification/);
  assert.match(calls[0][1][2], /取得失敗/);
  assert.match(result.stderr, /通知設定: API 取得エラー \/ Mac 通知センター/);
  assert.equal(result.stdout, "");
});

test("Codex app-server の起動失敗を通知する", async () => {
  const calls = [];
  const server = {
    async start() { throw new Error("起動失敗"); },
    async stop() {},
  };
  const result = await captureOutputAsync(() => runCli(["--notify-api-error"], {
    server,
    notificationExecutor: async (...args) => { calls.push(args); },
  }));
  assert.equal(result.code, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0][1][1], /display dialog/);
  assert.match(calls[0][1][2], /起動失敗/);
});

test("利用量取得は10/20/30秒後に再試行し、4回目に成功すれば結果を返す", async () => {
  const expected = { rateLimits: { codex: {} } };
  const delays = [];
  let readCount = 0;
  const server = {
    async readRateLimits() {
      readCount += 1;
      if (readCount < 4) throw new Error(`一時エラー ${readCount}`);
      return expected;
    },
  };

  const result = await readRateLimitsWithRetry(server, () => false, () => {}, {
    waitForRetry: async (delayMs) => {
      delays.push(delayMs);
    },
    reportRetry: () => {},
  });

  assert.equal(result, expected);
  assert.equal(readCount, 4);
  assert.deepEqual(delays, [10_000, 20_000, 30_000]);
});

test("利用量取得は初回と3回の再試行がすべて失敗すると最後のエラーをthrowする", async () => {
  const delays = [];
  const errors = Array.from({ length: 4 }, (_, index) => new Error(`取得失敗 ${index + 1}`));
  let readCount = 0;
  const server = {
    async readRateLimits() {
      const error = errors[readCount];
      readCount += 1;
      throw error;
    },
  };

  await assert.rejects(
    readRateLimitsWithRetry(server, () => false, () => {}, {
      waitForRetry: async (delayMs) => {
        delays.push(delayMs);
      },
      reportRetry: () => {},
    }),
    (error) => error === errors[3],
  );
  assert.equal(readCount, 4);
  assert.deepEqual(delays, [10_000, 20_000, 30_000]);
});

test("利用量取得の再試行待機は停止通知で中断し、以後readしない", async () => {
  let readCount = 0;
  let stopping = false;
  let wake;
  const server = {
    async readRateLimits() {
      readCount += 1;
      throw new Error("取得失敗");
    },
  };

  const pending = readRateLimitsWithRetry(server, () => stopping, (nextWake) => {
    wake = nextWake;
  }, {
    reportRetry: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof wake, "function");

  stopping = true;
  wake();
  const result = await pending;

  assert.equal(result, undefined);
  assert.equal(readCount, 1);
  assert.equal(wake, undefined);
});

test("one-shot JSONはstdoutにJSON一行だけを出し、診断を混ぜない", async (t) => {
  const fake = await createFakeCodex(t, "normal");
  const run = spawnCli(["--json", "--codex-bin", fake.executablePath]);
  const result = await run.completed;
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.limits[0].limitId, "codex");
});

test("人向け出力は通知閾値の指定時だけ取得日時行に設定を含める", async (t) => {
  const withNotificationFake = await createFakeCodex(t, "normal");
  const withNotification = spawnCli([
    "--notify-below",
    "20",
    "--notify-method",
    "notification",
    "--codex-bin",
    withNotificationFake.executablePath,
  ]);
  const withNotificationResult = await withNotification.completed;

  assert.equal(withNotificationResult.code, 0);
  assert.equal(withNotificationResult.stderr, "");
  const withNotificationLines = withNotificationResult.stdout.trimEnd().split("\n");
  assert.match(
    withNotificationLines[0],
    /^取得日時: [^\n]+【通知設定: 残量 20% 以下 \/ Mac 通知センター】$/,
  );
  assert.doesNotMatch(withNotificationLines.slice(1).join("\n"), /通知設定:/);

  const withoutNotificationFake = await createFakeCodex(t, "normal");
  const withoutNotification = spawnCli(["--codex-bin", withoutNotificationFake.executablePath]);
  const withoutNotificationResult = await withoutNotification.completed;

  assert.equal(withoutNotificationResult.code, 0);
  assert.equal(withoutNotificationResult.stderr, "");
  assert.match(withoutNotificationResult.stdout.split("\n")[0], /^取得日時: [^\n]+$/);
  assert.doesNotMatch(withoutNotificationResult.stdout, /通知設定:/);
});

test("人向け出力は刻み通知の設定を取得日時行に含める", async (t) => {
  const fake = await createFakeCodex(t, "normal");
  const run = spawnCli([
    "--notify-every",
    "20",
    "--notify-method",
    "notification",
    "--codex-bin",
    fake.executablePath,
  ]);
  const result = await run.completed;

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const lines = result.stdout.trimEnd().split("\n");
  assert.match(
    lines[0],
    /^取得日時: [^\n]+【通知設定: 残量 20% 毎 \/ Mac 通知センター】$/,
  );
  assert.doesNotMatch(lines.slice(1).join("\n"), /通知設定:/);
});

test("one-shot JSONは併用した通知設定をstderrへ1回だけ出し、stdoutのスキーマを変えない", async (t) => {
  const fake = await createFakeCodex(t, "normal");
  const run = spawnCli([
    "--json",
    "--notify-below",
    "30",
    "--notify-every",
    "20",
    "--notify-method",
    "notification",
    "--codex-bin",
    fake.executablePath,
  ]);
  const result = await run.completed;

  assert.equal(result.code, 0);
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(parsed).sort(), ["limits", "observedAt", "schemaVersion"]);
  assert.equal("notifyBelow" in parsed, false);
  assert.equal("notifyEvery" in parsed, false);
  assert.equal("notifyMethod" in parsed, false);
  assert.deepEqual(result.stderr.trimEnd().split("\n"), [
    "通知設定: 残量 30% 以下 + 20% 毎 / Mac 通知センター",
  ]);
});

test("filterは大文字・小文字を区別せず、JSONに一致するlimitだけを出す", async (t) => {
  const fake = await createFakeCodex(t, "filter-multiple");
  const run = spawnCli(["--json", "--filter", "fAkE cOdEx / PrImArY", "--codex-bin", fake.executablePath]);
  const result = await run.completed;

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.limits.length, 1);
  assert.equal(parsed.limits[0].limitId, "codex");
  assert.equal(parsed.limits[0].limitName, "Fake Codex");
  assert.equal(parsed.limits[0].window, "primary");
});

test("update burstをdebounceし、pollを重複させず、SIGINTでchild stdinを閉じて130終了する", async (t) => {
  const fake = await createFakeCodex(t, "updated-burst");
  const run = spawnCli([
    "--watch",
    "--json",
    "--interval",
    "60",
    "--notify-below",
    "20",
    "--notify-every",
    "20",
    "--codex-bin",
    fake.executablePath,
  ]);

  await waitUntil(() => {
    const lines = run.stdout().trim().split("\n").filter(Boolean);
    return lines.length >= 2;
  }, 4_000);
  run.child.kill("SIGINT");
  const result = await run.completed;

  assert.equal(result.code, 130);
  const outputLines = result.stdout.trim().split("\n").filter(Boolean);
  assert.equal(outputLines.length, 2);
  for (const line of outputLines) {
    const parsed = JSON.parse(line);
    assert.equal(parsed.schemaVersion, 1);
    assert.deepEqual(Object.keys(parsed).sort(), ["limits", "observedAt", "schemaVersion"]);
    assert.equal("notifyBelow" in parsed, false);
    assert.equal("notifyEvery" in parsed, false);
    assert.equal("notifyMethod" in parsed, false);
  }
  assert.equal(result.stderr.match(/通知設定:/g)?.length, 1);
  assert.match(
    result.stderr,
    /通知設定: 残量 20% 以下 \+ 20% 毎 \/ ポップアップ/,
  );
  assert.match(result.stderr, /SIGINT を受信したため終了処理を開始します/);

  const events = await waitUntil(async () => {
    const current = await readCapturedEvents(fake.capturePath);
    return current.some((event) => event.type === "stdin-ended") ? current : undefined;
  });
  const readEvents = events.filter((event) => event.type === "read-start" || event.type === "read-end");
  assert.deepEqual(readEvents.map((event) => event.type), ["read-start", "read-end", "read-start", "read-end"]);
  assert.equal(readEvents.some((event) => event.activeReads > 1), false);
});

test("停止処理中の2回目のSIGINTでforceStopし、130終了後にapp-serverを残さない", async (t) => {
  const fake = await createFakeCodex(t, "slow-stop");
  const run = spawnCli(["--watch", "--json", "--interval", "60", "--codex-bin", fake.executablePath]);
  t.after(() => {
    if (run.child.exitCode === null) run.child.kill("SIGKILL");
  });

  await waitUntil(() => run.stdout().trim().split("\n").filter(Boolean).length >= 1);
  assert.equal(run.child.kill("SIGINT"), true);

  const stoppingEvents = await waitUntil(async () => {
    const current = await readCapturedEvents(fake.capturePath);
    return current.some((event) => event.type === "stdin-ended") ? current : undefined;
  });
  const fakePid = stoppingEvents.find((event) => event.type === "started").pid;
  assert.equal(run.child.kill("SIGINT"), true);

  const finalEvents = await waitUntil(async () => {
    const current = await readCapturedEvents(fake.capturePath);
    return current.some((event) => event.type === "sigterm") ? current : undefined;
  }, 750);
  assert.equal(finalEvents.filter((event) => event.type === "sigterm").length, 1);

  const result = await run.completed;
  assert.equal(result.code, 130);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /SIGINT を受信したため終了処理を開始します/);
  await waitUntil(() => {
    try {
      process.kill(fakePid, 0);
      return false;
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      throw error;
    }
  });
});

test("help/versionと引数エラーのexit codeをCLI境界でも維持する", async () => {
  const help = spawnCli(["--help"]);
  const helpResult = await help.completed;
  assert.equal(helpResult.code, 0);
  assert.match(helpResult.stdout, /既定: 180、60以上の整数/);
  assert.match(helpResult.stdout, /--notify-below <percent>\s+残量が指定値以下なら通知する（0〜100）/);
  assert.match(
    helpResult.stdout,
    /--notify-every <percent>\s+指定した割合（%）ごとに通知する（1〜99）/,
  );
  assert.match(
    helpResult.stdout,
    /--notify-method <method>\s+通知方式: popup（ポップアップ）または notification（Mac 通知センター）（既定: popup）/,
  );

  const version = spawnCli(["--version"]);
  const versionResult = await version.completed;
  assert.equal(versionResult.code, 0);
  assert.match(versionResult.stdout, /^0\.1\.0\n$/);

  const invalid = spawnCli(["--interval", "59"]);
  const invalidResult = await invalid.completed;
  assert.equal(invalidResult.code, 2);
  assert.equal(invalidResult.stdout, "");
  assert.match(invalidResult.stderr, /60 以上の整数/);

  const missingFilter = spawnCli(["--filter"]);
  const missingFilterResult = await missingFilter.completed;
  assert.equal(missingFilterResult.code, 2);
  assert.equal(missingFilterResult.stdout, "");
  assert.match(missingFilterResult.stderr, /--filter には値が必要/);
});
