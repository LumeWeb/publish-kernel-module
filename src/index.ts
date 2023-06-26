#! /usr/bin/env node

import prompts from "prompts";
import * as process from "process";
import fs from "fs/promises";
import path from "path";
import {
  hexToBytes,
  maybeInitDefaultPortals,
  setActivePortalMasterKey,
  uploadObject,
} from "@lumeweb/libweb";
import chalk from "chalk";
import * as util from "util";
import { fileExists } from "#utils.js";

let key = process.env.PORTAL_PRIVATE_KEY;

if (!key) {
  // @ts-ignore
  key = await prompts.prompts.password({
    name: "private_key",
    message: "Enter your private key",
    validate: (prev) => prev && prev.length === 64,
  });
}

let file = process.env.MODULE_FILE;

if (!file || !(await fileExists(file))) {
  const cwd = process.cwd();

  const locations = [
    "dist/module.js",
    "dist/index.js",
    "lib/module.js",
    "lib/index.js",
  ];

  const promises = locations.map((item) => {
    item = path.join(cwd, item);
    return [item, fileExists(item)];
  });

  const pResults: boolean[] = await Promise.all(
    promises.map((item) => item[1] as Promise<boolean>),
  );
  const results = pResults.reduce((prev, cur, index) => {
    if (cur) {
      prev.push(locations[index]);
    }

    return prev;
  }, [] as any);

  if (!results.length) {
    console.error("Kernel module could not be found");
    process.exit(1);
  }

  file = results[0];
}

setActivePortalMasterKey(hexToBytes(key as string));
maybeInitDefaultPortals();

const fd = await fs.open(file as string);

const [cid, err] = await uploadObject(
  fd.createReadStream(),
  BigInt((await fd.stat()).size),
);

if (err) {
  console.error("Failed to publish: ", err);
}

console.log(
  util.format(
    "%s: %s",
    chalk.green("Kernel module successfully published"),
    cid,
  ),
);
