import assert from "node:assert/strict";
import test from "node:test";
import { ThresholdNotifier } from "../dist/notifier.mjs";

function makeLimit({
  limitId = "codex",
  limitName = null,
  window = "primary",
  remainingPercent = 90,
  resetsAtEpochSeconds = 1_800_000_000,
} = {}) {
  return {
    limitId,
    limitName,
    window,
    windowDurationMins: 300,
    usedPercent: 100 - remainingPercent,
    remainingPercent,
    resetsAtEpochSeconds,
    resetsAt: resetsAtEpochSeconds === null ? null : new Date(resetsAtEpochSeconds * 1_000).toISOString(),
  };
}

function makeSnapshotAt(observedAtEpochSeconds, ...limits) {
  return {
    schemaVersion: 1,
    observedAt: new Date(observedAtEpochSeconds * 1_000).toISOString(),
    limits,
  };
}

function makeSnapshot(...limits) {
  return makeSnapshotAt(1_799_999_000, ...limits);
}

function recordingExecutor({ failure } = {}) {
  const calls = [];
  return {
    calls,
    execute: async (file, args) => {
      calls.push({ file, args });
      if (failure !== undefined) throw failure;
    },
  };
}

test("閾値未指定ならexecutorも警告も呼ばない", async () => {
  const warnings = [];
  const recorder = recordingExecutor();
  const notifier = new ThresholdNotifier(undefined, (message) => warnings.push(message), recorder.execute);
  await notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 0 })));
  assert.deepEqual(recorder.calls, []);
  assert.deepEqual(warnings, []);
});

test("初回観測が閾値以下なら1回通知し、同じbelow状態では重複通知しない", async () => {
  const recorder = recordingExecutor();
  const notifier = new ThresholdNotifier(20, () => {}, recorder.execute);
  const below = makeSnapshot(makeLimit({ remainingPercent: 20 }));

  await notifier.observe(below);
  await notifier.observe(below);

  assert.equal(recorder.calls.length, 1);
});

test("aboveからbelowへ閾値を跨いだときだけ通知する", async () => {
  const recorder = recordingExecutor();
  const notifier = new ThresholdNotifier(20, () => {}, recorder.execute);

  await notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 21 })));
  assert.equal(recorder.calls.length, 0);
  await notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 19 })));
  assert.equal(recorder.calls.length, 1);
});

test("回復後に再びbelowになれば再通知する", async () => {
  const recorder = recordingExecutor();
  const notifier = new ThresholdNotifier(20, () => {}, recorder.execute);

  await notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 10 })));
  await notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 80 })));
  await notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 15 })));

  assert.equal(recorder.calls.length, 2);
});

test("belowのままresetsAtだけが変わっても再通知しない", async () => {
  const recorder = recordingExecutor();
  const notifier = new ThresholdNotifier(20, () => {}, recorder.execute);

  await notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 10, resetsAtEpochSeconds: 1_800_000_000 })));
  await notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 10, resetsAtEpochSeconds: 1_800_003_600 })));

  assert.equal(recorder.calls.length, 1);
});

test("リセット日時を過ぎて残量が回復したら通知する", async () => {
  const recorder = recordingExecutor();
  const notifier = new ThresholdNotifier(20, () => {}, recorder.execute);

  await notifier.observe(
    makeSnapshotAt(1_799_999_000, makeLimit({ remainingPercent: 10, resetsAtEpochSeconds: 1_800_000_000 })),
  );
  await notifier.observe(
    makeSnapshotAt(1_800_000_001, makeLimit({ remainingPercent: 100, resetsAtEpochSeconds: 1_800_018_000 })),
  );

  assert.equal(recorder.calls.length, 2);
  assert.equal(recorder.calls[1].args[2], "codex / primary: 残量 100%（リセットにより回復）");
});

test("リセット日時より前の残量回復では通知しない", async () => {
  const recorder = recordingExecutor();
  const notifier = new ThresholdNotifier(20, () => {}, recorder.execute);

  await notifier.observe(
    makeSnapshotAt(1_799_999_000, makeLimit({ remainingPercent: 30, resetsAtEpochSeconds: 1_800_000_000 })),
  );
  await notifier.observe(
    makeSnapshotAt(1_799_999_500, makeLimit({ remainingPercent: 80, resetsAtEpochSeconds: 1_800_000_000 })),
  );

  assert.equal(recorder.calls.length, 0);
});

test("リセット日時通過後に遅れて残量が回復しても1回だけ通知する", async () => {
  const recorder = recordingExecutor();
  const notifier = new ThresholdNotifier(undefined, () => {}, recorder.execute, "popup", 20);

  await notifier.observe(
    makeSnapshotAt(1_799_999_000, makeLimit({ remainingPercent: 30, resetsAtEpochSeconds: 1_800_000_000 })),
  );
  await notifier.observe(
    makeSnapshotAt(1_800_000_001, makeLimit({ remainingPercent: 30, resetsAtEpochSeconds: 1_800_018_000 })),
  );
  await notifier.observe(
    makeSnapshotAt(1_800_000_002, makeLimit({ remainingPercent: 100, resetsAtEpochSeconds: 1_800_018_000 })),
  );
  await notifier.observe(
    makeSnapshotAt(1_800_000_003, makeLimit({ remainingPercent: 100, resetsAtEpochSeconds: 1_800_018_000 })),
  );

  assert.deepEqual(
    recorder.calls.map(({ args }) => args[2]),
    ["codex / primary: 残量 100%（リセットにより回復）"],
  );
});

test("刻み通知の初回観測では到達済み段階を通知せず、次の未到達段階への下降で通知する", async () => {
  const recorder = recordingExecutor();
  const notifier = new ThresholdNotifier(undefined, () => {}, recorder.execute, "popup", 20);

  await notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 30 })));
  assert.equal(recorder.calls.length, 0);

  await notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 19 })));

  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].args[2], "codex / primary: 残量 19%（20% 毎の通知）");
});

test("刻み通知は下降時の最低到達段階だけを通知し、回復後の再下降で再通知する", async () => {
  const recorder = recordingExecutor();
  const notifier = new ThresholdNotifier(undefined, () => {}, recorder.execute, "popup", 20);

  await notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 85 })));
  await notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 79 })));
  await notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 65 })));
  await notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 35 })));
  await notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 35 })));
  await notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 65 })));
  await notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 35 })));

  assert.deepEqual(
    recorder.calls.map(({ args }) => args[2]),
    [
      "codex / primary: 残量 79%（20% 毎の通知）",
      "codex / primary: 残量 35%（20% 毎の通知）",
      "codex / primary: 残量 35%（20% 毎の通知）",
    ],
  );
});

test("刻み通知はresetsAtが変動しても新しく到達した段階だけを通知する", async () => {
  const recorder = recordingExecutor();
  const notifier = new ThresholdNotifier(undefined, () => {}, recorder.execute, "popup", 10);

  await notifier.observe(
    makeSnapshot(makeLimit({ remainingPercent: 31, resetsAtEpochSeconds: 1_800_000_000 })),
  );
  await notifier.observe(
    makeSnapshot(makeLimit({ remainingPercent: 28, resetsAtEpochSeconds: 1_800_000_001 })),
  );
  await notifier.observe(
    makeSnapshot(makeLimit({ remainingPercent: 27, resetsAtEpochSeconds: 1_800_000_002 })),
  );

  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].args[2], "codex / primary: 残量 28%（10% 毎の通知）");
});

test("固定閾値と刻み通知の併用時も初回の固定閾値通知を維持する", async () => {
  const recorder = recordingExecutor();
  const notifier = new ThresholdNotifier(50, () => {}, recorder.execute, "popup", 20);

  await notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 49 })));
  assert.equal(recorder.calls.length, 1);
  assert.match(recorder.calls[0].args[2], /通知閾値 50% 以下/);

  await notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 39 })));

  assert.equal(recorder.calls.length, 2);
  assert.match(recorder.calls[1].args[2], /20% 毎の通知/);
});

test("固定閾値と刻み通知で同じ段階が重複しても1回だけ通知する", async () => {
  const recorder = recordingExecutor();
  const notifier = new ThresholdNotifier(40, () => {}, recorder.execute, "popup", 20);

  await notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 45 })));
  await notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 39 })));

  assert.equal(recorder.calls.length, 1);
  assert.match(recorder.calls[0].args[2], /40% 以下/);
});

test("閉じるまで残るAppleScriptダイアログへ通知値をargvで渡す", async () => {
  const recorder = recordingExecutor();
  const notifier = new ThresholdNotifier(13, () => {}, recorder.execute);
  await notifier.observe(
    makeSnapshot(makeLimit({ limitId: "codex", limitName: "Named Codex", remainingPercent: 12 })),
  );

  assert.equal(recorder.calls.length, 1);
  const [{ file, args }] = recorder.calls;
  assert.equal(file, "/usr/bin/osascript");
  assert.equal(args[0], "-e");
  assert.match(args[1], /on run argv/);
  assert.match(args[1], /display dialog \(item 1 of argv\) with title \(item 2 of argv\)/);
  assert.doesNotMatch(args[1], /display notification/);
  assert.match(args[1], /buttons \{"閉じる"\} default button "閉じる"/);
  assert.doesNotMatch(args[1], /giving up after/);
  assert.equal(args[1].includes("Named Codex"), false);
  assert.equal(args[1].includes("12%"), false);
  assert.equal(args[1].includes("13%"), false);
  assert.equal(args[1].includes("Codex 利用制限"), false);
  assert.equal(args[2], "Named Codex / primary: 残量 12%（通知閾値 13% 以下）");
  assert.equal(args[3], "Codex 利用制限");
  assert.equal(args.length, 4);
});

test("通知センター用AppleScriptへ通知値をargvで渡す", async () => {
  const recorder = recordingExecutor();
  const notifier = new ThresholdNotifier(13, () => {}, recorder.execute, "notification");
  await notifier.observe(
    makeSnapshot(makeLimit({ limitId: "codex", limitName: "Named Codex", remainingPercent: 12 })),
  );

  assert.equal(recorder.calls.length, 1);
  const [{ file, args }] = recorder.calls;
  assert.equal(file, "/usr/bin/osascript");
  assert.equal(args[0], "-e");
  assert.match(args[1], /on run argv/);
  assert.match(args[1], /display notification \(item 1 of argv\) with title \(item 2 of argv\)/);
  assert.doesNotMatch(args[1], /display dialog/);
  assert.equal(args[1].includes("Named Codex"), false);
  assert.equal(args[1].includes("12%"), false);
  assert.equal(args[1].includes("13%"), false);
  assert.equal(args[1].includes("Codex 利用制限"), false);
  assert.equal(args[2], "Named Codex / primary: 残量 12%（通知閾値 13% 以下）");
  assert.equal(args[3], "Codex 利用制限");
  assert.equal(args.length, 4);
});

test("Claude 用タイトルを指定しても Codex の既定タイトルは変わらない", async () => {
  const recorder = recordingExecutor();
  const notifier = new ThresholdNotifier(20, () => {}, recorder.execute, "popup", undefined, "Claude 利用制限");
  await notifier.observe(makeSnapshot(makeLimit({ limitId: "claude", window: "five_hour", remainingPercent: 10 })));
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].args[3], "Claude 利用制限");
});

test("executor失敗は一度だけ警告し、残りのwindow観測を継続する", async () => {
  const warnings = [];
  const recorder = recordingExecutor({ failure: new Error("synthetic executor failure") });
  const notifier = new ThresholdNotifier(20, (message) => warnings.push(message), recorder.execute);
  const snapshot = makeSnapshot(
    makeLimit({ limitId: "codex", window: "primary", remainingPercent: 10 }),
    makeLimit({ limitId: "codex", window: "secondary", remainingPercent: 5 }),
  );

  await assert.doesNotReject(notifier.observe(snapshot));
  assert.equal(recorder.calls.length, 2);
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /^macOS ポップアップを表示できませんでした。監視は継続します: synthetic executor failure$/,
  );

  await assert.doesNotReject(
    notifier.observe(
      makeSnapshot(makeLimit({ limitId: "review", window: "primary", remainingPercent: 1 })),
    ),
  );
  assert.equal(recorder.calls.length, 3);
  assert.equal(warnings.length, 1);
});

test("notificationのexecutor失敗はMac 通知センター方式の警告にする", async () => {
  const warnings = [];
  const recorder = recordingExecutor({ failure: new Error("synthetic executor failure") });
  const notifier = new ThresholdNotifier(
    20,
    (message) => warnings.push(message),
    recorder.execute,
    "notification",
  );

  await assert.doesNotReject(
    notifier.observe(makeSnapshot(makeLimit({ remainingPercent: 10 }))),
  );
  assert.deepEqual(warnings, [
    "Mac 通知センター通知を表示できませんでした。監視は継続します: synthetic executor failure",
  ]);
});

test("notifyExclude に部分一致する制限は通知せず、他の制限は通知する", async () => {
  const recorder = recordingExecutor();
  const notifier = new ThresholdNotifier(20, () => {}, recorder.execute, "popup", undefined, "Claude 利用制限", ["CLAUDE / five_hour"]);

  await notifier.observe(makeSnapshot(
    makeLimit({ limitId: "claude", limitName: "Claude", window: "five_hour", remainingPercent: 10 }),
    makeLimit({ limitId: "claude", limitName: "Claude", window: "seven_day", remainingPercent: 10 }),
    makeLimit({ limitId: "claude-fable", limitName: "Claude Fable", window: "five_hour", remainingPercent: 10 }),
  ));

  assert.equal(recorder.calls.length, 2);
  assert.match(recorder.calls[0].args[2], /^Claude \/ seven_day:/);
  assert.match(recorder.calls[1].args[2], /^Claude Fable \/ five_hour:/);
});

test("API エラーは連続失敗中に1回通知し、成功後の再失敗で再通知する", async () => {
  const recorder = recordingExecutor();
  const notifier = new ThresholdNotifier(undefined, () => {}, recorder.execute, "notification", undefined, "Claude 利用制限");

  await notifier.notifyApiError(new Error("接続失敗"));
  await notifier.notifyApiError(new Error("再度失敗"));
  assert.equal(recorder.calls.length, 1);
  assert.match(recorder.calls[0].args[1], /display notification/);
  assert.equal(recorder.calls[0].args[2], "利用量 API の取得に失敗しました: 接続失敗");
  assert.equal(recorder.calls[0].args[3], "Claude 利用制限");

  notifier.clearApiError();
  await notifier.notifyApiError(new Error("再度失敗"));
  assert.equal(recorder.calls.length, 2);
  assert.match(recorder.calls[1].args[2], /再度失敗/);
});

test("API エラー通知の起動失敗は警告し、連続失敗中は再試行しない", async () => {
  const warnings = [];
  const recorder = recordingExecutor({ failure: new Error("通知失敗") });
  const notifier = new ThresholdNotifier(undefined, (message) => warnings.push(message), recorder.execute);

  await notifier.notifyApiError(new Error("取得失敗"));
  await notifier.notifyApiError(new Error("取得失敗"));
  assert.equal(recorder.calls.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /macOS ポップアップを表示できませんでした/);
});
