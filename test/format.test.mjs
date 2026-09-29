import assert from "node:assert/strict";
import test from "node:test";
import { displayWidth } from "../dist/align-columns.mjs";
import { formatJson, formatSnapshot } from "../dist/codex-format.mjs";

function snapshotWithDurations(durations) {
  return {
    schemaVersion: 1,
    observedAt: "2026-08-30T00:00:00.000Z",
    limits: durations.map((windowDurationMins, index) => ({
      limitId: `id-${index}`,
      limitName: index === 0 ? "Named limit" : null,
      window: index % 2 === 0 ? "primary" : "secondary",
      windowDurationMins,
      usedPercent: 23.5,
      remainingPercent: 76.5,
      resetsAtEpochSeconds: index === 0 ? 1_788_050_000 : null,
      resetsAt: index === 0 ? "2026-08-30T09:53:20.000Z" : null,
    })),
  };
}

test("5時間、週次、任意の分・時間・日を表示する", () => {
  // 桁合わせの空白は1つに詰めて比較する
  const output = formatSnapshot(snapshotWithDurations([300, 10_080, 45, 120, 2_880, null])).replace(/ +/g, " ");
  assert.match(output, /Named limit \/ primary \/ 5時間/);
  assert.match(output, /id-1 \/ secondary \/ 7日（週次）/);
  assert.match(output, /id-2 \/ primary \/ 45分/);
  assert.match(output, /id-3 \/ secondary \/ 2時間/);
  assert.match(output, /id-4 \/ primary \/ 2日/);
  assert.match(output, /id-5 \/ secondary \/ 不明/);
});

test("human表示に取得日時、label、window、残量、ローカルresetを含める", () => {
  const output = formatSnapshot(snapshotWithDurations([300]));
  const lines = output.split("\n");
  assert.match(lines[0], /^取得日時: \d{4}-\d{2}-\d{2} \d{1,2}:\d{2}:\d{2}$/);
  assert.match(lines[1], /^Named limit \/ primary/);
  assert.match(lines[1], /リセット \d{4}-\d{2}-\d{2} /);
  assert.doesNotMatch(output, /通知設定:/);
  assert.match(output, /Named limit \/ primary/);
  assert.match(output, /残量 76\.5% \/ リセット/);
  assert.doesNotMatch(output, /使用/);
  assert.match(output, /リセット (?!不明)/);
});

test("human表示は各行の区切りを表示幅でそろえ、残量を小数1桁で表す", () => {
  const snapshot = snapshotWithDurations([300, 10_080, 45]);
  snapshot.limits[1].remainingPercent = 100;
  snapshot.limits[2].remainingPercent = 5;
  const lines = formatSnapshot(snapshot).split("\n").slice(1);

  assert.match(lines[0], /残量 76\.5%  \/ リセット/);
  assert.match(lines[1], /残量 100\.0% \/ リセット/);
  assert.match(lines[2], /残量 5\.0%   \/ リセット/);
  // 全角を含む行でも、各区切りの表示位置が全行で一致する
  for (const separator of [" / ", " 残量 ", " / リセット"]) {
    const positions = lines.map((line) => displayWidth(line.slice(0, line.indexOf(separator))));
    assert.equal(new Set(positions).size, 1, `${separator} の位置: ${positions}`);
  }
});

test("通知閾値を指定すると取得日時行に閾値とMac 通知センター方式を含める", () => {
  const snapshot = snapshotWithDurations([300]);
  const lines = formatSnapshot(snapshot, 70, "notification").split("\n");

  assert.equal(lines.length, 2);
  assert.match(
    lines[0],
    /^取得日時: [^\n]+【通知設定: 残量 70% 以下 \/ Mac 通知センター】$/,
  );
  assert.match(lines[1], /^Named limit \/ primary \/ 5時間:/);
  assert.doesNotMatch(lines[1], /通知設定:/);
});

test("popup方式は取得日時行にポップアップと表示する", () => {
  const lines = formatSnapshot(snapshotWithDurations([300]), 20).split("\n");

  assert.match(
    lines[0],
    /^取得日時: [^\n]+【通知設定: 残量 20% 以下 \/ ポップアップ】$/,
  );
  assert.equal(lines.filter((line) => line.includes("通知設定:")).length, 1);
});

test("API エラー通知だけを指定しても取得日時行に設定を表示する", () => {
  const line = formatSnapshot(snapshotWithDurations([300]), undefined, "notification", undefined, [], true).split("\n")[0];
  assert.match(line, /^取得日時: [^\n]+【通知設定: API 取得エラー \/ Mac 通知センター】$/);
});

test("刻み通知を指定すると取得日時行に通知間隔と通知方法を含める", () => {
  const lines = formatSnapshot(snapshotWithDurations([300]), undefined, "notification", 20).split("\n");

  assert.match(
    lines[0],
    /^取得日時: [^\n]+【通知設定: 残量 20% 毎 \/ Mac 通知センター】$/,
  );
  assert.equal(lines.filter((line) => line.includes("通知設定:")).length, 1);
});

test("固定閾値と刻み通知を併用すると両方の設定を取得日時行に含める", () => {
  const lines = formatSnapshot(snapshotWithDurations([300]), 30, "popup", 20).split("\n");

  assert.match(
    lines[0],
    /^取得日時: [^\n]+【通知設定: 残量 30% 以下 \+ 20% 毎 \/ ポップアップ】$/,
  );
  assert.equal(lines.filter((line) => line.includes("通知設定:")).length, 1);
});

test("制限がない場合は明示する", () => {
  const snapshot = snapshotWithDurations([]);
  assert.match(formatSnapshot(snapshot), /表示可能な利用制限は返されませんでした/);
});

test("JSON出力はsnapshotを1行でそのまま表現する", () => {
  const snapshot = snapshotWithDurations([300]);
  const output = formatJson(snapshot);
  assert.equal(output.includes("\n"), false);
  assert.deepEqual(JSON.parse(output), snapshot);
});

test("resetCredits があれば利用可能なクレジットを期限順に1行で表示する", () => {
  const snapshot = snapshotWithDurations([300]);
  snapshot.resetCredits = {
    availableCount: 2,
    credits: [
      { title: null, resetType: "codexRateLimits", status: "available", grantedAt: null, expiresAt: "2026-10-23T12:00:00.000Z" },
      { title: "Used", resetType: "codexRateLimits", status: "used", grantedAt: null, expiresAt: "2026-10-01T00:00:00.000Z" },
      { title: "Full reset", resetType: "codexRateLimits", status: "available", grantedAt: null, expiresAt: "2026-10-22T12:00:00.000Z" },
    ],
  };
  const lines = formatSnapshot(snapshot).split("\n");

  assert.equal(lines.length, 3);
  assert.match(
    lines[2],
    /^リセットクレジット: 利用可能 2件（Full reset \/ 期限 2026-10-22 [^、]+、codexRateLimits \/ 期限 2026-10-23 [^）]+）$/,
  );
});

test("利用可能なクレジットがなければ件数だけ表示し、resetCredits がなければ行を出さない", () => {
  const snapshot = snapshotWithDurations([300]);
  assert.doesNotMatch(formatSnapshot(snapshot), /リセットクレジット/);

  snapshot.resetCredits = { availableCount: 0, credits: [] };
  assert.equal(formatSnapshot(snapshot).split("\n")[2], "リセットクレジット: 利用可能 0件");

  snapshot.limits = [];
  assert.deepEqual(formatSnapshot(snapshot).split("\n").slice(1), [
    "表示可能な利用制限は返されませんでした。",
    "リセットクレジット: 利用可能 0件",
  ]);
});
