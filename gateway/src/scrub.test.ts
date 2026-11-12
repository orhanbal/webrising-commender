import test from "node:test";
import assert from "node:assert/strict";
import { scrubUserPaths } from "./scrub.js";

test("error reports keep paths but not the user's folder name", () => {
  assert.equal(scrubUserPaths("at C:\\Users\\orhan\\AppData\\Local\\WECOMMANDER\\errors.log"),
    "at C:\\Users\\…\\AppData\\Local\\WECOMMANDER\\errors.log");
  assert.equal(scrubUserPaths("/Users/orhan/Library/x and /home/venture/.ssh/id"), "/Users/…/Library/x and /home/…/.ssh/id");
  assert.equal(scrubUserPaths("D:\\a\\webrising-commender\\Core\\TeamSync.cs:line 35"), "D:\\a\\webrising-commender\\Core\\TeamSync.cs:line 35");
});
