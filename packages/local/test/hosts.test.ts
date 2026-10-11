import assert from "node:assert/strict";
import { test } from "node:test";
import { APEX_HOST, childLauncherLabel, parseLauncherHosts } from "../src/sites.ts";

test("only a single child label under wainwright.fun is a launcher hostname", () => {
  assert.equal(APEX_HOST, "wainwright.fun");
  assert.equal(childLauncherLabel("hannah.wainwright.fun"), "hannah");
  assert.equal(childLauncherLabel("ZOE.wainwright.fun"), "zoe");
  assert.equal(childLauncherLabel("wainwright.fun"), null);
  assert.equal(childLauncherLabel("www.wainwright.fun"), null);
  assert.equal(childLauncherLabel("admin.wainwright.fun"), null);
  assert.equal(childLauncherLabel("api.wainwright.fun"), null);
  assert.equal(childLauncherLabel("tickets.wainwright.fun"), null);
  assert.equal(childLauncherLabel("twin.wainwright.fun"), null);
  assert.equal(childLauncherLabel("chores.wainwright.fun"), null);
  assert.equal(childLauncherLabel("snacks.wainwright.fun"), null);
  assert.equal(childLauncherLabel("bible.wainwright.fun"), null);
  assert.equal(childLauncherLabel("admin.snacks.wainwright.fun"), null);
  assert.equal(childLauncherLabel("hannah.wainwright.fun:443"), "hannah");
});

test("KIDS_LAUNCHER_HOSTS is a comma-separated host list", () => {
  assert.deepEqual([...parseLauncherHosts(" Preview.Example:443 , ,hannah.wainwright.fun. ")], ["preview.example", "hannah.wainwright.fun"]);
  assert.equal(parseLauncherHosts(undefined).size, 0);
});
